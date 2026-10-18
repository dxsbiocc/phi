# Phi 设计缺陷审计

Date: 2026-10-18
Status: 审计结论(只读分析,未修改任何生产代码);2026-10-18 已与 `fix/t16-local` 对齐,见 §0.1
范围: OMP/引擎依赖、SSH 与远程 RPC、以及跨领域的会话/错误/持久化设计
关联: 代码整洁度优化方案 `docs/architecture/clean-code-optimization-plan.md`(解决"改不动",目前只在 main 工作区未提交),本文(解决"会坏")

---

## 0. 方法与证据等级

本文由两轮独立专项审计加人工抽验合并而成,所有结论都能回溯到具体代码行。

| 标记 | 含义 |
| --- | --- |
| ✅ 已抽验 | 我本人打开代码逐行核对过引文 |
| 📋 子审计 | 来自专项审计的代码引用,已交叉检查但未逐行复读 |

原审计对着 `main`(`2fa24404`)做。`docs/roadmap/remote-constraint-audit-2026-10-17.md` 当时在 `main` 上找不到,是因为它在 `fix/t16-local` 分支上(`1edaf017`),尚未合并;SSH/RPC 侧的启动、部署与命令数结论以那份文档和 [omp-remote-acceptance.md](../runtime/omp-remote-acceptance.md) 为准。

不在本文范围:产品功能取舍、内测范围决策、UI 视觉问题、打包签名。这些见 `docs/roadmap/internal-beta-implementation.md`。

### 0.1 与 `fix/t16-local` 对齐(2026-10-18,`bbd99130`)

逐条在分支上重新打开代码核对,原 📋 条目全部复核过。状态含义:**仍在** = 分支代码与引文一致;**部分** = 部分已修,剩余问题写在备注;**已修** = 不再成立。

| 编号 | 分支状态 | 备注 |
| --- | --- | --- |
| OMP-01 | 仍在 | `in-process/session-creation.ts:304-305` 每个事件仍附整段 `sessionState` |
| OMP-02 | 已修 | `ab123b20`:`stop()` 跟踪子进程直到真正退出,SIGTERM 1s 后升级 SIGKILL;worker 在宿主断开后清理并退出 |
| OMP-03 | 已修 | `ab123b20`:`request()` 支持 `timeoutMs`/`signal`;短控制调用默认 15s,`session.abort` 与 `modelGateway.create` 超时即停 worker;长调用不设超时 |
| OMP-04 | 仍在 | `omp-bridge.ts:170` 只还原 `ConfiguredStdioProbeError` |
| OMP-05 | 仍在 | `events.ts:1` 仍从 OMP 派生;`facade-event-projection.ts:261` 远端形状不符仍 throw |
| OMP-06 | 仍在 | 实测 73 个文件、45 个私有子路径;`package.json` 只声明 `pi-coding-agent`、`pi-natives` |
| OMP-07 | 已修 | `ab123b20`:stdin 错误与写回调错误都让该代 worker 退役,不再抛出未捕获的 EPIPE |
| OMP-08 | 仍在 | `omp-bridge.ts:559` 非事件静默丢弃,无握手 |
| OMP-09 | 已修 | `a82ef561`:桌面端统一用 `engine/omp-version.ts`;`package.json` 与远端扩展的字面量由 `tests/omp-version-pin.test.ts` 校验 |
| OMP-10 | 仍在 | `remote-session-runtime.ts:1246` 无主 run 时 `stopExecution()` 直接返回,子代理只在 `close()` 里 `stopParent` |
| OMP-11 | 仍在 | `session-factory.ts:8,54`;`owned-stdio-transports.ts:28-36` |
| OMP-12 | 仍在 | `host-service-registry.ts:8` 键只有方法名;facade 在 `:489,612` 共用同一 registry |
| OMP-13 | 已修 | `6bee4f41`:预算按在途私有调用计数,结果投影后释放;溢出只拒绝该帧 |
| OMP-14 | 仍在 | `fetch-bun.mjs:21` 只有两个平台 |
| SSH-01 | 部分 | 远程**启动**已改为单个启动事务脚本,正常启动 4 条远程命令、约 12s(GPU R8,`a7d0008c`);部署用的 `runtimeHost` 已带 helper(`remote-runtime/workspace.ts:88`,`446cda81`),原文"明确不带 helper"不再成立。**仍在**:会话内前台命令走 `ssh-host-exec.ts:30,155` 的 25ms 轮询,`ssh-host-context.ts:103` `withSession` 每次新建连接 |
| SSH-02 | 已修 | `3c014834`:单请求超时只让该请求以 `TIMEOUT_UNKNOWN` 失败;abort 与 prompt 受理超时仍显式放弃该代 |
| SSH-03 | 仍在 | `history-pager.ts:129-130` 64MiB 上限;`HISTORY_LIMIT` 在 UI 侧仍无专门文案 |
| SSH-04 | 部分 | `1f856efe` 断线后释放会话;已有服务器端 flock 写者租约(`session-storage/writer-lease.ts`,`startup-transaction.ts:447-452`),第二个 writer 在旧锁仍被持有时会被挡住。**仍在**:锁由启动通道持有,SSH 断开后锁随之释放,而远端 OMP 是否退出 Phi 无法确认;没有远端 PID/run 登记与断线后补偿 abort |
| SSH-05 | 已修 | `3c014834`:状态机按错误码判断,中文正则已删;只有 `TRANSPORT_LOST` 释放 host |
| SSH-06 | 已修 | `3c014834`:远程 turn 失败区分 `PROVIDER_ERROR`/`APPROVAL_DENIED`/`ABORTED`/`TRANSPORT_LOST`,脱敏后写入 `run_failed` |
| SSH-07 | 仍在 | `remote-session-runtime.ts:554` 默认原生工具;`approval-bridge.ts:66` 审批集合;`:133-136` 帧预算耗尽后静默 `cancelled` |
| SSH-08 | 未复核 | 本轮未改动相关文件,沿用原结论 |
| SSH-09 | 仍在 | `ssh-bootstrap/host-key.ts` 只跳过 `@` 标记;`every` 要求每个旧算法都被重扫到 |
| SSH-10 | 仍在 | `runtime-deployment/deployment.ts:22` 仅进程内互斥(启动事务的 flock 只覆盖会话存储,不覆盖运行时部署 staging) |
| SSH-11 | 部分 | 清理已改为先校验归属再 `rm -rf`(`ssh-stdio-factory.ts:391`),但仍走同一条通道、失败被吞(`:392`),没有启动时按年龄清扫 |
| X-01 | 仍在 | 未改动 |
| X-02 | 部分 | `3c014834` 新增 `src/shared/errorCodes.ts`,远程与引擎已迁移;`index.ts` 其余 `throw new Error` 仍为 `UNKNOWN` |
| X-03 | 仍在 | 未改动 |
| X-04 | 仍在 | `index.ts` 12,875 行、234 个 `ipcMain.handle` |
| X-05 | 仍在 | `App.tsx` 5,503 行 |
| X-06 | 部分 | 原文第三条("约束审计文档已不存在")不成立,见上文;量化漂移两条仍成立 |
| X-07 | 部分 | **更正**:全量 `bun run test` 能跑完——分支合并 main 后 7062 个测试、0 失败,约 21 分钟(原文"超过 20 分钟仍未结束"是中途中止)。`main-integration.test.ts` 现为 16,423 行 |

#### 按内测路线图重排的处置顺序

内测目标是可靠的本地工作台,远程运行时(step 8)在内测之后,`PHI_REMOTE_OMP_RPC` 仍默认关闭。因此在 §7 的基础上调整为:

1. **本地引擎止血**(影响 P0 多会话执行,不需设计决定):OMP-07 → OMP-03 → OMP-02。
2. **升级安全**:OMP-09 单一版本来源 + 测试断言。
3. **RPC 默认开启的门槛**(2026-10-18 用户确认,已加入 [升级计划 §6.5](../roadmap/omp-decoupling-upgrade-plan.md)):SSH-05/X-02 结构化错误码、SSH-02、OMP-13、OMP-10、SSH-01 剩余部分、SSH-04 剩余部分。错误码分类与 SSH 连接池需要先定设计。
4. **结构项**:OMP-05/01、X-01/04/05 并入整洁度方案的主进程拆分。

#### 设计决定(2026-10-18 用户确认)

**错误码:共享错误码,先迁远程和引擎。**

- `src/shared` 定义一个小的错误码枚举,每个码带 `retryable`;IPC 边界序列化为 `{ code, retryable, message }`。
- 初始码:`TRANSPORT_LOST`(确认传输失效 → offline、释放 host)、`TIMEOUT_UNKNOWN`(只让本次调用失败,结果未知,不动连接)、`PROVIDER_ERROR`(可重试或换模型)、`APPROVAL_DENIED`、`ABORTED`(两者不计为失败)、`DOMAIN_*`(只展示,不动连接)、`UNKNOWN`(未迁移的旧代码)。
- 本轮只迁 SSH、RPC、OMP bridge 与远程 turn 失败(覆盖 SSH-05、SSH-02、SSH-06);其余代码保持 `UNKNOWN`,随整洁度方案逐步迁移。不做全量迁移。
- 连接状态机只按 code 判断,删除中文文案正则;只有 `TRANSPORT_LOST` 才释放 host。

**连接复用:helper 优先,兜底路径复用连接。**

- 远程项目打开时即启动 helper,不再按需启动;正常情况下所有 fs/exec 走 helper 的常驻连接。
- helper 不可用时的纯 SSH 兜底:每个 host 一条带引用计数的共享 SSH master(会话池);前台命令在该连接上单通道流式执行,不再"先 detach 再轮询";只有真正的后台任务轮询,间隔放宽并复用同一连接。
- 改动集中在 `workspace-host/ssh-host-context.ts`、`ssh-host-exec.ts` 与 `ssh-host.ts` 的 helper 启动时机。

---

## 1. 严重度总览

| 编号 | 缺陷 | 严重度 | 证据 |
| --- | --- | --- | --- |
| OMP-01 | 每个事件携带完整会话快照,管道无背压 | 高 | ✅ |
| OMP-02 | worker 只 SIGTERM、句柄提前置空、无父死退出 | 高 | ✅ |
| OMP-03 | 桥接请求无超时、无存活探测 | 高 | 📋 |
| OMP-04 | 错误分类跨进程压平为字符串 | 高 | ✅ |
| OMP-05 | 事件契约由上游类型派生,且本地/远端两套翻译 | 高 | ✅ |
| OMP-06 | 43 个私有子路径 + 4 个幽灵依赖 | 高 | ✅ |
| SSH-01 | 前台命令"后台化 + 25ms 轮询",每次轮询新建 SSH master | 高 | ✅ |
| SSH-02 | 任何响应超时销毁整条 generation | 高 | ✅ |
| SSH-03 | 每 turn 全量重下历史,>64MiB 会话永久不可恢复 | 高 | ✅ |
| SSH-04 | 断线是终态,可形成双写者 | 高 | ✅ |
| OMP-07 | stdin 无 EPIPE 监听,可致主进程崩溃 | 中高 | 📋 |
| OMP-08 | 无握手/版本协商,未知事件静默丢弃 | 中高 | 📋 |
| OMP-09 | 版本字面量 18 处无校验,运行期断言会打死 MCP | 中高 | ✅ |
| OMP-10 | 远端 abort 不停止后台子代理 | 中高 | 📋 |
| SSH-05 | 状态机由中文字符串正则驱动;域错误也拆连接 | 中高 | ✅ |
| SSH-06 | provider/重试元数据被丢弃 | 中高 | 📋 |
| SSH-07 | 两套远程工具栈,审批覆盖面靠工具名白名单 | 中高 | 📋 |
| OMP-11 | 依赖 legacy shim + Proxy + 原型补丁 | 中 | 📋 |
| OMP-12 | HostServiceRegistry 仅以方法名为键,静默覆盖 | 中 | 📋 |
| OMP-13 | 远端投影 privateCalls 预算永久锁死事件流 | 中 | 📋 |
| SSH-08 | symlink 写入语义本地与远程相反 | 中 | 📋 |
| SSH-09 | known_hosts 解析忽略 @revoked/@cert-authority | 中 | 📋 |
| SSH-10 | 运行时部署只有进程内互斥,扩展部署有 flock | 中 | 📋 |
| X-01 | 会话身份有 11 个并行概念 | 中高 | ✅ |
| X-02 | 无错误分类体系,跨 IPC 只剩 message | 中高 | ✅ |
| X-03 | 事件落盘在主线程做同步 I/O | 中 | ✅ |
| X-04 | 无服务层,业务逻辑住在 IPC handler | 中 | ✅ |
| X-05 | 渲染层无路由,单 App 组件持有全部状态 | 中 | ✅ |
| OMP-14 | bun 仅打包 darwin-arm64 / linux-x64 | 低-中 | ✅ |
| SSH-11 | 掉线后远端会话目录与 bearer 文件永久残留 | 低-中 | 📋 |
| X-06 | 架构文档与现实脱节 | 低 | ✅ |
| X-07 | 测试规模与形态问题 | 低-中 | ✅ |

统计:高 10 条,中高 8 条,中 8 条,低 4 条。

---

## 2. 一档:先修的 6 条

这 6 条的共同点:不需要业务决策,修完立刻消除一类无法自愈的故障。

### OMP-01 每个事件携带完整会话快照,管道无背压

**证据**
- `src/main/agent/engine/in-process/session-creation.ts:303-305`
  ```ts
  result.session.subscribe((event) => {
    sendEvent('sessionEvent', translateOmpEvent(event, result.session), { sessionId })
    sendEvent('sessionState', serializeSessionState(result), { sessionId })
  })
  ```
- `src/main/agent/engine/in-process/tool-support.ts:42-51` — `serializeSessionState` 返回 `messages: session.messages`,即**整段对话**。
- `src/main/agent/engine/in-process/common.ts:83` — `JSON.parse(JSON.stringify(value))`,随后 `send` 再 stringify 一次。
- 接收侧 `src/main/agent/engine/omp-bridge.ts:471` 用 `createInterface` 逐行读,**无单行长度上限**;`omp-bridge.ts:276` 写 stdin 忽略返回值、不等待 `drain`。

**影响**
`message_update` 是逐 token 到达的。每个 delta 都让 worker 把整段历史序列化两遍、主进程再解析一遍。1000 条消息的会话中,单个 token 的开销就是 MB 级,CPU/内存随对话长度**平方增长**。对比远端通道(`rpc/frame-codec.ts:5-7` 明确 1MB 帧限 / 64MB 重组限,`connection.ts` 有写队列上限),**默认的本地路径一个限制都没有**。

**修复方向**
`sessionState` 改为按需拉取(只在 create/prompt/setModel 等应答里返回),事件流只发增量;bridge 侧加有界写队列 + 单行上限 + 等待 `drain`,超限按协议错误断开而不是静默堆积。

### OMP-02 worker 生命周期只有 SIGTERM

**证据**
- `src/main/agent/engine/omp-bridge.ts:443-457`
  ```ts
  this.child = null
  ...
  child.kill()
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 1500).unref()
  })
  ```
- worker 侧 `src/main/agent/engine/in-process/main.ts:171-175` 只有清理,没有 `process.exit`;对照 `src/main/terminal/terminal-worker.ts:226` 有 `stdin end → shutdownAfterHostExit → process.exit(0)`。

**影响**
`this.child` 在 kill 之前已置空,1.5s 后 `stop()` 正常返回但进程可能还活着 —— **主进程已丢弃唯一句柄**,此后没有任何代码能杀掉它。下一次请求会拉起第二个 worker:旧进程继续持有 MCP 子进程、模型网关端口、shell job,而 `activeSessions` 已清空,旧会话成幽灵。父进程崩溃时同理,worker 能否退出取决于是否还剩定时器句柄。

**修复方向**
`stop()` 保留句柄直到 `exit`,超时后 SIGKILL 并等 `exit`;worker 照抄 terminal-worker 的三重退出(`stdin end`、`stdin error`、`stdout error`)。

### OMP-03 桥接请求无超时

**证据**
- `src/main/agent/engine/omp-bridge.ts:253-284`: `request()` 只 `pending.set(...)` 后写一行,**无 timeout、无 signal**。
- 唯一结束 pending 的路径是进程 `exit|error` → `rejectAll`。
- 上层 `session-runner-registry.ts:141-146` 在 run 未 settle 前拒绝新 run。

**影响**
区分"worker 死了"和"worker 卡住"的唯一手段是进程退出事件。若 OMP 卡在不可中断的 await(死 socket、native 调用、MCP 子进程无响应),`session.prompt` 永不 settle:UI 永久 running、manifest 永久 `status: 'running'`、无法开新 run,而"停止"发往同一条卡住的管道。用户可见的后果是应用假死,只能重启。

**修复方向**
`request()` 支持 `{ timeoutMs, signal }`;超时 reject 并把 worker 标记为不健康(受控重启 + 会话重建);`session.abort` 用独立短超时,超时即降级为杀 worker。

### SSH-01 前台命令"后台化 + 25ms 轮询",每次轮询新建 SSH master

**证据**
- `src/main/agent/workspace-host/ssh-host-exec.ts:30` `const POLL_INTERVAL_MS = 25`
- `ssh-host-exec.ts:149` `for (;;) { const state = await this.query(); await delay(POLL_INTERVAL_MS) }`
- `ssh-host-exec.ts:141` `this.context.withSession((session) => readDetachedStatus(...))`
- `src/main/agent/workspace-host/ssh-host-context.ts:98-105`
  ```ts
  async withSession<T>(operation: (session: RemoteSshSession) => Promise<T>): Promise<T> {
    const session = await this.connect()
    try { return await operation(session) } finally { await session.close() }
  }
  ```
- 连接本身不缓存:`src/main/agent/wrappers/remote-ssh-session.ts:589` `mkdtemp` + `:595` `spawnImpl('ssh', buildMasterArgs(...))`
- 前台 `run()` 也走后台:`ssh-host-exec.ts:255-256` `spawnBackground(...)` 后 `wait()`

**影响**
一条 1 秒的命令会串行建立数十条 master,每条还附带 `ssh -G`(`remote-ssh-session.ts:352`)和 `ssh-keygen` 身份预检。HPC 登录节点上直接撞 `MaxStartups` / PAM 限速。部署路径的 `runtimeHost` 明确不带 helper(`remote-runtime/workspace.ts:65`),所以每次会话启动的 prepare/reuse 都吃满这个放大。副作用还有在用户项目根创建 `wrappers/runs/<id>`。

**修复方向**
给 `SshHostContext` 加按 host 复用、引用计数的会话池,轮询复用同一条通道;前台命令改为单通道流式执行,不要"先 detach 再轮询"。

### SSH-02 任何响应超时销毁整条 generation

**证据**
- `src/main/agent/engine/rpc/connection.ts:434-438`
  ```ts
  pending.timer = setTimeout(
    () => this.fail(state, new Error(`RPC ${command.type} response timed out`)), ms)
  ```
- `fail()`(`connection.ts:551-584`)会置 `state.phase='closed'`、`controller.abort()`、reject 全部 responses 并关闭 transport。
- 控制握手只给 10 秒:`execution-authority.ts:341-344` `prompt(..., { timeoutMs: 10000 })`。

**影响**
超时被建模成"通道死亡"而不是"这次调用失败"。服务器一次 GC/IO 卡顿 >30s,正在进行的 prompt 被 reject、所有 pending approval 被 cancel、子 agent 被停,而 SSH 完全健康。没有 per-request 重试、没有"慢但活着"状态;用户看到"连接中断",实际是单次延迟尖峰。

**修复方向**
超时只 reject 对应 request(保留 generation);幂等读请求做有界重试;把"通道健康"与"单命令超时"拆成两套判定。

### SSH-04 断线是终态,可形成双写者

**证据**
- `src/main/agent/engine/rpc/remote-session-runtime.ts:383-388`
  ```ts
  this.connection.onDisconnect(({ error, expected }) => {
    if (!expected) void this.interrupt(error).catch(() => undefined)
  })
  ```
- `close()`(`remote-session-runtime.ts:1275-1279`)只 `connection.close()` / `delivery.dispose()` / `authority.dispose()`,**没有任何远端 abort 或进程终止**。
- 掉线时的远端清理只是 `rm -rf` session 目录(`ssh-stdio-factory.ts:280-283`),而 journal 在 `runtimeRoot/omp-sessions/<key>/journals`,不在被删目录内。
- 全仓没有远端 PID/run-id 登记表。

**影响**
断线后远端 OMP 是否退出取决于 sshd/SDK 行为,Phi 既不能确认也不能停止。下次 resume 会启动**第二个** OMP 去 `switch_session` 同一份 journal —— 双写者。遗留子 agent / 长 bash 继续消耗服务器资源。UI 只显示"运行失败",没有"停止远端运行"或"确认已退出"入口。

**修复方向**
每次 launch 记录远端 PID/run-id,断线后经新连接做最佳努力 abort 并验证退出;或引入带超时的服务器端 supervisor 租约,让桌面端只能"重新接管或确认死亡",不允许并存两个 writer。

---

## 3. OMP / 引擎依赖

### 3.1 契约层

#### OMP-05 事件契约由上游类型派生,且有两套翻译 ✅

**证据**
- `src/main/agent/engine/events.ts:1` `import type { CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'`
- `events.ts:39` `type OmpEvent = Parameters<Parameters<CreateAgentSessionResult['session']['subscribe']>[0]>[0]`
- `events.ts:46` `return { ...message } satisfies PhiAssistantMessage` —— 整对象展开,不是投影
- `src/main/agent/engine/event-types.ts:3` 承诺"Fields outside Phi's contract survive for diagnostics and forward compatibility."
- 远端却另有一套白名单:`rpc/facade-event-projection.ts:52-64` 逐字段拷贝,未知字段丢弃;`:262` 形状不符直接 `throw new Error('Unsupported remote public history message shape')`

**影响**
`PhiAgentEvent` 不是独立契约,而是 OMP 事件类型的结构镜像。OMP 改一个字段名,`events.ts` 就地报错,而该文件被 worker、main、subagents 同时引用 —— **OMP 升级 = Phi 事件域跟着改**。更严重的是同一语义有两套不一致的翻译:同一条事件本地能看到、远端被吞,这既违反 `event-types.ts:3` 的书面承诺,也让"升级只改 `engine/`"的策略失去前提。

**修复方向**
`PhiAgentEvent` 改为手写、不 import OMP 的独立 DTO;配**唯一**的 `projectOmpEvent(raw: unknown): PhiAgentEvent`,本地与远端共用;未知事件统一落到 `PhiUnknownAgentEvent`,而不是丢弃或 throw。

#### OMP-04 错误分类跨进程压平 ✅

**证据**
- worker 侧 `src/main/agent/engine/in-process/main.ts:188-195`
  ```ts
  const message = error instanceof Error ? error.message : String(error)
  send({ id: request?.id ?? '', ok: false, error: message, stack, detail })
  ```
- 主进程侧 `omp-bridge.ts:170-176` 只还原一个特例:`detail ? new ConfiguredStdioProbeError(...) : new Error(message)`
- 错误消息会把 8KB stderr 拼进用户可见文案(`omp-bridge.ts:513-518`)

**影响**
`RuntimeReferenceError`、`RemoteSessionCapabilityError`、用户取消、MCP 探测失败、会话丢失,跨过 stdout 后全部退化为 `Error(message)`。上层无法按种类分支("会话丢失→重建" vs "工具失败→展示" vs "用户取消→不计失败"),只能字符串匹配 —— 这也是 SSH-05 那条中文正则的同类根因。同时 stderr 进 UI/manifest 有泄密风险。

**修复方向**
协议加稳定 `code` + `retryable` + 结构化 `cause`;worker 用带 code 的错误子类;`createBridgeError` 按 code 还原为 Phi 侧类型;stderr 只进日志。

### 3.2 进程边界

#### OMP-06 43 个私有子路径 + 4 个幽灵依赖 ✅

**证据**
- `src/` 内 **72 个文件** import `@oh-my-pi/*`,48 个不同 specifier 中 **43 个是私有子路径**,例如
  - `omp-internals.ts:20` `'@oh-my-pi/pi-coding-agent/memories/storage'`
  - `omp-internals.ts:24` `'@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'`
  - `in-process/settings.ts:6` `'@oh-my-pi/pi-coding-agent/config/model-resolver'`
- `package.json:85-86` 只声明两个包,但代码直接 import `@oh-my-pi/pi-ai`(45 次)、`pi-agent-core`(15)、`pi-utils`(6)、`pi-catalog`(5) —— 均为 `pi-coding-agent` 的传递依赖
- `scripts/engine-boundary-allowlist.json`:50 条白名单,其中 42 条 `plan: "keep"`,即"已正常化"而非"待消除"
- 对照:升级计划文档(M-1 基线,2026-10-12)记录"约 40 个文件",现已翻倍

**影响**
私有子路径不受 semver 保护,随时可在 patch 版本移动或改签名;白名单只保证"import 写在这里",不保证 API 稳定。幽灵依赖更实际:上游调整依赖树后,`bun install` 可能让这些包不在顶层 `node_modules`,报错是 `Cannot find module` 而非可读的版本冲突。

**修复方向**
43 个子路径压到 3-5 个真正的边界模块;4 个幽灵包显式写进 `dependencies` 并锁同版本;allowlist 改为带到期版本号,禁止无限期增长。

#### OMP-07 stdin 无 EPIPE 监听 📋

**证据**:`omp-bridge.ts:276` 写 stdin 无 callback、无 `error` 监听;全仓这是唯一没有 `stdin.on('error')` 的子进程写入点(对照 `terminal-host.ts:452` 带 callback、`remote-ssh-session.ts:450` 显式吞错)。

**影响**:`ensureStarted()` 的检查与写入之间存在窗口(worker 已被 OOM 杀掉但 `exit` 未投递),此时 EPIPE 触发写流 `'error'` 且无监听器 → `uncaughtException` → **Electron 主进程崩溃**,全部本地会话丢失。修法极便宜。

**修复方向**:`child.stdin.on('error', ...)` 统一走 `rejectAll` + 标记 generation 失效。

#### OMP-08 无握手 / 版本协商 📋

**证据**:`omp-bridge.ts:559` `if (!isBridgeEvent(message)) return` 静默丢弃;`in-process/main.ts:165-166` 未知方法才抛字符串错;stdout 桥两端**没有任何** hello/version/schema 帧。而 `resolveWorkerPath()` 允许 `PHI_OMP_WORKER_PATH` 与 `process.cwd()` 源码目录覆盖。

**影响**:主进程与 worker 可能来自不同构建。没有握手时,版本错配表现为事件静默消失、字段改名后各自 `undefined` —— 现象是"少了一段流",而不是报错。

**修复方向**:加一次 `handshake { schema, buildId, capabilities[] }`,不匹配拒绝启动并给可读错误;未知事件进结构化日志。

#### OMP-11 legacy shim + Proxy + 原型补丁 📋

**证据**
- `in-process/session-factory.ts:2-9` 从 `@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim` 取 `createAgentSession`
- `session-factory.ts:55-60` 用 `Proxy` 在启动瞬间把候选模型伪装成空:
  ```ts
  key === 'getAll' || key === 'getAvailable' || key === 'getAvailableForProviders'
    ? (...args: unknown[]) => (blocked ? [] : Reflect.apply(value, target, args))
  ```
- `mcp/owned-stdio-transports.ts:33-40` 的 `installHooks()` 覆盖 `StdioTransport.prototype.connect` 与 `globalThis.Bun.spawn`

**影响**:启动语义建立在两个无契约假设上 —— ①包内存在名为 `legacy-pi-coding-agent-shim` 的过渡入口;②用"临时清空候选"逆向控制 OMP 的模型模糊匹配。原型补丁跨进程改动 OMP 的传输与 bun 全局 spawn,上游任何重构都会让 MCP 租约静默失效,而失败点是运行时的 `unsupported()`。

**修复方向**:向 OMP 要显式的启动模型解析参数(禁止 fuzzy fallback),删掉 Proxy;stdio 租约改为显式传入自有 transport;shim 入口锁在边界模块并加能力探测。

#### OMP-12 HostServiceRegistry 仅以方法名为键 📋

**证据**:`host-service-registry.ts:7-11` `this.handlers.set(method, handler)` —— 键只有方法名,无会话/代次维度;重复注册静默覆盖,先注册者的 disposer 因 `get(method) !== handler` 变成永久 no-op。

**影响**:远端 facade 把同一个 `bridge.hostServices` 传给多个 `startRuntime`(`facade-session-driver.ts:487,610`)。两条会话并存时,后注册者会接走本属于前者的 host 请求(`planReview.request`、`environments.request` 按 `runtimeSessionId` 区分),参数校验落在错的会话上。属于安全相关的静默串话。

**修复方向**:注册键加 `(generation, sessionId)`;重复注册直接抛错。

#### OMP-13 privateCalls 预算永久锁死事件流 📋

**证据**:`rpc/facade-event-projection.ts:58-64`
```ts
if (this.privateCalls.size >= 4096 && !this.privateCalls.has(id)) {
  this.privateOverflow = true
  throw new Error('Private tool carrier budget exceeded')
}
```
`privateCalls` 从不删除、`privateOverflow` 从不复位;`:262-263` 每帧检查,true 后所有投影都 throw。

**影响**:每会话一个 projector,累计 4096 个不同 toolCallId 后进入**永久失败态**,远端会话事件流整体断掉且不可恢复。等于给会话设了一个不可见的寿命上限。

**修复方向**:预算按**并发在途**而非历史累计计数,收到 result 即移除;溢出只拒绝该次私有调用并记日志。

### 3.3 版本与发布

#### OMP-09 版本字面量无单一来源 ✅

**证据**:`18.10.3` 出现在 **12 个文件、18 处**,包括
- `package.json:85`、`session/runtime-reference.ts:5` `REMOTE_OMP_VERSION`
- `phi-extension/lib/rpc-config.ts:13` `RPC_BOOTSTRAP_OMP_VERSION`
- `rpc/runtime-deployment/manifest.ts:11`(另有 GitHub release URL + sha256)
- `mcp/owned-stdio-transports.ts:14,35`
  ```ts
  const SDK_VERSION = '18.10.3'
  if (VERSION !== SDK_VERSION) throw unsupported()
  ```
- 没有任何测试或构建检查断言这些常量相等

**影响**:升级需同步 4 处源码 + 2 个发布 URL + 若干行为性注释(如 `rpc-entry.ts` 的 expandPath unicode 空格、`rpc-native-wire.ts` 的 Tool 契约)。漏一处是**运行时**失败。最恶劣的是 `owned-stdio-transports.ts:35`:断言落在 MCP stdio 租约上,漏改常量 = 用户侧 MCP 全部失效,错误信息 "Unsupported MCP SDK stdio cleanup API" 与真实原因毫无关系。

**修复方向**:单一来源(从 package.json 读取),CI 加"所有版本断言相等"检查;`SDK_VERSION` 改为构建期校验,运行时只保留能力探测。

#### OMP-14 bun 只打包 2 个平台 ✅

**证据**:`scripts/runtime/fetch-bun.mjs:24` `BUN_PLATFORM_IDS = ['darwin-arm64', 'linux-x64']`;`resources/runtime/bun/` 实际只有 `darwin-arm64`;`electron-builder.yml:149-155` 定义了 `win:` 目标,但 win 下没有 bun `extraResources`(只有 mac/linux 有)。

**影响**:Windows 与 Intel macOS 产物不含 bun,而 worker 必须由 bun 执行(`omp-bridge.ts:185` `spawn(bunPath, [workerPath])`)。这类安装包"装好了但不能用",第一次对话就报找不到 bun。

**修复方向**:平台覆盖与 electron-builder 目标对齐,或在构建期显式失败。

### 3.4 abort 语义

#### OMP-10 远端 abort 不停止后台子代理 📋

**证据**:`rpc/facade-session-driver.ts:1251-1257` `const run = submittedRun; if (run) await runtime!.stop()`;而 `remote-session-runtime.ts:1165-1167` 在 `promptRunId/controller` 为空时直接 `return Promise.resolve()`。`hasActiveAgentRuns()` 允许 `submittedRun` 为空时子代理仍在跑(`facade-session-driver.ts:1015`),只有 `close()` 才遍历 `children.listRuns()` 去 `stopParent`。

**影响**:后台子代理运行时点"停止",一次 RPC 都不发,UI 显示已停止,而远端仍在跑子代理、写 journal、消耗额度。取消语义在主 run 与子 run 之间被硬编码成两套。

**修复方向**:`abort()` 语义改为"停止该会话全部执行",把 `close()` 里的 `stopParent` 循环提取成可单独调用的 `stopAllRuns()`。

---

## 4. SSH / 远程 RPC

> 前置事实:整条 RPC 运行时由 `PHI_REMOTE_OMP_RPC=1` 门控(`src/main/index.ts:1615`),默认远程路径仍是旧的 in-process host-tool 栈。因此**两套远程栈并存**本身就是 SSH-07 的背景。

### 4.1 连接层

见 §2 的 SSH-01。

补充:SSH 参数本身是保守的 —— `BatchMode=yes`、`StrictHostKeyChecking=yes`、`ForwardAgent=no`、`ServerAliveInterval=10` / `CountMax=3`(`remote-ssh-session.ts:128-141`),`ControlPersist=no`(`:234`)。这组参数意味着约 30 秒内检测到断线,同时不保留可复用的 master 通道 —— 与 SSH-01 的"每次轮询新建 master"叠加后,连接开销被进一步放大。

### 4.2 语义层

#### SSH-05 状态机由中文字符串正则驱动 ✅

**证据**
- `src/main/agent/remote-project-connection.ts:40-45`
  ```ts
  if (/SSH.*(?:连接已关闭|命令超时|超时)/i.test(message) && !/调用已取消/.test(message)) {
    return connectionState('offline', 'SSH 连接中断或超时', ...)
  }
  ```
- 失败分支随后 `this.releaseHosts(projectId)`(`:168-172`),释放该项目**全部** host:`remote-registry.ts:239-246`;`SshHost.close()` 置 `disposed = true`
- `workspace-host/remote-session.ts:23-30` 的 `monitored()` 对**任何** error 都调 `onFailure`,包括缺文件、`HASH_MISMATCH` 等域错误
- 远端搜索固定 30 秒超时:`remote-workspace-search.ts:19` `SEARCH_TIMEOUT_MS = 30_000`

**影响**
一次大仓库 `grep` 超过 30 秒就被报成"SSH 连接中断",项目变 offline,helper 与连接被关闭,同项目其他会话的并发操作随即因 `SSH workspace host is closed` 失败。错误分类依赖本地化文案 —— 改一句提示或换 OS 语言就静默改变状态机。用户看到网络故障,服务器其实一直正常。

**修复方向**
引入结构化错误码(`TRANSPORT_LOST` / `TIMEOUT_UNKNOWN` / `DOMAIN_*`),由错误对象而非 message 正则驱动状态机;只有确认传输失效才释放 host。

#### SSH-06 provider / 重试元数据被丢弃 📋

**证据**:`connection.ts:70-88` 已严格解析 `error.retryable`、`provider`、`model`、`httpStatus`;但收口处 `facade-session-driver.ts:1075-1076` 只抛 `new Error('Remote turn failed or approval was denied')`。

**影响**:模型 429/5xx、provider 鉴权失败、审批拒绝在 UI 上完全不可区分;`retryable` 解析后无人使用,自动重试/换模型无法基于真实原因触发。相比本地路径直接抛 provider 错误,这是远程路径的诊断降级。

**修复方向**:定义结构化 turn-failure(`provider_error` / `approval_denied` / `aborted` / `transport`),把 `RpcPromptResult.error` 脱敏后原样上传;UI 按类别给重试入口。

### 4.3 恢复与生命周期

见 §2 的 SSH-03、SSH-04。

#### SSH-03 补充细节 ✅

- `remote-session-runtime.ts:1109-1121`:单次 checkpoint 依次 `verifyCurrent` → journal preflight → `readRemoteHistory` → `assertSafeBrowserHistory` → 第二次 preflight,单 turn 约 20-30 个串行网络操作
- `history-pager.ts:129-130` 默认 `pageSize = 100`、`maxBytes = 64 * 1024 * 1024`;超限抛 `RemoteHistoryError('HISTORY_LIMIT', ...)`
- `session-recovery.ts:416-424` 恢复路径同样全量读,失败即 `options.interrupt(known)`(`:443`)
- `describeRemoteRecoveryFailure` 不识别 `HISTORY_LIMIT`,UI 只显示通用 disconnected

结果是长会话延迟随时长恶化,并在 64MiB 处变成**不可逆的会话报废**:恢复在读历史阶段就失败,连 attach 都到不了,当前 turn 已产生的回复也被丢弃。

#### SSH-11 掉线后远端残留 📋

**证据**:每个 generation 在服务器创建 `rpc-sessions/<nonce>/{home,state,cache,config.json,startup-policy.json}`(`ssh-stdio-factory.ts:240-252,309-318`);唯一清理在 channel close 后经**同一条已断开**的连接执行 `rm -rf`,失败被 `.catch(() => undefined)` 吞掉(`:280-283`);没有启动时扫描/GC。`models.yml` 里留当次模型网关 bearer(`model-proxy-config.ts:63-69`)。

**影响**:每次掉线留下一个会话目录 + 一份过期凭据文件;长期使用在共享 runtime root 里积累孤儿,且没有诊断能看出来。

**修复方向**:会话开始时做带年龄阈值的 `rpc-sessions/*` 清扫;清理拆成"本地登记 + 下次连接补偿";`models.yml` 在生成关闭时显式删除。

### 4.4 信任边界:做对的部分与真正的缺口

**做对的部分(重要,避免误判)**

审批机制本身设计扎实:远端只能提交带 `nonce/projectId/cwd/runId/toolCallId/inputDigest` 的信封(`approval-bridge.ts:144-165`);桌面端用已认证的 execution origin 重算 digest(`execution-authority.ts:188-201`);UI 返回后二次鉴权才允许执行(`approval-bridge.ts:286-304`);`shouldGate` 每次从本地 manifest 读权限模式(`index.ts:1669-1673`)。**没有找到"批准 A 却执行 B"的可利用路径。**

远端启动同样克制:`env -i` 洗环境、`umask 077`、config 带 nonce + contentHash + 版本,上传后校验 sha256(`ssh-stdio-factory.ts:456` 附近)。

#### SSH-07 覆盖面缺口,而不是机制缺口 📋

**证据**
- RPC 路径默认把工具交给远端 OMP:`remote-session-runtime.ts:551-554` `options.nativeTools ?? (['read','write','edit','bash'] as const)`,经 `--tools` 下发(`ssh-stdio-factory.ts:441-445`)
- 审批只覆盖四个工具名:`approval-bridge.ts:66` `new Set(['write','edit','bash','powershell'])`
- 旧路径的 read 必须经 Phi 授权:`remote-workspace-read.ts:306-310` `withAuthorizedRemoteWorkspacePath(...)`
- 同时存在三套字节上限:编辑器 320KB(`shared/workspaceFileOperations.ts:10`)、远程 write 1MiB(`remote-workspace-write.ts:9`)、atomic write 25MiB(`workspace-host/types.ts`)
- 审批桥帧预算耗尽后进入 `exhausted`,对之后所有请求**静默**返回 `cancelled`(`approval-bridge.ts:133-141`)

**影响**:同一个远程项目的 read/write/edit 在 `PHI_REMOTE_OMP_RPC=1` 前后保证不同:realpath 包含检查、read-basis 冲突检测、字节上限都不在链路里,`read/glob/grep` 完全不经过审批。UI 与工具描述完全相同,用户无法知道当前走哪套语义。三套上限还让同一文件得到不同的"文件太大"错误。

**修复方向**:收敛成一套远程工具契约(host tool 或 native tool 二选一),RPC 模式也把文件类工具路由回 `WorkspaceHost`;若必须用 native 工具,至少把包含/上限/审批策略作为可验证的运行时能力声明并在 UI 标注;"审批可用性"做成可见状态,耗尽时显式提示而不是静默 fail-closed。

### 4.5 本地 / 远程一致性

#### SSH-08 symlink 写入语义相反 📋

**证据**
- 本地 `local-fs.ts:274-288` `writePath()` 返回**链接本身**路径,随后 `:454-455` `rename(temporary, target)` → 链接被替换成普通文件
- 远程先 `resolve(..., 'existing')` 得 realpath(`ssh-host-fs.ts:603-617`),写入真实目标;`resolveRemotePathOnSession` 返回 realpath(`remote-workspace-boundary.ts:345-351`)
- 手工保存路径对远程显式拒绝 symlink(`workspace-text-file.ts:154-155`),本地不拒绝,进一步分叉

**影响**:同一个"编辑 config.yaml":本地销毁 symlink 生成普通文件,远程改到链接目标(可能是另一个仓库/共享配置)。既是数据丢失,也是跨环境静默不一致。

**修复方向**:在 `WorkspaceHost.fs` 契约里明确 symlink 策略并在两个实现共用同一套用例;编辑器保存与 read/edit 策略一致。

#### SSH-10 部署互斥只做了一半 📋

**证据**:`runtime-deployment/deployment.ts:20-22` `activeDeployments = new Map()`,仅进程内串行化;而扩展部署有服务器端 flock(`extension-deployment/deploy.ts:108-113` + `remote-lock.ts:70-83`);两者共用同一个 `.omp-<sha>.staging`(`runtime-deployment/remote-commands.ts:37`)。

**影响**:两台桌面机/两个实例指向同一共享 runtime root 时同时写 staging,一方可能在半写状态下做 hash/versionCheck,得到 `HASH_MISMATCH` 或 `mv` 竞态,且失败信息不会指出并发部署。

**修复方向**:运行时部署复用 `acquireOwnedRemoteLock`,或 staging 改为按实例随机 + 原子 rename。

#### SSH-09 known_hosts 解析忽略标记 📋

**证据**:`ssh-bootstrap/host-key.ts:105-118` `const offset = fields[0].startsWith('@') ? 1 : 0` —— 只跳过标记,不区分 `@revoked` / `@cert-authority`;`:120-123` `existing.every((key) => scannedKeys.has(...))` 要求每一种旧算法都被重扫到。

**影响**:`@revoked` 条目让 `inspectTarget` 返回 ready,但真正连接时 OpenSSH 以 revoked 拒绝;服务器关闭 `ssh-rsa` 后 known_hosts 遗留 rsa key 不再出现 → 报"主机密钥已改变"(安全警报),实际只是算法协商变化。两者都会把用户推向手工改 known_hosts 或关闭校验。

**修复方向**:复用 `ssh-keygen -F` / `ssh -G` 的语义;`@revoked` 用专用错误码;比较改为"至少一个已知 key 匹配",算法缺失单独归类。

---

## 5. 跨领域缺陷

### X-01 会话身份有 11 个并行概念 ✅

**证据**(`src/main` + `src/shared` 内出现次数)

| 标识 | 次数 |
| --- | --- |
| `runId` | 916 |
| `phiSessionId` | 672 |
| `generation` | 479 |
| `sessionKey` | 151 |
| `ompSessionId` | 133 |
| `sessionPath` | 81 |
| `approvalId` | 51 |
| `agentSessionId` | 46 |
| `leafId` | 39 |

**影响**:同一个概念实体("这次对话的当前执行")由 5-6 个标识共同表达,每个模块都要正确回答"哪个是权威",且 `sessionKey` 与 `phiSessionId` 之间还存在别名解析(`resolveSessionKeyAlias`)。这类结构是"切会话留下残留状态""后台运行串台"这类 bug 的温床,也和 OMP-12 的静默串话同源。

**修复方向**:确立一个权威标识 + 不可变派生,把"别名解析"集中到单一模块并加不变量断言;新增字段前先回答"它是否能从权威标识推导"。

### X-02 无错误分类体系 ✅

**证据**:`src/main/index.ts` 有 **319 处** `throw new Error(...)`;`src/shared` 内没有任何 Error 类;领域错误(`RemoteRecoveryError`、`RuntimeReferenceError`、`RpcByteLimitError`)只存在于 main 内部,跨 IPC 后只剩 `.message`。

**影响**:渲染层无法用代码表达"可重试 / 需要用户决策 / 不可恢复";所有恢复逻辑退化为文案匹配(OMP-04、SSH-05 都是它的下游表现)。

**修复方向**:建立三层错误模型 —— 共享 `code` 枚举、main 侧领域错误类、IPC 边界的结构化序列化;渲染层按 `code` 决策,`message` 只用于展示。

### X-03 事件落盘在主线程做同步 I/O ✅

**证据**:`session-store.ts:337-357` 每条事件 = `readManifest` + `appendFileSync` + `writeManifest`(格式化 JSON + `renameSync`,见 `manifest-file.ts:51-56`);无合并/批量;36 个调用点。

**核实说明**:已确认 `message_update` 的 token delta **不落盘**(在 `persistSessionEvent` 中提前返回),因此不是"逐 token 同步写"。但工具调用密集时仍会在服务 UI 的主线程上做同步磁盘操作。

**修复方向**:改为队列 + 批量追加;manifest 只做必要的脏标记写;把 `writeManifest` 从热路径移出。

### X-04 无服务层,业务逻辑住在 IPC handler ✅

**证据**:234 个 `ipcMain.handle` 集中在一个文件;例如 notebook cell 执行约 60 行逻辑直接内联在 handler 里(会话状态更新、文档合并、草稿同步、错误分支)。

**影响**:无法在不启动 Electron 的情况下测试业务规则;handler 同时承担校验、编排、持久化、错误转换四种职责。

**修复方向**:与整洁度方案的"按通道域拆分"合并推进 —— 拆出的注册模块只做校验与转发,编排下沉到 `src/main/<domain>/service.ts`。

### X-05 渲染层无路由 ✅

**证据**:`App.tsx` 5,504 行,`App()` 单组件 706-5,503 行,29 个 `useState`、127 个 `useCallback`;`activeView` 用局部状态表达"当前页面"。

**影响**:会话恢复、深链接、"从审批弹窗跳到会话"都靠手工状态编排;组件无法被单独实例化,只能用 AST 断言源码结构来测试(`tests/app-deferred-views.test.ts`)。

**修复方向**:与整洁度方案 §3.2 一致 —— 按状态所有权拆 hook,先补行为测试。

### X-06 架构文档与现实脱节 ✅

**证据**
- 升级计划文档(2026-10-12 基线)记录"约 40 个文件直接 import `@oh-my-pi/*`",实际现在是 **72 个**
- 文档记录"约 20 处内部子路径",实际 **43 个**
- `docs/roadmap/remote-constraint-audit-2026-10-17.md` 在会话开始时存在于目录列表,审计时已不存在;SSH/RPC 侧结论目前无任何书面记录

**影响**:升级 runbook 的"检查 pi-ai / pi-catalog / pi-tui 版本一致"这一步**无法按字面执行** —— 这些包根本没写进 package.json(见 OMP-06)。文档给出的安全感与实际不符。

**修复方向**:文档里的量化基线改成由脚本产出(`check:engine-boundary` 已能统计,把它写进 CI 输出);runbook 步骤必须是可执行命令而不是描述。

### X-07 测试规模与形态 ✅

**证据**:838 个测试文件;**全量 `bun run test` 运行超过 20 分钟仍未结束**(本次实测中止);`tests/main-integration.test.ts` 16,560 行 / 331 个 `test()`;13 个测试文件读取 `src/main/index.ts` 源码文本,其中 2 个用 TypeScript AST 提取 handler 后在沙箱执行。

**影响**:全量测试无法作为每次改动的验证手段(只能按里程碑跑),单切片验证退化为 typecheck(13s)+ 定向测试(秒级);源码形状断言让"移动代码"也会红,需要在搬移时同步改测试。

**修复方向**:按域拆分 `main-integration.test.ts`;源码形状断言逐步替换为行为测试(拆出模块后可直接 import);CI 分片。

---

## 6. 与既有文档的关系

**文档已覆盖,不算新账**
- 本地/远程两套工具实现及 R9 清理计划(`omp-decoupling-upgrade-plan.md` §0.1)
- OMP 升级流程与 runbook(§阶段 5)
- 引擎边界白名单机制(§M1,已实现为 `scripts/check-engine-boundary.mjs`)
- 断线续跑延后到 beta 之后(§非目标)

**文档未覆盖,本次新增**
- SSH-01/02/03/04:轮询风暴、超时即毁通道、64MiB 天花板、断线终态与双写者
- SSH-05/08:中文正则状态机、symlink 语义相反
- OMP-01/02/03/07/08/09:每事件全量快照、worker 生命周期、请求无超时、EPIPE、无握手、版本字面量一致性
- OMP-06 的量化漂移:40→72 文件、20→43 子路径
- OMP-10/12/13、SSH-06/07/09/10/11、X-01…X-07

---

## 7. 处置顺序

### 第一档:止血(低风险,约 1-2 天)

| 顺序 | 项 | 理由 |
| --- | --- | --- |
| 1 | OMP-03 请求加超时 | 把"卡住 = 应用假死"变成"卡住 = 可诊断错误",是后续所有恢复逻辑的前提 |
| 2 | OMP-09 版本单一来源 + CI 断言 | 消除升级必然踩的坑,成本一天内 |
| 3 | X-02 / SSH-05 结构化错误码,替掉中文正则 | 一次改动同时修掉跨请求连锁故障与状态机脆弱性 |
| 4 | OMP-07 stdin EPIPE 监听 | 修法极便宜,消除主进程崩溃面 |

### 第二档:结构(需要设计决定,约 1-2 周)

| 顺序 | 项 | 依赖 |
| --- | --- | --- |
| 5 | SSH-01 会话池 + 前台命令不轮询 | 无 |
| 6 | SSH-02 超时降级为单次调用失败 | 依赖 3(错误模型) |
| 7 | SSH-04 远端 run 登记 + 断线后最佳努力终止 | 正确性问题,双写者风险 |
| 8 | OMP-05 事件契约收敛为 Phi 自有 DTO + 唯一投影 | 与整洁度方案的主进程拆分**互相依赖**,建议先做 |
| 9 | OMP-01 事件流只发增量 + 有界管道 | 依赖 8 |

### 第三档:随版本推进(约 1 个月以上)

OMP-02/04/06/08/10/11/12/13、SSH-03/06/07/08/09/10/11、X-01/03/04/05/06/07。

### 与代码整洁度方案的关系

两份工作有明确交叠,建议按此顺序合并执行:

```
事件契约收口(OMP-05)
  → 主进程按域拆分(X-04 + 整洁度 §3.1)
  → App 组件拆分(X-05 + 整洁度 §3.2)
  → 会话身份收敛(X-01)
```

反过来做会浪费:`persistSessionEvent` 那个 325 行的事件分发 if-chain,在事件契约还是 OMP 镜像时,**拆开也只是把耦合摊薄**,不会真正解耦。

---

## 8. 附录:复现与验证

```sh
# 引擎边界现状(文件数、白名单条目)
node scripts/check-engine-boundary.mjs

# 耦合面量化(与文档基线对比)
grep -rl "@oh-my-pi/" src --include=*.ts | wc -l
grep -rhoE "@oh-my-pi/[a-z-]+/[a-zA-Z0-9/_-]+" src --include=*.ts | sort -u | wc -l

# 幽灵依赖:声明 vs 实际导入
grep -oE '"@oh-my-pi/[a-z-]+"' package.json
grep -rhoE "from '@oh-my-pi/[a-z-]+" src --include=*.ts | sort -u

# 版本字面量分布
grep -rn "18\.10\.3" src/main --include=*.ts

# 错误处理现状
grep -c "throw new Error(" src/main/index.ts
grep -rn "class .*Error" src/shared/*.ts

# SSH 连接放大(轮询间隔与每次新建会话)
grep -n "POLL_INTERVAL_MS" src/main/agent/workspace-host/ssh-host-exec.ts
sed -n '98,108p' src/main/agent/workspace-host/ssh-host-context.ts
```

验证成本基线(实测):`bun run typecheck` 13 秒;3 个涉及 `index.ts` 的定向测试 1.3 秒;全量 `bun run test` 超过 20 分钟。
