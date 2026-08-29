/**
 * Fresh-process iFlow CLI subagent client. Runs one non-interactive `iflow -p`
 * invocation and owns cancellation and teardown.
 *
 * The child is a one-shot CLI call, not a protocol server: the provider spawns
 * it, waits for process exit, and maps exit facts plus the collected streams
 * onto the shared {@link SubagentResult} contract. iFlow prints its final
 * answer on stdout and its noise (progress, telemetry, network retries) on
 * stderr, so stdout text becomes the child output and stderr tail becomes the
 * failure diagnostic. A zero exit code means the conversation completed a
 * turn; a non-zero code means a CLI-level failure (no session, bad auth, …).
 * @module @deepseek-ai/dsh-subagent-iflow/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Default cap on the final-answer tail kept in memory per run. */
export const DEFAULT_STDOUT_MAX_BYTES = 1_000_000

/** Default cap on the full-answer spill file per run. */
export const DEFAULT_STDOUT_SPILL_MAX_BYTES = 8_000_000

/** Default cap on the stderr tail kept for failure diagnostics. */
export const DEFAULT_STDERR_MAX_BYTES = 16_000

/** Default per-run iFlow work bound (`--max-turns`). */
export const DEFAULT_MAX_TURNS = 20

/** Default provider-owned wall-clock bound; 0 disables it. */
export const DEFAULT_TIMEOUT_MS = 600_000

/** The subagent seam caps provider diagnostics at 4096 UTF-8 bytes. */
const DIAGNOSTIC_MAX_BYTES = 4096

/** Resolved spawn spec for an iFlow child process (no defaults — see Config). */
export interface IflowRunSpec {
  /** The executable to spawn (default `iflow`; resolved through PATH). */
  command: string
  /** Extra fixed arguments appended after the prompt (`-m`, `-y`, …). */
  args: string[]
  /**
   * Absolute working directory for the child. The provider resolves it before
   * this spec exists: config override, else the delegating parent session's
   * workspace. iFlow reads project context relative to this directory.
   */
  cwd: string
  /** Per-run model-call bound passed as `--max-turns`. */
  maxTurns: number
  /**
   * Provider-owned wall-clock bound in milliseconds (0 = unbounded). When it
   * elapses the child is terminated and the run settles as `error` with a
   * timeout diagnostic; iFlow itself does not receive this bound.
   */
  timeoutMs: number
  /**
   * Extra environment variables to ADD for the child. Merged on top of the
   * subprocess seam's scrubbed parent env, so an explicit credential here
   * survives the scrub while ambient secrets do not leak implicitly.
   */
  env: Record<string, string>
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, for the subprocess seam's SIGTERM→SIGKILL escalation.
   */
  graceMs: number
  /** In-memory cap on the retained stdout tail. */
  stdoutMaxBytes: number
  /** Full-stream spill cap for stdout; a longer answer discards its spill. */
  stdoutSpillMaxBytes: number
  /** In-memory cap on the retained stderr tail (diagnostics only). */
  stderrMaxBytes: number
  /**
   * Spawn function from the subprocess seam (`ctx.subprocess.spawn`), so the
   * child rides the shared scrub and tree-scoped teardown instead of a
   * package-local child_process path.
   */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /**
   * Sink for a child-level failure the run flattened into a stop reason (the
   * seam contract forbids `result` rejecting for a child failure; only a
   * spawn-level infrastructure fault rejects). The provider wires it to
   * `ctx.logger.warn`. A throw from the sink itself is contained.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** Normalize an unknown thrown value to an Error. */
function toError(value: unknown): Error {
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Concatenate the harness prompt blocks into the one text task. The tool layer
 * always sends text-only blocks, but a non-text block must fail loud rather
 * than be silently dropped.
 * @param prompt - the harness prompt blocks.
 * @returns the joined task text.
 */
export function toPromptText(prompt: ContentBlock[]): string {
  let text = ''
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-iflow: the one-shot task must contain only text blocks')
    }
    text += block.text
  }
  if (text.trim() === '') {
    throw new Error('subagent-iflow: the one-shot task must not be empty')
  }
  return text
}

/** Human-readable exit facts for a diagnostic. */
function exitFacts(outcome: SubprocessOutcome): string {
  return outcome.signal !== null
    ? `signal ${outcome.signal}`
    : `code ${String(outcome.exitCode)}`
}

/**
 * Truncate a diagnostic to the seam's byte cap without splitting a UTF-8
 * sequence (a split sequence would render as replacement characters).
 * @param text - the candidate diagnostic.
 * @param maxBytes - the byte cap.
 * @returns `text`, or a byte-capped tail with a truncation marker.
 */
export function truncateDiagnostic(text: string, maxBytes = DIAGNOSTIC_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end--
  return `${text.slice(0, end)}\n…(diagnostic truncated)`
}

/** Read the whole retained stream off a collect-mode reader. */
function readCollected(reader: SubprocessOutputReader | undefined): string {
  return reader === undefined ? '' : reader.readFrom(0).text
}

/**
 * Start and own one iFlow child run. The handle publishes immediately after
 * spawn; process-level failures settle through `result` (spawn-level faults
 * reject it, child-level faults resolve to a stop reason).
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: command/args/cwd, bounds, env, grace,
 *   and the optional error sink.
 * @returns the ready run handle for the child subprocess.
 */
export async function startIflowRun(request: SubagentStartRequest, spec: IflowRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) {
    throw new Error('subagent request was aborted before the iflow child started')
  }
  const prompt = toPromptText(request.prompt)
  // Lifecycle ids are minted in the parent namespace; iflow's own session id
  // (written under ~/.iflow) stays private to the child.
  const id = SessionId(randomUUID())

  const child = spec.spawn({
    argv: [spec.command, '-p', prompt, '--max-turns', String(spec.maxTurns), ...spec.args],
    cwd: spec.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: spec.stdoutMaxBytes, spill: { maxBytes: spec.stdoutSpillMaxBytes } },
      stderr: { maxBytes: spec.stderrMaxBytes },
    },
    graceMs: spec.graceMs,
    env: spec.env,
  })

  // Shared mutable state keeps cancellation and timeout visible across async
  // closures; both paths terminate the child so `done` settles promptly.
  const flags = { cancelled: false, timedOut: false }
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    // Best-effort stop; process teardown remains authoritative.
    child.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  if (spec.timeoutMs > 0) {
    deadlineTimer = setTimeout(() => {
      if (flags.timedOut) return
      flags.timedOut = true
      child.terminate()
    }, spec.timeoutMs)
  }

  const result: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
    let outcome: SubprocessOutcome
    try {
      outcome = await child.done
    } catch (error: unknown) {
      request.signal.removeEventListener('abort', onAbort)
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      // A spawn-level infrastructure fault (ENOENT, EACCES, …) rejects the
      // result; child-level failures below never reject.
      throw toError(error)
    }
    request.signal.removeEventListener('abort', onAbort)
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    const stdout = readCollected(child.collected.stdout)
    const stderr = readCollected(child.collected.stderr)
    const output: ContentBlock[] = stdout === '' ? [] : [{ type: 'text', text: stdout }]
    if (flags.cancelled) {
      return { output, stopReason: 'aborted' }
    }
    if (outcome.exitCode === 0) {
      return { output, stopReason: 'completed' }
    }
    const diagnostic = truncateDiagnostic(
      flags.timedOut
        ? `iflow timed out after ${spec.timeoutMs} ms (exited with ${exitFacts(outcome)})`
        : `iflow exited with ${exitFacts(outcome)}${stderr === '' ? '' : `\n${stderr}`}`,
    )
    spec.onError?.(new Error(diagnostic), 'error')
    return { output, stopReason: 'error', diagnostic }
  })()

  let disposal: Promise<void> | undefined
  return {
    id,
    localAgent: undefined,
    result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      request.signal.removeEventListener('abort', onAbort)
      requestCancel()
      disposal = (async (): Promise<void> => {
        // A spawn failure has no process to tear down; observe the rejection
        // so disposal in a finally block cannot surface it as unhandled.
        if (child.pid <= 0) {
          await child.done.catch(() => {})
          return
        }
        child.terminate()
        await child.waitForExit()
      })()
      return disposal
    },
  }
}
