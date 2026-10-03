# Phi Terminal V1 后端决策

日期：2026-10-03  
状态：有条件采用  
对应计划：[phi-terminal-v1-implementation-plan.md](../design/phi-terminal-v1-implementation-plan.md)

## 决策

Terminal V1 采用 `@oh-my-pi/pi-natives@18.1.10` 的 `PtySession`，并在独立 Bun Worker 中持有 PTY。主进程不得直接加载原生包。关闭和故障清理由独立 Bun 监督者持有 `Process` 稳定引用并执行。

这是后端能力的 **GO**，不是现有安装包已经可用的结论。进入功能实现前仍须把 `pi-natives` 固定为直接依赖、复制并解包 Terminal Worker 及其源码依赖、解包 Bun 可解析的 `pi-natives` JS 包装层和平台二进制。当前 unpacked app 缺少前两者，不能从安装包运行 Terminal Worker。

## 真机证据

环境：macOS arm64、Bun 1.3.14、`@oh-my-pi/pi-natives` 18.1.10。命令为 `bun run spike:terminal-pty`；`PASS` 检查全部通过，进程退出码为 0。以下是执行 `bun run build:unpack` 后的完整输出：

```text
PASS env-semantics env replaces inherited worker values; PHI_SPIKE_LEAK=false PI_CODING_AGENT_DIR=false keys=115
PASS login-path PATH=/Users/dengxsh/.kimi-code/bin:/Users/dengxsh/.bun/bin:/Users/dengxsh/.opencode/bin:/opt/homebrew/opt/postgresql@15/bin:/opt/homebrew/opt/postgresql@15/bin:/opt/homebrew/opt/postgresql@15/bin:/Users/dengxsh/.codeium/windsurf/bin:/Users/dengxsh/miniconda3/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin:/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin:/pkg/env/global/bin:/opt/X11/bin:/Applications/quarto/bin:/Users/dengxsh/.local/bin:/Users/dengxsh/.cargo/bin:/Users/dengxsh/.modular/bin; rebuiltFromMinimal=true
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
INFO packaging resources=/Users/dengxsh/Downloads/Work/App/Phi-worktrees/terminal-v1/dist/mac-arm64/pi-desktop.app/Contents/Resources worker=false wrapper=false nativeBinary=true; current config cannot run an unpacked Bun terminal worker unless all three are unpacked; pin direct @oh-my-pi/pi-natives=18.1.10
```

`PtyRunResult` 的实测形状为 `{ cancelled, timedOut, exitCode }`，正常 `exit 7` 得到 `exitCode: 7`。`onStart` 给出的 PID 在 resize 前后不变。32,000 字节中文与 emoji 输出没有 U+FFFD，也没有观察到 Unicode code point 被回调分块切开。

## 环境语义

`PtySession.startArgv({ env })` 在本机实测为**替换** Worker 环境，而不是合并。向 Worker 注入的 `PHI_SPIKE_LEAK=1` 和 `PI_CODING_AGENT_DIR=/tmp/leak` 均未进入 Shell，因此不需要 `/usr/bin/env -i` 后备层。

传入环境必须继续由白名单正向构造：`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`LC_*`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`SSH_AUTH_SOCK`，加固定的 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Phi` 和最小 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`。只在 `LANG` 缺失时补 `en_US.UTF-8`。本机登录 Shell 随后通过用户配置重建了 PATH；这是用户 Shell 的行为，不是从 Phi Worker 泄漏环境。

## 输出与流控

公开 `PtySession` 没有 pause/resume。V1 不得再承诺在 ACK 高水位暂停内核 PTY 读取。Worker 必须始终消费 `onChunk`，按 UTF-8 字节计数写入每终端 2 MiB 有界环形缓冲；缓冲满时丢弃最旧内容并累计丢弃字节。Renderer/主进程未消费时停止继续转发 live 数据，但不能停止 drain；重新 attach 时发送明确的 gap 标记后从保留区继续。

3 秒 `yes` 压测产生 336.6 MiB，缓冲保留 2.0 MiB、丢弃 334.6 MiB，Worker RSS 增长 59.6 MiB；Ctrl+C 后最后输出延迟 14.1 ms，低于 1 秒门槛。该结果证明本次负载下的替代策略可行，不证明 JS 事件循环被长时间阻塞时的原生内部队列，也不证明超过 3 秒的任意负载上界；T3 仍需做断连、阻塞和更长时间的集成压测。

## 生命周期与监督

- 用户结束：创建时从 `onStart` PID 立即取得 `Process`，调用 `terminate({ group: true, gracefulMs: 2000, timeoutMs: 5000 })`。带忽略 SIGHUP 前台子进程和普通后台子进程的实测清理为 2101.2 ms，全部退出。
- 应用退出：所有已登记终端并行调用 `terminate({ group: true, gracefulMs: 900, timeoutMs: 400 })`。三个带忽略 SIGHUP 前台子进程的 Shell 共用 999.9 ms，满足 1.5 秒预算。
- `PtySession.kill()` 单独测试未留下已观察到的两个子进程，但正式路径仍使用 `Process` 的有界树清理，以获得明确超时与结果。
- job-control 子进程拥有不同进程组，`terminate({ group: true })` 仍通过进程树到达它。本结论不涵盖 `nohup`、`disown`、`setsid` 或已经重归属的进程。
- Worker 被 SIGKILL 后，PTY master 关闭使 Shell 在 2.2 ms 内自行退出；但此时只对已退出的根 `Process` 再调用 group terminate，虽返回 `true`，**没有**到达忽略 HUP 的前台子进程（`rootRefReachedChildren=false`）。测试通过的原因是监督者在故障前已从可信根引用取得并保留子进程稳定引用，然后只对这些登记引用执行后备终止。未登记的控制 Shell 保持存活且没有被信号触碰。

因此，计划中“只登记根 `Process` 引用即可覆盖 Worker 崩溃”的说法不成立。监督者需要保存根引用，并在 Worker 存活期间从该根维护已验证的后代稳定引用集合；崩溃时终止根和所有已登记后代。不能在崩溃后按 PID 扫描系统。刚创建、尚未来得及登记就与 Worker 同时崩溃的 HUP-ignoring 后代仍存在竞态，T1/T3 若不能通过更强的创建归属或监督协议消除该竞态，就必须缩小清理保证，不能宣称任意后代必定清除。

## 打包结论

`bun run build:unpack` 成功。构建产物确认：

- `pi-natives` 目前只是 `@oh-my-pi/pi-coding-agent@18.1.10` 等包的间接依赖；选定后必须在 `package.json` 直接、精确固定为 `@oh-my-pi/pi-natives: "18.1.10"` 并更新 `bun.lock`。
- 原生文件位于 `node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node`；electron-builder 自动把该平台包放进了 `app.asar.unpacked/node_modules`。
- `@oh-my-pi/pi-natives/native/index.js` 仍在 `app.asar`，没有进入 `app.asar.unpacked`。现有 Worker 也仍在 `app.asar`；当前 `asarUnpack` 的 `out/main/agent/omp-sdk-worker.ts` 与实际 `out/main/agent/omp/omp-sdk-worker.ts` 不匹配。
- T0 没有生产 Terminal Worker，故 unpacked app 中不存在 `out/main/terminal/terminal-worker.ts`，无法诚实地从该位置运行 spike Worker。位于源码工作树内部的 app 会向上误解析到开发目录 `node_modules`，这种“成功”不能作为打包证据。

后续实现需要在 `electron.vite.config.ts` 把 Terminal Worker 及它的相对 import 闭包复制到 `out/main/terminal/`；在 `electron-builder.yml` 解包 `out/main/terminal/**`、`node_modules/@oh-my-pi/pi-natives/**` 和目标平台的 `node_modules/@oh-my-pi/pi-natives-*/**`。完成后必须把 app 移到开发工作树之外，再从 `Contents/Resources/app.asar.unpacked/out/main/terminal/` 启动 Bun Worker，证明它只从同一 unpacked 根解析包装层和 `.node` 文件。

## 计划契约变更

1. 删除“高水位暂停 PTY、低水位恢复”的要求，改为“始终 drain + 有界 replay + 停止 live 转发 + gap 标记”。ACK 只控制应用层转发和重放窗口，不控制原生 PTY 读取。
2. Worker crash 清理不能只保留根 `Process`。必须保留由可信根派生的稳定后代引用；根退出后的 `terminate({ group: true })` 返回值不能当作后代已退出证明。
3. `PtySession.kill()` 是强制关闭工具，不是唯一的生命周期契约；正常关闭和退出预算使用 `Process.terminate`，并逐个检查已登记引用的退出状态。
4. 打包验收必须在开发工作树之外进行，以排除向上解析到源码 `node_modules` 的假阳性。

## 未验证范围

Linux、Windows/ConPTY、x64 macOS、签名/公证安装包均未验证。输出压测只覆盖约 3 秒持续输出；用户特意 `disown`、`setsid` 或重归属的进程不在清理保证内。当前 build 只证明缺口和平台二进制位置，没有证明修正配置后的 Terminal Worker 可以在最终安装包加载；这必须由后续打包改动补测。
