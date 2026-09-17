# Agent Note: Undici imports preserve the process-global dispatcher

Status: implemented

English | [中文](2026-09-14-undici-import-preserves-global-dispatcher.zh.md)

## Problem

`web-fetch-http` reaches the public internet through Undici's `Agent` and `fetch`, imported lazily inside `requestPinned`. Node's `--use-env-proxy` records the environment-configured proxy agent in `globalThis[Symbol.for('undici.globalDispatcher.1')]` and never writes the `undici.globalDispatcher.2` slot that Undici 8 treats as primary. Undici 8's module top level installs a plain `Agent` into both slots whenever the primary slot is unset, so importing it in a `--use-env-proxy` process always replaces the proxy agent with a direct one.

The replacement is process-wide and leaves no application-visible trace. The harness's own `fetch`, which carries every model request, stops using the proxy from that moment on. Where direct egress is blocked, each request then fails at its transport timeout, and the model-request retry policy surfaces the outcome only as exhausted retries.

## Decision

`importUndici()` captures the legacy dispatcher slot, performs the import, and restores a value the import displaced. It restores only a slot that held a dispatcher beforehand, so a process that configured no proxy keeps the default Undici installs, and it writes only the legacy slot, so Undici's primary slot retains the agent installed for Undici's own use.

## Alternatives considered

**Pass an explicit dispatcher to the host's built-in `fetch` rather than importing Undici's.** Rejected because the replacement happens while the module graph evaluates, before any call site runs; measured directly, the legacy slot is already replaced once `import('undici')` resolves, regardless of which `fetch` the caller then uses.

**Hand-roll the pinned transport on `node:https`.** Rejected because the `lookup` connector option would pin the address as intended, but redirect following, TLS setup, header handling, and abort propagation would all be reimplemented to duplicate behavior the maintained dependency already provides.

**Predefine the primary slot before importing.** Rejected because the value must be an Undici 8 dispatcher, which cannot exist before the import that provides it. A placeholder would additionally reach every consumer of Undici's `getGlobalDispatcher()`, including paths that never asked this package for anything.

**Leave the remedy to the deployment, such as a bootstrap preload that reinstalls the proxy agent.** Rejected as the sole remedy: a package must not damage process state it does not own, and a preload repairs the symptom after the fact instead of removing the damage.

## Testing

`tests/global-dispatcher.spec.ts` drives `importUndici` with a loader that replaces the slot, covering both a process that held a dispatcher and one that did not. The cases assert on the slot value, because the module namespace has no bearing on the effect under test.

## Consequences

The package can be loaded and used in a proxy-configured process without disabling the proxy for the rest of that process.

The cost is a dependency on a symbol-keyed global slot whose layout belongs to Undici rather than to this repository; a future Undici major that moves or drops the legacy slot would make the restore a no-op rather than a failure. The restore also protects only what this package imports. Another dependency importing Undici 8 in the same process still replaces the dispatcher, so this note claims no process-wide protection against that case.
