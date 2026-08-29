import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'
import * as iflow from '../src/index.ts'
import { startIflowRun, toPromptText, truncateDiagnostic, type IflowRunSpec } from '../src/run.ts'

/**
 * Keyless integration tests for the iFlow subagent backend. Each spawns a REAL
 * subprocess — the fake `iflow` shell script (scripted by IFLOW_FAKE_MODE) —
 * through the REAL subprocess seam, so prompt delivery, the stop-reason
 * mapping, cancellation, the wall-clock timeout, and disposal are all
 * exercised end to end. No model, no key.
 */

/** A parent Agent stub. The iFlow backend reads exactly one thing off it: the session header's cwd (the workspace its child inherits). */
const fakeParent = { id: 'parent', session: { header: { cwd: process.cwd() } } } as unknown as Agent

function request(text = 'task', signal = new AbortController().signal) {
  return { prompt: [{ type: 'text' as const, text }], parent: fakeParent, signal }
}

function text(blocks: ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function baseSpec(overrides: Partial<IflowRunSpec> = {}): IflowRunSpec {
  return {
    command: '/bin/sh',
    args: [],
    cwd: process.cwd(),
    maxTurns: 20,
    timeoutMs: 0,
    env: {},
    graceMs: 1_000,
    stdoutMaxBytes: 1_000_000,
    stdoutSpillMaxBytes: 8_000_000,
    stderrMaxBytes: 16_000,
    spawn: spawnSubprocess,
    ...overrides,
  }
}

interface FakeFixture {
  dir: string
  script: string
  readyFile: string
}

/** Write the fake `iflow` CLI (scripted by IFLOW_FAKE_MODE) and return its path plus a readiness file path. */
function fakeIflow(): FakeFixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-iflow-fake-'))
  const readyFile = join(dir, 'ready')
  const script = join(dir, 'iflow')
  writeFileSync(script, `#!/bin/sh
mode="\${IFLOW_FAKE_MODE:-answer}"
case "$mode" in
  argv)
    echo "$@"
    ;;
  answer)
    echo "fake iflow answer"
    ;;
  empty)
    exit 0
    ;;
  fail)
    echo "fake iflow error" >&2
    exit 3
    ;;
  hang)
    echo "partial iflow answer"
    if [ -n "$IFLOW_FAKE_READY_FILE" ]; then touch "$IFLOW_FAKE_READY_FILE"; fi
    sleep 60
    ;;
  slow)
    sleep 5
    echo "slow iflow answer"
    ;;
esac
`)
  chmodSync(script, 0o755)
  return { dir, script, readyFile }
}

/** Script the fake CLI through the child env (mode + optional ready-file path). */
function fakeEnv(mode: string, readyFile?: string): Record<string, string> {
  return readyFile === undefined
    ? { IFLOW_FAKE_MODE: mode }
    : { IFLOW_FAKE_MODE: mode, IFLOW_FAKE_READY_FILE: readyFile }
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`fake iflow never became ready (${file})`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  readFileSync(file)
}

describe('toPromptText', () => {
  it('joins text blocks into the one task', () => {
    expect(toPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('rejects non-text blocks and empty tasks', () => {
    expect(() => toPromptText([{ type: 'reasoning', text: 'think' }] as ContentBlock[])).toThrow(/text blocks/)
    expect(() => toPromptText([{ type: 'text', text: '   ' }])).toThrow(/not be empty/)
  })
})

describe('truncateDiagnostic', () => {
  it('keeps short text, byte-caps long text without splitting UTF-8', () => {
    expect(truncateDiagnostic('ok', 4096)).toBe('ok')
    const capped = truncateDiagnostic('中'.repeat(2000), 100)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(200)
    expect(capped).toContain('truncated')
  })
})

describe('startIflowRun', () => {
  it('runs the CLI with -p <prompt> --max-turns and returns stdout as the answer', async () => {
    const fake = fakeIflow()
    try {
      const spec = baseSpec({ command: fake.script, env: fakeEnv('argv') })
      const run = await startIflowRun(request('my task'), spec)
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('completed')
      const argv = text(result.output)
      expect(argv).toContain('-p')
      expect(argv).toContain('my task')
      expect(argv).toContain('--max-turns')
      expect(argv).toContain('20')
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('maps a zero exit with stdout text to completed', async () => {
    const fake = fakeIflow()
    try {
      const run = await startIflowRun(request('task'), baseSpec({ command: fake.script, env: fakeEnv('answer') }))
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('completed')
      expect(text(result.output).trim()).toBe('fake iflow answer')
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('maps an empty answer to completed with no output blocks', async () => {
    const fake = fakeIflow()
    try {
      const run = await startIflowRun(request('task'), baseSpec({ command: fake.script, env: fakeEnv('empty') }))
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('completed')
      expect(result.output).toEqual([])
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('maps a non-zero exit to error with the stderr tail in the diagnostic', async () => {
    const fake = fakeIflow()
    try {
      const run = await startIflowRun(request('task'), baseSpec({ command: fake.script, env: fakeEnv('fail') }))
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toContain('code 3')
      expect(result.diagnostic).toContain('fake iflow error')
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('maps cancellation to aborted and preserves the partial answer', async () => {
    const fake = fakeIflow()
    try {
      const controller = new AbortController()
      const run = await startIflowRun(
        request('task', controller.signal),
        baseSpec({ command: fake.script, env: fakeEnv('hang', fake.readyFile) }),
      )
      await waitForFile(fake.readyFile)
      controller.abort()
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('aborted')
      expect(text(result.output)).toContain('partial iflow answer')
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('terminates a child that exceeds the wall-clock bound and reports a timeout error', async () => {
    const fake = fakeIflow()
    try {
      const run = await startIflowRun(
        request('task'),
        baseSpec({ command: fake.script, env: fakeEnv('slow'), timeoutMs: 300 }),
      )
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toContain('timed out after 300 ms')
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('rejects the result when the command cannot spawn', async () => {
    const run = await startIflowRun(request('task'), baseSpec({ command: '/nonexistent/iflow' }))
    await expect(run.result).rejects.toThrow()
    await run.dispose()
  })

  it('rejects start when the request is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(startIflowRun(request('task', controller.signal), baseSpec())).rejects.toThrow(/aborted before/)
  })

  it('publishes a parent-scoped run id with no local agent', async () => {
    const fake = fakeIflow()
    try {
      const run = await startIflowRun(request('task'), baseSpec({ command: fake.script, env: fakeEnv('answer') }))
      expect(run.localAgent).toBeUndefined()
      expect(String(run.id)).toMatch(/^[0-9a-f-]{36}$/)
      await run.dispose()
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })
})

describe('plugin registration', () => {
  it('registers the provider with defaults and no start capabilities', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(iflow, {})
    const provider = ctx.subagents.getProvider('iflow')
    expect(provider?.name).toBe('iflow')
    expect(provider?.capabilities).toEqual({ outputSchema: false, depthLimit: false, toolFilter: false, persona: false })
    expect(provider?.inheritsParentContext).toBe(false)
    expect(ctx.subagents.list()).toEqual(['iflow'])
  })

  it('honors config defaults and a renamed provider', () => {
    expect(iflow.Config({}).providerName).toBe('iflow')
    expect(iflow.Config({}).command).toBe('iflow')
    expect(iflow.Config({}).maxTurns).toBe(20)
    expect(iflow.Config({}).timeoutSeconds).toBe(600)
    expect(iflow.Config({ providerName: 'iflow-zh' }).providerName).toBe('iflow-zh')
  })

  it('fails loud on an unusable config cwd and an empty cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const full = { providerName: 'iflow', command: 'iflow', args: [], maxTurns: 20, timeoutSeconds: 600, env: {}, graceMs: 3000 }
    expect(() => iflow.apply(ctx, { ...full, cwd: '' })).toThrow(/must not be empty/)
    expect(() => iflow.apply(ctx, { ...full, cwd: '/definitely/not/a/dir' })).toThrow(/not an accessible directory/)
  })

  it('runs a delegation through the registered service with the parent cwd', async () => {
    const fake = fakeIflow()
    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(iflow, { command: fake.script, env: fakeEnv('answer') })
      const run = await ctx.subagents.start('iflow', { ...request('task'), signal: new AbortController().signal })
      const result = await run.result
      await run.dispose()
      expect(result.stopReason).toBe('completed')
      expect(text(result.output).trim()).toBe('fake iflow answer')
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
    }
  })

  it('rejects a delegation from a parent session without a cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(iflow, {})
    const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
    await expect(ctx.subagents.start('iflow', {
      prompt: [{ type: 'text', text: 'task' }],
      parent,
      signal: new AbortController().signal,
    })).rejects.toThrow(/no working directory/)
  })
})
