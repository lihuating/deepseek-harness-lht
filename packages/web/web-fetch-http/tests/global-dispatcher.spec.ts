import { afterEach, describe, expect, it } from 'vitest'
import { importUndici } from '../src/network.ts'

const SLOT = Symbol.for('undici.globalDispatcher.1')
const slots = globalThis as unknown as Record<symbol, unknown>
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, SLOT)

/**
 * Set the slot the way a real Undici import does. Assignment, not
 * `Object.defineProperty`: once Undici or Node has defined the slot it is
 * non-configurable, so only its value can still change.
 */
function install(value: unknown): void {
  slots[SLOT] = value
}

/** Stand-in for the module namespace; the slot effect is what these cases assert. */
const moduleNamespace = {} as unknown as typeof import('undici')

afterEach(() => {
  if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, SLOT)
  else Object.defineProperty(globalThis, SLOT, originalDescriptor)
})

describe('importUndici', () => {
  it('puts back the dispatcher a proxy-configured process had installed', async () => {
    const proxyAgent = { dispatch: () => undefined }
    install(proxyAgent)

    const undici = await importUndici(async () => {
      install({ dispatch: () => undefined })
      return moduleNamespace
    })

    expect(undici).toBe(moduleNamespace)
    expect(slots[SLOT]).toBe(proxyAgent)
  })

  it('leaves the dispatcher Undici installs when the slot was empty', async () => {
    install(undefined)
    const undiciAgent = { dispatch: () => undefined }

    await importUndici(async () => {
      install(undiciAgent)
      return moduleNamespace
    })

    expect(slots[SLOT]).toBe(undiciAgent)
  })
})
