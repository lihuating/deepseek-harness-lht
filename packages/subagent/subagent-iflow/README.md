# @deepseek-ai/dsh-subagent-iflow

English | [中文](README.zh.md)

This package registers an iFlow CLI subagent provider whose default name is `iflow`. Each accepted run spawns a fresh `iflow -p` process in the delegating Session's workspace, submits one self-contained text task, and returns either the final answer text (iFlow prints it on stdout) or a separate failure diagnostic through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks, derives the child cwd from the parent Session (or the configured `cwd` override), and publishes the run handle immediately after the subprocess seam spawns the child. The child is a one-shot CLI call, not a protocol server, so there is no startup handshake to await: `result` settles when the process exits.

The child runs `iflow -p <task> --max-turns <n> [args…]` with the resolved cwd. iFlow's final answer arrives on stdout; its noise (progress, telemetry, network retries) arrives on stderr, so stdout text becomes `SubagentResult.output` and the stderr tail becomes the failure diagnostic. A zero exit code means the conversation completed a turn and maps to `completed`; a non-zero code (no session, bad auth, CLI-level error) maps to `error` with the exit facts and stderr tail. A request-signal cancellation or `dispose()` maps to `aborted` and preserves the partial stdout collected so far. A wall-clock deadline (`timeoutSeconds`) terminates the child and maps to `error` with a timeout diagnostic.

`dispose()` is idempotent: it removes the signal listener, requests cancellation, then runs the subprocess seam's tree-scoped termination (SIGTERM, the spawn grace, SIGKILL — Windows force-terminates directly) and awaits whole-tree exit. A spawn-level infrastructure fault (ENOENT, EACCES) rejects `result` — the one rejection this backend produces; every child-level failure resolves to a stop reason. Every run uses a fresh process; process pooling is not implemented.

## Capabilities and context

iFlow advertises no start-time capabilities because this process cannot enforce the remote child's depth, tool filter, persona, or structured-output runtime. It also reports `inheritsParentContext: false`: the child starts fresh, and the only parent-derived input is the workspace cwd described above — no conversation context crosses the process boundary. iFlow's own session history and account state live under the host user's `~/.iflow`, which the child reads and writes exactly like a manual invocation.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `iflow` | Registry name on `ctx.subagents`. |
| `command` | `iflow` | Executable spawned for each run; resolved through PATH, or an absolute path to pin an installation. |
| `args` | `[]` | Extra fixed arguments appended after the prompt (e.g. `-m <model>`, `-y`). |
| `maxTurns` | `20` | Per-run model-call bound passed as `--max-turns`. |
| `timeoutSeconds` | `600` | Provider-owned wall-clock bound in seconds (`0` disables it); the child is terminated and the run settles as `error` on expiry. |
| `cwd` | parent session cwd | Working-directory override for the child process; must be non-empty, a relative value resolves against the harness launch directory at load, and the result must name a directory the harness can enter. |
| `env` | `{}` | Explicit child environment layered over a credential-scrubbed parent environment. |
| `graceMs` | `3000` | Positive POSIX grace after SIGTERM before SIGKILL (Windows force-terminates directly); it cannot exceed [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |

```yaml
- id: subagent-iflow
  name: '@deepseek-ai/dsh-subagent-iflow'
  config:
    providerName: iflow
    command: iflow
    maxTurns: 30
    timeoutSeconds: 900
```

## Parallel dispatch alongside another provider

The iFlow provider is one `ctx.subagents` entry among many, so the ordinary multi-tool pattern applies: mount one [`dsh-tool-subagent`](../tool-subagent/README.md) row per provider (a distinct `toolName` each, e.g. `subagent_claude` and `subagent_iflow`) with `backgroundMode: one-shot`, and the model starts both delegations in one assistant message with `run_in_background: true`, then collects both results. Both children run concurrently in their own processes.

## Process boundary

The child spawns through the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam: credential-shaped ambient variables and ambient `DSH_*` names are removed by the shared scrub, then explicit `config.env` values merge after it. The host user's `HOME` (and with it `~/.iflow`) is untouched, so a manual iFlow authentication stays valid for the child. stdout is collected with a 1 MiB in-memory tail and an 8 MiB spill file; stderr is collected with a 16 KiB tail, and the failure diagnostic is byte-capped at 4096 UTF-8 bytes.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

## Model Experience

### Child-agent request

#### What the model sees

The remote child receives the standalone task text through `-p` plus its own `~/.iflow` configuration, model selection, and tools. It receives no parent conversation. This provider advertises no optional start-time capabilities, so the local service rejects requests for persona, tool filtering, depth enforcement, or structured output instead of silently omitting them.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each iFlow child runs in a fresh process with its own model session; no parent prefix is reusable.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final stdout text or that consumer's exact stop-reason error, not intermediate messages or tool traffic. A request already cancelled before publication becomes exactly `Error: subagent request was aborted before the iflow child started`; other start failures pass through as `Error: <message>`.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A fresh process per run** — persistent-process pooling is a future optimization.
- **Local iFlow only** — the resolved cwd is a local path handed to a local `iflow` binary; remote or containerized iFlow is out of scope.
- **No optional start-time capabilities** — this provider cannot apply the local harness's `outputSchema`, depth cap, tool filter, or persona inside the child CLI, so it advertises none and the service rejects requests that require them.
- **stdout is the whole answer channel** — a run that streams part of its answer to stdout and completes with a non-zero exit returns that partial text with an `error` stop reason; the diagnostic carries the stderr tail.
- **Timeouts are provider-owned** — `timeoutSeconds` terminates the child process; iFlow itself is not told the bound (pass `--timeout` via `args` to bound iFlow internally too).
