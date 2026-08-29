import { chmodSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless REAL-composition coverage: a test-only cordis.yml boots the headless
 * app through the Loader with the iFlow backend pointed at a scripted fake
 * `iflow` CLI, the scripted model delegates once through the subagent tool, and
 * the fake child's stdout answer must reach the parent's tool result verbatim.
 * No model, no key.
 */

const driver = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-iflow/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-iflow/cordis.yml',
  import.meta.url,
))
const fakeIflow = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-iflow/fake-iflow.sh',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('iFlow subagent delegation through a real cordis.yml', () => {
  it('delivers the prompt to the child CLI and returns its stdout as the tool result', async () => {
    chmodSync(fakeIflow, 0o755)
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'subagent-iflow composition smoke',
      tempDirPrefix: 'subagent-iflow-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TEST_IFLOW_FAKE: fakeIflow },
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    // The tool result carries the fake child's stdout answer verbatim.
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const resultText = results[0]!.data.message.content[0].content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(resultText.trim()).toBe('fake iflow answer')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
