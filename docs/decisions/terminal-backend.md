# Phi Terminal V1 后端决策

日期：2026-10-03  
状态：已采用（T3 已验证 macOS arm64 解包产物）

对应计划：[phi-terminal-v1-implementation-plan.md](../design/phi-terminal-v1-implementation-plan.md)

## 决策

Terminal V1 采用 `@oh-my-pi/pi-natives@18.1.10` 的 `PtySession`，并在独立 Bun Worker 中持有 PTY。主进程不得直接加载原生包。关闭和故障清理由独立 Bun 监督者持有 `Process` 稳定引用并执行。

这是后端能力的 **GO**。T3 已将 `pi-natives` 直接固定为 18.1.10，复制并解包 Terminal Worker 及其相对 import 闭包，同时解包 Bun 可解析的 JS 包装层和平台二进制。开发路径、`out/` 和移出源码树的 unpacked app 现在均有实际运行证据；这不扩大为签名、公证或其他平台的结论。

## 真机证据

环境：macOS arm64、Bun 1.3.14、`@oh-my-pi/pi-natives` 18.1.10。命令为 `bun run spike:terminal-pty`；`PASS` 检查全部通过，进程退出码为 0。以下是执行 `bun run build:unpack` 后的完整输出：

```text
PASS env-semantics env replaces inherited worker values; PHI_SPIKE_LEAK=false PI_CODING_AGENT_DIR=false keys=115
PASS login-path PATH=/Users/example/.kimi-code/bin:/Users/example/.bun/bin:/Users/example/.opencode/bin:/opt/homebrew/opt/postgresql@15/bin:/opt/homebrew/opt/postgresql@15/bin:/opt/homebrew/opt/postgresql@15/bin:/Users/example/.codeium/windsurf/bin:/Users/example/miniconda3/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/opt/X11/bin:/Applications/quarto/bin:/Users/example/.local/bin:/Users/example/.cargo/bin:/Users/example/.modular/bin; rebuiltFromMinimal=true
PASS tty stdin=true stdout=true
PASS stty-size before=30 100 after=40 120 pid=88003 unchanged=true
PASS state-persist cwd=/var/folders/4n/zt5jjl7n237d_phyc6k91s_40000gn/T/phi-terminal-pty-XLBpag/persisted-cwd FOO=bar across separate writes
PASS utf8 bytes=32000 chunks=350 replacement=false codePointSplit=false
PASS interactive-read separate input line returned got:interactive-value
PASS ctrl-c recoveredMs=59.6 shellAlive=true pid=88160
PASS flood-ctrl-c stopMs=14.1 chunksPerSec=67578 totalMiB=336.6 retainedMiB=2.0 droppedMiB=334.6 rssGrowthMiB=59.6
INFO no-pause PtySession methods=kill,resize,start,startArgv,write,constructor; always drain onChunk into 2MiB replay ring and emit a gap marker when oldest bytes are dropped
PASS exit PtyRunResult={"cancelled":false,"timedOut":false,"exitCode":7} keys=cancelled,exitCode,timedOut
PASS close-graceful killAloneLeft=0/2 terminateResult=true tracked=3 gone=true elapsedMs=2101.2
PASS close-quit-budget shells=3 tracked=6 elapsedMs=999.9 budgetMs=1500
INFO job-control-group shellGroup=88587 childGroup=88627 separate=true groupTerminateReachedChild=true
PASS worker-crash registeredPid=88649 childRefs=1 cleanupMs=2.4 masterCloseAutoExit=true autoExitMs=2.2 rootTerminateResult=true rootRefReachedChildren=false retainedChildFallback=1 unregisteredPid=88637 remainedAlive=true signalledOnlyRegistered=true
INFO packaging resources=/Users/example/Downloads/Work/App/Phi-worktrees/terminal-v1/dist/mac-arm64/pi-desktop.app/Contents/Resources worker=false wrapper=false nativeBinary=true; current config cannot run an unpacked Bun terminal worker unless all three are unpacked; pin direct @oh-my-pi/pi-natives=18.1.10
```

`PtyRunResult` 的实测形状为 `{ cancelled, timedOut, exitCode }`，正常 `exit 7` 得到 `exitCode: 7`。`onStart` 给出的 PID 在 resize 前后不变。32,000 字节中文与 emoji 输出没有 U+FFFD，也没有观察到 Unicode code point 被回调分块切开。

## 环境语义

`PtySession.startArgv({ env })` 在本机实测为**替换** Worker 环境，而不是合并。向 Worker 注入的 `PHI_SPIKE_LEAK=1` 和 `PI_CODING_AGENT_DIR=/tmp/leak` 均未进入 Shell，因此不需要 `/usr/bin/env -i` 后备层。

传入环境必须继续由白名单正向构造：`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`LC_*`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`SSH_AUTH_SOCK`，加固定的 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Phi` 和最小 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`。只在 `LANG` 缺失时补 `en_US.UTF-8`。本机登录 Shell 随后通过用户配置重建了 PATH；这是用户 Shell 的行为，不是从 Phi Worker 泄漏环境。

## 输出与流控

公开 `PtySession` 没有 pause/resume。V1 不得再承诺在 ACK 高水位暂停内核 PTY 读取。Worker 必须始终消费 `onChunk`，按 UTF-8 字节计数写入每终端 2 MiB 有界环形缓冲；缓冲满时丢弃最旧内容并累计丢弃字节。Renderer/主进程未消费时停止继续转发 live 数据，但不能停止 drain；重新 attach 时发送明确的 gap 标记后从保留区继续。

3 秒 `yes` 压测产生 336.6 MiB，缓冲保留 2.0 MiB、丢弃 334.6 MiB，Worker RSS 增长 59.6 MiB；Ctrl+C 后最后输出延迟 14.1 ms，低于 1 秒门槛。T3 又使用真实 Manager、Host、Worker 和 Supervisor 完成两组 30 秒压测：断连输出在 credit 耗尽后确实停止协议转发，Worker RSS 增长 181.7 MiB；随后单独做了 3 分钟断连 `yes` 探针，RSS 在前 10 秒升至约 235 MiB（起点约 62 MiB），之后 170 秒内只再增加约 6 MiB 并保持平台期，判定为高速字符串流下的 GC 余量而非泄漏，压测门槛据此设为 320 MiB，主进程堆增长 0.9 MiB；重连返回 gap、2,097,152 字节重放和 69 个连续且不重复的 replay/live seq。ACK 消费路径在 15 秒中点回显输入，30 秒后 Ctrl+C 到输出安静为 65.3 ms。

`bun run smoke:terminal-stress` 的完整 PASS 输出（进程 ID 仅用于本次证据）：

```text
PASS terminal-stress-disconnected durationMs=30000 dataEvents=24 protocolBytes=513367 plateauTailEvents=0 workerPid=67189 workerRssStartMiB=61.8 workerRssPeakMiB=243.5 workerRssGrowthMiB=181.7 workerRssLimitMiB=200.0 mainHeapStartMiB=2.9 mainHeapPeakMiB=3.8 mainHeapGrowthMiB=0.9 mainHeapLimitMiB=128.0
PASS terminal-stress-reattach gap=1-119773 droppedBytes=3924448599 replayBytes=2097152 replayLimitBytes=2097152 sequences=69 staleAckHostCreditCalls=0 validAckBytes=524288 currentAckHostCreditCalls=1 floodStopMs=0.4 acknowledgedBytes=2121137 drainToLiveMs=568.3 liveSentinelMs=50.6
PASS terminal-stress-acked durationMs=30000 midpointMs=15000 dataEvents=127929 protocolMiB=3997.7 typedEchoMs=0.6 queuedSentinelMs=48.7 outputStopMs=65.3 ackBatchBytes=32768 ackBatchDelayMs=16
PASS terminal-stress-worker-crash worker=67310 epoch=1 shell=67413 hupIgnoringChild=67465 cleanupMs=10.7 failedState=true unhandledRejections=0 recreatedTerminal=J_bIJd7SkN_Vg7eVcfsteQ recreatedEpoch=1
PASS terminal-stress-supervisor-crash supervisor=67311 existingPty=67477 existingPtyKilledMs=11.0 createUnavailable=true disposeMs=2.6 bun=/Users/example/.bun/bin/bun absoluteBun=true
```

## 生命周期与监督

- 用户结束：创建时从 `onStart` PID 立即取得 `Process`，调用 `terminate({ group: true, gracefulMs: 2000, timeoutMs: 5000 })`。带忽略 SIGHUP 前台子进程和普通后台子进程的实测清理为 2101.2 ms，全部退出。
- 应用退出：所有已登记终端并行调用 `terminate({ group: true, gracefulMs: 900, timeoutMs: 400 })`。三个带忽略 SIGHUP 前台子进程的 Shell 共用 999.9 ms，满足 1.5 秒预算。
- `PtySession.kill()` 单独测试未留下已观察到的两个子进程，但正式路径仍使用 `Process` 的有界树清理，以获得明确超时与结果。
- job-control 子进程拥有不同进程组，`terminate({ group: true })` 仍通过进程树到达它。本结论不涵盖 `nohup`、`disown`、`setsid` 或已经重归属的进程。
- Worker 被 SIGKILL 后，PTY master 关闭使 Shell 在 2.2 ms 内自行退出；但此时只对已退出的根 `Process` 再调用 group terminate，虽返回 `true`，**没有**到达忽略 HUP 的前台子进程（`rootRefReachedChildren=false`）。测试通过的原因是监督者在故障前已从可信根引用取得并保留子进程稳定引用，然后只对这些登记引用执行后备终止。未登记的控制 Shell 保持存活且没有被信号触碰。

因此，计划中“只登记根 `Process` 引用即可覆盖 Worker 崩溃”的说法不成立。监督者需要保存根引用，并在 Worker 存活期间从该根维护已验证的后代稳定引用集合；崩溃时终止根和所有已登记后代。不能在崩溃后按 PID 扫描系统。刚创建、尚未来得及登记就与 Worker 同时崩溃的 HUP-ignoring 后代仍存在竞态，T1/T3 若不能通过更强的创建归属或监督协议消除该竞态，就必须缩小清理保证，不能宣称任意后代必定清除。

## 打包结论

`bun run build:unpack` 成功。构建产物确认：

- `package.json` 直接、精确固定 `@oh-my-pi/pi-natives: "18.1.10"`。
- `electron.vite.config.ts` 把 `src/main/terminal/` 及共享终端类型复制到 `out/`；`electron-builder.yml` 解包 `out/main/terminal/**`、`out/shared/terminalTypes.ts`、`node_modules/@oh-my-pi/pi-natives/**` 和目标平台包。OMP 的解包条目未由本任务修改。
- Finder 风格的最小 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 下，宿主不再依赖 `spawn('bun')`，而是按固定优先级解析可执行的 Bun 绝对路径。本次从 `HOME` 找到 `/Users/example/.bun/bin/bun`。
- app 复制到源码树外的 `/private/tmp/phi-pack-check.QwVPgb/`后，真实 Host 从复制产物的 `app.asar.unpacked/out/main/terminal/` 启动 Worker 和 Supervisor；Shell 回显、`37x113` resize 和关闭全部通过。`lsof` 确认 Worker 加载的唯一 `pi_natives.darwin-arm64.node` 位于复制 app 内，没有指向源码仓库。

`bun run smoke:terminal-packaged -- /private/tmp/phi-pack-check.QwVPgb/pi-desktop.app` 输出：

```text
PASS terminal-packaged app=/private/tmp/phi-pack-check.QwVPgb/pi-desktop.app bun=/Users/example/.bun/bin/bun worker=58877 shell=58880 echo=true size=37x113 native=/private/tmp/phi-pack-check.QwVPgb/pi-desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node
```

## 计划契约变更

1. 删除“高水位暂停 PTY、低水位恢复”的要求，改为“始终 drain + 有界 replay + 停止 live 转发 + gap 标记”。ACK 只控制应用层转发和重放窗口，不控制原生 PTY 读取。
2. Worker crash 清理不能只保留根 `Process`。必须保留由可信根派生的稳定后代引用；根退出后的 `terminate({ group: true })` 返回值不能当作后代已退出证明。
3. `PtySession.kill()` 是强制关闭工具，不是唯一的生命周期契约；正常关闭和退出预算使用 `Process.terminate`，并逐个检查已登记引用的退出状态。
4. 打包验收必须在开发工作树之外进行，以排除向上解析到源码 `node_modules` 的假阳性。

## 未验证范围

Linux、Windows/ConPTY、x64 macOS、签名/公证安装包和正式安装器启动仍未验证；手动 UI 项继续留在 `terminal-v1-manual-checklist.md`，不因本次自动证据标记通过。输出压测已扩展到本机两组 30 秒 `yes`，但仍不证明任意负载或任意时长的上界；Worker 在持续高速输出时约有 180 MiB 的 GC 余量；所有终端共用一个 Worker 堆，该开销不按终端数线性叠加，但仍未在 8 个终端同时刷屏时实测。用户特意 `disown`、`setsid`、重归属，以及 Worker 崩溃前不足一个 Supervisor 刷新周期就新建的后代，不在清理保证内。当前打包结论仅覆盖移出工作树的 macOS arm64 unpacked app，不等同于已验证公开分发。
