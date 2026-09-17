# Agent Note: Undici 导入保留进程级 dispatcher

Status: implemented

[English](2026-09-14-undici-import-preserves-global-dispatcher.md) | 中文

## 问题

`web-fetch-http` 经由 Undici 的 `Agent` 与 `fetch` 访问公网，二者在 `requestPinned` 内懒加载。Node 的 `--use-env-proxy` 把按环境变量构造的代理 agent 记在 `globalThis[Symbol.for('undici.globalDispatcher.1')]`，且从不写 Undici 8 视为主槽的 `undici.globalDispatcher.2`。Undici 8 的模块顶层在主槽未设置时向两个槽位都安装一个裸 `Agent`，因此在 `--use-env-proxy` 进程中导入它，必然把代理 agent 换成直连 agent。

替换是进程级且不留任何应用可见痕迹的。harness 自身的 `fetch`——承载每一次模型请求——从那一刻起不再走代理。在直连出口被封禁的环境中，每个请求随后在传输超时处失败，而模型请求重试策略只把结果呈现为"重试次数耗尽"。

## 决策

`importUndici()` 捕获 legacy dispatcher 槽位，执行导入，然后还原被导入顶掉的值。它只还原导入前确有 dispatcher 的槽位，因此未配置代理的进程保留 Undici 安装的默认值；它也只写 legacy 槽位，因此 Undici 的主槽仍保留它为自身用途安装的 agent。

## 考虑过的替代方案

**改为向宿主的 `fetch` 传显式 dispatcher，而不导入 Undici 的 `fetch`。** 否决，因为替换发生在模块图求值期间、先于任何调用点；直接实测，`import('undici')` 一旦 resolve，legacy 槽位就已被替换，与调用方之后用哪个 `fetch` 无关。

**基于 `node:https` 手写地址钉定的传输。** 否决，因为 `lookup` 连接器选项确实能按预期钉定地址，但重定向跟随、TLS 建立、头部处理与中止传播都要重新实现，重复维护中的依赖已经提供的行为。

**在导入前预置主槽。** 否决，因为该值必须是 Undici 8 的 dispatcher，而它在提供它的那次导入之前无法存在。占位值还会波及 Undici `getGlobalDispatcher()` 的每一个消费方，包括从未向本包索取过任何东西的路径。

**把补救留给部署侧，例如一个重新安装代理 agent 的引导 preload。** 否决其作为唯一补救：包不得破坏它并不拥有的进程状态，而且 preload 是在既成事实之后修补症状，并非消除破坏本身。

## 测试

`tests/global-dispatcher.spec.ts` 用一个会替换槽位的 loader 驱动 `importUndici`，覆盖进程此前持有 dispatcher 与未持有两种情况。断言落在槽位取值上，因为模块命名空间与被测效果无关。

## 后果

本包可以在已配置代理的进程中被加载和使用，而不会让该进程其余部分失去代理。

代价是依赖一个符号键控的全局槽位，其布局属于 Undici 而非本仓库；未来某个 Undici major 若迁移或移除该 legacy 槽位，还原会静默失效而非报错。还原也只覆盖本包自身发起的导入。同一进程内另一个依赖导入 Undici 8，仍会替换 dispatcher，因此本笔记不宣称对该情形提供进程级保护。
