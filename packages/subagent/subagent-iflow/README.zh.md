# @deepseek-ai/dsh-subagent-iflow

[English](README.md) | 中文

本包注册一个 iFlow CLI 子代理提供方，默认名为 `iflow`。每次被接受的运行都会在委托会话（Session）的工作目录下启动一个全新的 `iflow -p` 进程，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果契约返回最终答案文本（iFlow 将其打印到 stdout）或独立的失败诊断信息。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，从父会话（或配置的 `cwd` 覆盖项）推导子进程工作目录，并在子进程服务成功派生子进程后立即发布运行句柄。子进程是一次性的 CLI 调用而非协议服务器，因此没有需要等待的启动握手：`result` 在进程退出时结算。

子进程以 `iflow -p <任务> --max-turns <n> [args…]` 在解析出的工作目录下运行。iFlow 的最终答案出现在 stdout，噪音（进度、遥测、网络重试）出现在 stderr，因此 stdout 文本成为 `SubagentResult.output`，stderr 尾部成为失败诊断。退出码为 0 表示对话完成了一轮，映射为 `completed`；非零退出码（无会话、认证失败、CLI 级错误）映射为 `error`，并携带退出事实和 stderr 尾部。请求信号取消或 `dispose()` 映射为 `aborted`，并保留已收集的部分 stdout。墙钟截止（`timeoutSeconds`）会终止子进程并映射为带超时诊断的 `error`。

`dispose()` 是幂等的：移除信号监听、请求取消，然后执行子进程服务的进程树终止（SIGTERM、spawn 宽限期、SIGKILL——Windows 直接强制终止）并等待整棵树退出。spawn 级基础设施故障（ENOENT、EACCES）会拒绝 `result`——这是本后端唯一会拒绝的情形；所有子进程级故障都以 stop reason 结算。每次运行都使用全新进程；未实现进程池。

## 能力与上下文

iFlow 不声明任何启动时能力，因为本进程无法强制执行远端子进程的深度、工具过滤、人设或结构化输出运行时。同时它报告 `inheritsParentContext: false`：子进程全新启动，唯一来自父进程的输入是上述工作目录——对话上下文不会跨进程边界传递。iFlow 自身的会话历史和账户状态位于宿主用户的 `~/.iflow` 下，子进程像手动调用一样读写该目录。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `iflow` | `ctx.subagents` 上的注册名。 |
| `command` | `iflow` | 每次运行启动的可执行文件；通过 PATH 解析，或用绝对路径固定某个安装。 |
| `args` | `[]` | 追加在提示词之后的固定参数（例如 `-m <model>`、`-y`）。 |
| `maxTurns` | `20` | 每次运行的模型调用上限，作为 `--max-turns` 传入。 |
| `timeoutSeconds` | `600` | 提供方拥有的墙钟上限（秒，`0` 表示禁用）；到期后终止子进程并以 `error` 结算。 |
| `cwd` | 父会话工作目录 | 子进程的工作目录覆盖项；必须非空，相对路径在加载时按 harness 启动目录解析，结果必须是 harness 可进入的目录。 |
| `env` | `{}` | 显式子进程环境，叠加在经凭据擦除的父环境之上。 |
| `graceMs` | `3000` | SIGTERM 与 SIGKILL 之间的 POSIX 正宽限期（Windows 直接强制终止）；不能超过 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)。 |

```yaml
- id: subagent-iflow
  name: '@deepseek-ai/dsh-subagent-iflow'
  config:
    providerName: iflow
    command: iflow
    maxTurns: 30
    timeoutSeconds: 900
```

## 与其他提供方并行分发

iFlow 提供方只是 `ctx.subagents` 中的一项，因此使用常见的多工具模式：为每个提供方挂载一行 [`dsh-tool-subagent`](../tool-subagent/README.md)（各用不同的 `toolName`，例如 `subagent_claude` 与 `subagent_iflow`），并设置 `backgroundMode: one-shot`；模型在同一条消息中以 `run_in_background: true` 同时发起两个委托，然后收集两个结果。两个子进程各自独立并发运行。

## 进程边界

子进程通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 服务派生：共享擦除会移除凭据形态的宿主环境变量和宿主的 `DSH_*` 名称，然后显式 `config.env` 值叠加在其后。宿主的 `HOME`（以及其中的 `~/.iflow`）不受影响，因此手动配置的 iFlow 认证对子进程仍然有效。stdout 以 1 MiB 内存尾部 + 8 MiB spill 文件收集；stderr 以 16 KiB 尾部收集；失败诊断按 4096 字节 UTF-8 上限截断。

本包没有默认导出。否则 Cordis loader 解包会隐藏具名 `inject` 元数据；参见 [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)。

## 模型体验

### 子代理请求

#### 模型看到的内容

远端子进程通过 `-p` 收到独立的任务文本，外加它自己的 `~/.iflow` 配置、模型选择与工具。它不会收到父会话上下文。本提供方不声明任何可选启动时能力，因此本地服务会拒绝需要人设、工具过滤、深度强制或结构化输出的请求，而不是静默忽略。

#### Token 影响

子进程为独立的完整上下文和自身的多步历史付费。这些 token 永远不会进入父进程上下文。

#### KV 缓存影响

与父请求缓存相互独立。每个 iFlow 子进程都是带独立模型会话的全新进程；父前缀不可复用。

### 父工具结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，父进程只收到子进程最终的 stdout 文本，或该消费者精确的 stop-reason 错误，而不是中间消息或工具流量。发布前已被取消的请求恰好成为 `Error: subagent request was aborted before the iflow child started`；其他启动失败以 `Error: <message>` 传递。

#### Token 影响

父输入只增长最终结果或错误的长度，数据相关并保留至压缩时。本提供方自身不增加父 schema。

#### KV 缓存影响

仅追加；新可见内容跟随可复用的请求前缀，不会使已有 KV 缓存条目失效。

## 已知限制与后续工作

- **每次运行使用全新进程** —— 持久进程池是未来优化。
- **仅限本地 iFlow** —— 解析出的 cwd 是交给本地 `iflow` 二进制的本地路径；远端或容器化 iFlow 不在范围内。
- **无可选启动时能力** —— 本提供方无法在子 CLI 内部应用本地 harness 的 `outputSchema`、深度上限、工具过滤或人设，因此不声明任何能力，服务会拒绝需要它们的请求。
- **stdout 是唯一的答案通道** —— 若运行把部分答案输出到 stdout 后以非零码退出，则返回该部分文本并标记 `error`；诊断携带 stderr 尾部。
- **超时由提供方持有** —— `timeoutSeconds` 会终止子进程；iFlow 自身不会被告知该上限（如需在 iFlow 内部限时，可通过 `args` 传入 `--timeout`）。
