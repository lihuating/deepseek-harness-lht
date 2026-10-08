#!/usr/bin/env node
/** Test driver: one delegation turn through a headless Loader composition. */

import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../../packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('subagent-iflow driver requires a config path')

const ctx = await bootProductionProfile({
  binName: 'subagent-iflow-e2e',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})
try {
  await runFixtureTurn(ctx, { task: 'delegate' })
} finally {
  await ctx.fiber.dispose()
}
