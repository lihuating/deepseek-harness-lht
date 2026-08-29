/**
 * One-shot iFlow CLI subagent provider. Every accepted run spawns a fresh
 * `iflow -p` process in the delegating session's workspace, passes one
 * self-contained text task, and returns the final answer text (stdout) or a
 * failure diagnostic through the shared {@link SubagentResult} contract.
 *
 * iFlow is an external CLI, not a DSH agent: the child has its own runtime,
 * session, model configuration, tools, and `~/.iflow` state, so it shares no
 * Cordis context and advertises no parent-enforced start capabilities — the
 * ONE thing it reads off `request.parent` is the session's workspace cwd.
 * This plugin uses named exports only; a default would hide its loader
 * metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-iflow
 */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_STDERR_MAX_BYTES,
  DEFAULT_STDOUT_MAX_BYTES,
  DEFAULT_STDOUT_SPILL_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  startIflowRun,
  type IflowRunSpec,
} from './run.ts'

export const name = 'subagent-iflow'
export const inject = ['subagents', 'subprocess']

/** Config: how to spawn and bound the child iFlow process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `iflow`). */
  providerName?: string
  /**
   * The executable to spawn for each run (default `iflow`; resolved through
   * PATH). An absolute path pins a specific installation.
   */
  command?: string
  /** Extra fixed arguments appended after the prompt (e.g. `-m`, `-y`). */
  args?: string[]
  /**
   * Per-run model-call bound passed as `--max-turns` (default 20). It bounds
   * iFlow's internal work; the wall-clock bound is `timeoutSeconds`.
   */
  maxTurns?: number
  /**
   * Provider-owned wall-clock bound in seconds (default 600; `0` disables it).
   * When it elapses the child is terminated and the run settles as `error`
   * with a timeout diagnostic. iFlow itself does not receive this bound.
   */
  timeoutSeconds?: number
  /**
   * Working directory override for the child process. Must be non-empty; a
   * relative path resolves against the harness launch directory at load, and
   * the result must be an existing directory. When omitted, each child
   * inherits its delegating parent session's cwd — and starting one from a
   * parent session that has no cwd fails.
   */
  cwd?: string
  /**
   * Extra environment variables for the child process. Forwarded on top of a
   * credential-scrubbed copy of the parent env, so an explicit key here
   * reaches the child while ambient secrets do not leak implicitly.
   */
  env?: Record<string, string>
  /**
   * Positive finite grace period (ms) for the subprocess seam's
   * SIGTERM→SIGKILL escalation; must not exceed `MAX_TIMER_DELAY_MS`.
   */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('iflow'),
  command: z.string().default('iflow'),
  args: z.array(z.string()).default([]),
  maxTurns: z.natural().default(DEFAULT_MAX_TURNS),
  timeoutSeconds: z.natural().default(DEFAULT_TIMEOUT_MS / 1000),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  graceMs: z.number().default(3_000),
})

/** A dispose grace or wall-clock bound must fit the single Node timer that owns it. */
function assertBoundedMs(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-iflow: ${name} must be a non-negative finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/**
 * Whether `path` names an existing directory the harness can ENTER. The
 * search-permission probe matters: `statSync().isDirectory()` is true for a
 * mode-600 directory, but a subprocess cwd needs `X_OK` or spawn fails EACCES.
 */
function isDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Assert `cwd` can actually host the child: absolute (a relative path would be
 * re-anchored to the server process's launch directory) and an existing
 * directory (fail here, before the process boundary, instead of as an
 * ambiguous spawn ENOENT).
 * @param label - which source supplied the value, for the diagnostic.
 * @param cwd - the candidate working directory.
 * @returns `cwd`, validated.
 */
function assertUsableCwd(label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`subagent-iflow: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isDirectory(cwd)) {
    throw new Error(`subagent-iflow: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/**
 * Resolve the child's working directory: the deployment `cwd` override when
 * configured (already validated at load), else the parent session's workspace
 * cwd (validated here, its earliest resolvable point). Fails loud when neither
 * exists — falling back to the harness process cwd would silently bind the
 * child to the server's launch directory instead of the delegating session's
 * workspace (one server process serves many sessions, each with its own cwd).
 */
function resolveCwd(configured: string | undefined, request: SubagentStartRequest): string {
  if (configured !== undefined) return configured
  const parentCwd = request.parent.session.header.cwd
  if (parentCwd === undefined) {
    throw new Error('subagent-iflow: no working directory for the child — configure `cwd` or delegate from a parent session that has one')
  }
  return assertUsableCwd('parent session cwd', parentCwd)
}

/**
 * The iFlow provider. Advertises NO start-time capabilities: an out-of-process
 * CLI child cannot honor `outputSchema`/`maxDepth`/`toolFilter` (the service
 * rejects a request needing any of them before `start` runs).
 */
class IflowProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  // Context contract: an out-of-process iFlow child starts fresh — no parent conversation crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  start(request: ResolvedSubagentStartRequest) {
    const spec: IflowRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd: resolveCwd(this.config.cwd, request),
      maxTurns: this.config.maxTurns,
      timeoutMs: this.config.timeoutSeconds * 1000,
      env: this.config.env,
      graceMs: this.config.graceMs,
      stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
      stdoutSpillMaxBytes: DEFAULT_STDOUT_SPILL_MAX_BYTES,
      stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting for a child-level failure, so it
        // is flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-iflow "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startIflowRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertBoundedMs('graceMs', resolved.graceMs)
  assertBoundedMs('timeoutMs', resolved.timeoutSeconds * 1000)
  // `path.resolve('')` is the process cwd — an empty string would silently
  // reintroduce the launch-directory fallback this resolution removed.
  if (resolved.cwd === '') {
    throw new Error('subagent-iflow: config cwd must not be empty — omit the key to inherit the parent session cwd')
  }
  // Interpret a relative configured cwd against the harness launch directory
  // ONCE, at load, and fail a misconfigured directory here — not per start.
  const validated: ResolvedConfig = resolved.cwd === undefined
    ? resolved
    : { ...resolved, cwd: assertUsableCwd('config cwd', resolve(resolved.cwd)) }
  ctx.subagents.registerProvider(new IflowProvider(validated.providerName, ctx, validated))
}
