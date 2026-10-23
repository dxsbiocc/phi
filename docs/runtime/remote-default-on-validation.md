# 远程 RPC 默认开启验证清单

对应 [omp-decoupling-upgrade-plan.md §6.5](../roadmap/omp-decoupling-upgrade-plan.md) 的三个未勾选项。
三项全部完成后才讨论把 `PHI_REMOTE_OMP_RPC` 改为默认开启；自动化门禁与历史验收见
[omp-remote-acceptance.md](omp-remote-acceptance.md)。

## 候选与前置

- 候选提交（干净工作区）：`<HEAD>`
- 启动方式：`PHI_REMOTE_OMP_RPC=1 npm run dev`，或同候选的构建包
- SSH 主机：`~/.ssh/config` 中的别名 `<host>`
- 模型：真实 provider 账号，不是合成 loopback
- 回执目录：`.phi-acceptance/receipts/<date>-default-on/`

> 不设置 `PHI_REMOTE_OMP_RPC=1` 时仍走旧路径；以下检查都在显式启用下进行。
> 验证必须绑定一个干净提交；未提交改动会让回执无法复现。

## 预检记录

- 2026-10-21 GPU R8：`baae03c8` 三场景通过（27.3s；prepare 10.8s / 21 条命令），回执
  `.phi-acceptance/receipts/2026-10-21T09-17-16-926Z-GPU-r8-a78cf840-0cea-4948-8fd6-9e43ebf40441.json`。
  覆盖真实 SSH、生产启动事务、审批、子智能体与断线恢复；不覆盖真实模型和 Notebook/Wrapper，
  所以不能替代下面三项。

## 1. 真实模型账号的远程对话

1. 显式设置 `PHI_REMOTE_OMP_RPC=1` 启动应用。
2. 新建或打开一个远程 SSH 项目，确认项目绑定 `ssh-config:<host>`，会话使用远端 anchor。
3. 选择一个真实 provider 模型，发一条需要读文件并执行命令的请求。
4. 完成一次编辑/命令审批，确认工具在服务器上执行，结果写入会话时间线。
5. 退出并重启应用，重新打开该会话，确认历史完整且没有把旧远程历史静默改到本机执行。

记录：provider/model、runId、审批 requested/approved 事件、工具结果、恢复结果；不要记录凭据。
通过标准：一次完整对话由真实模型驱动；审批与工具都落在远程；重启后可恢复。

## 2. 当前代码在实机跑通 Notebook 或 Wrapper

二选一即可，优先 Notebook。

**Notebook**

1. 在远程项目中打开一个 `.ipynb`，启动远程 Jupyter（首次会准备环境）。
2. 运行一个带文本输出的单元格，确认输出回到 Notebook 文档。
3. 保存文件，重启应用后重新打开，确认单元格与输出可读。
4. 记录：runtime root、`serverLabel`、启动耗时与远程命令数、执行结果。

**Wrapper**

1. 在远程项目中提交一个 Wrapper plan，确认 plan 与 run 记录绑定远程项目。
2. 审批后执行，确认 step 状态推进、输出可浏览或下载。
3. 记录：plan/run id、step 状态、输出路径、失败时的错误分类。

通过标准：当前候选（不是旧版本 GPU 记录）在真实主机上完成一次 Notebook 或 Wrapper 闭环，没有回退本机执行。

## 3. 人工远程界面与 SSH-01/04 第 2–4 项

| 检查 | 操作 | 通过标准 |
|---|---|---|
| 远程项目 | 新建 SSH 项目，打开会话 | anchor 正确，会话绑定项目，无本地路径回退 |
| 对话与审批 | 发一条 read/write/bash 请求，逐次审批 | 审批有 requested/approved 记录，服务器副作用可见 |
| 会话切换 | 在两条已连接的远程会话之间往返切换 | 已连接的 OMP 会话保持存活；切换不额外启动 SSH 项目探测或重发任务；过期恢复查询不在主进程打印异常 |
| 断线恢复 | 对话中杀掉 SSH 连接，再点击侧边栏会话尝试连接；若会话仍已选中，使用“恢复原会话” | 旧会话失败且不重放；恢复后代次/同一 journal，历史不变 |
| 远程会话删除 | 新建一次性远程会话并确认删除；再断网尝试删除另一条测试会话 | 已确认删除只移除对应服务器会话目录和本地索引，不影响同项目其他会话；断网时本地记录保留、前端显示警告消息，主进程不打印预期连接异常 |
| SSH-01/04 #2 | 启动持久会话后检查 `run.record`、进程组与锁 | 权限 600；pid = pgid；argv0 是部署的 OMP；OMP 存活时 `flock -n run.lock` 失败 |
| SSH-01/04 #3 | 长 bash 运行时只断 SSH，恢复后检查旧进程 | OMP 仍存活；旧进程组收到 TERM（10s 后 KILL）；新 OMP 启动；时间线提示“已停止上一次未结束的远端运行”；journal 只有一个写者 |
| SSH-01/04 #4 | 篡改 `run.record` 的 pgid，或让无关进程持锁 | 不杀进程，报“该会话仍被另一个进程占用” |

SSH 检查可沿验收记录中的命令执行，路径中的 runtime root 与 session id 以实际回执为准。
通过标准：上表全部通过并留下回执；不接受只测自动化、不测界面的结论。

## 进度（2026-10-21，GPU）

- ✅ 真实模型远程对话：`cursor / cursor-grok-4.6-fast`，Phi 会话
  `63201ad3-a48b-4f1c-9ab6-3c61cf2d5b6d`，run `c43070a9-...`，10 次远程工具调用后
  `run_completed`；远端 journal 记录同一模型，项目根 `/data2/dengxsh/phi-test`。
- ✅ 当前代码跑通 Notebook：GPU 远程项目 `quicksort.ipynb` 执行单元格，保存后
  `execution_count` 为 1/2、输出 `all cases passed`，文件 mtime `2026-10-21 17:44:02`；
  应用重启后重新打开仍能显示单元格与输出。
- ✅ SSH-01/04 #2：`run.record` 600、pid = pgid = 2080448、argv0 为 OMP 18.10.3，
  `flock -n run.lock` 失败（锁被持有）。
- ✅ 审批与远程写入：项目切到 `ask` 后，bash/write/bash 三次 `approval_requested` 与
  `approval_approved` 成对出现；远端 `.phi-validation.txt` 权限 600、内容 `ok`，
  run `completed`。
- ⏳ 待做：断线恢复、SSH-01/04 #3/#4。

## 进度（2026-10-23，yzhang-node3）

- ✅ 干净候选 `98a8508d` 在 node3 与 GPU 的 R8 三场景均通过：远端原生工具与审批、阻塞子任务、
  SSH 主连接丢失后显式恢复同一 journal；两台主机各 3 条反向隧道均关闭，SSH/RPC 进程和自有目录清理确认。
  回执分别为 `.phi-acceptance/receipts/2026-10-23T07-18-07-411Z-yzhang-node3-r8-5c3890e1-a56c-442c-a7fc-1dc35af30367.json`
  和 `.phi-acceptance/receipts/2026-10-23T07-21-01-732Z-GPU-r8-3b05dfe6-d9ab-4985-ae65-a40d828fa48e.json`。
- ✅ 最终候选 `98a8508d` 的 `npm test`：7771 项中 7745 通过、0 失败、25 跳过、1 待办；
  `npm run build`、主代码类型检查和 RPC bootstrap 安全套件 13/13 通过。
  Cursor 子任务的受限原生路由、流恢复、停止、并行和排队取消组合测试 16/16 通过；
  Office Notebook 工具示例已更新为实际下划线名称。
- ✅ 同一修复快照 `c7b10aa2` 的 R8 三场景通过：原生工具、阻塞子代理、SSH 中断后恢复；
  回执 `.phi-acceptance/receipts/2026-10-23T01-38-18-871Z-yzhang-node3-r8-26b4512d-f1f5-436e-9f8c-2dfb4a0ecc86.json`，
  清理项全部确认。GPU 同快照 R8 回执在同目录，前缀 `2026-10-23T01-26-32-227Z-GPU`。
- ✅ 真实 `deepseek/deepseek-flash` 经当前源码的 Phi 模型网关和 SSH 反向隧道，在 node3
  的一次性项目上完成 `read validation.txt`（`ok`）与 `bash pwd`，两次工具结果均成功回传。
  这是模型与远程链路的实测，**不代替**上文第 1 项的 Phi 应用会话、审批及重启恢复。
- ✅ 首次安装因发布包下载失败；从已安装的官方 18.10.3 Linux 二进制按锁定 SHA-256
  校验并复用后，R8 安装成功。Phi 正式本机缓存已用生产读取函数验证命中，避免此主机重复下载。
- ⚠️ 当前 Mac 直连官方 GitHub 发布包的 HEAD 探测在 15 秒内未收到任何字节；
  node3 直连同一发布包的 HEAD 探测也在 15 秒内未收到字节（HTTP 000）。
  上述缓存解决本机后续安装，不证明一台没有缓存的新桌面也能完成首次下载。
  GitHub 官方发布 API 可返回该资产，前 1 KiB 与锁定缓存一致，但实测约 30 秒仅取得 1.9 MB，
  完整 276 MB 下载未完成，不能据此声称冷启动可用。
  已提供并用全新临时缓存实测 [x64 安装前置](remote-omp-preseed.md)：哈希命中、0 次网络请求；
  面向新桌面的默认开放前仍需在目标机器完成这项前置或证明官方完整下载可用。
- ✅ 源码版 Phi（`localhost:5173`、显式 `PHI_REMOTE_OMP_RPC=1`）中的 node3 项目
  `ceb987e6-bee7-43cc-a6c7-6df063a2bfc1`，真实 DeepSeek V4.1 Flash 会话
  `7ea67f96-8ee0-4466-a498-2b09f144b6fa`：`read validation.txt` 回复 `ok`
  （run `fd9fd3fa-4813-4cfc-825d-c69f94f9d28c`）；`bash pwd && cat validation.txt`
  与 `write phi-acceptance-write.txt` 均在询问模式弹窗中批准，分别由 run
  `744a0974-ad78-4ae7-b103-ce3fcf06da87` 与 `0d348220-4359-46c8-ba89-d16b50efc859`
  完成；审批 requested/approved 成对写入日志。远端文件为 `node3-write-ok\n`。
- ✅ 同项目 `smoke.ipynb` 在 Phi 界面执行 Python cell，远端文件记录
  `execution_count=1`、stdout `node3 notebook ok\n`。Jupyter 首次启动在一次端口拒绝后自动清理
  并重试，70 秒就绪；使用服务器已有 Jupyter 2.14.1。源码应用重启后原 journal ID
  `01a1667d-54d4-7321-8f87-4a1c3cd9b085` 保持不变，历史、远端文件与 Notebook
  输出均重新读回。两条已连接的远程会话间往返切换后无需重连。
  最终候选同步到源码版 Phi 并重启后再次运行该单元格：界面显示本次 16:04:39 执行、
  stdout `node3 notebook ok\n`、kernel 回到空闲；远端 `smoke.ipynb` 于 16:04:53 自动保存，
  新 kernel 的 `execution_count=1`。测试后已在 Phi 界面停止此次 Jupyter server。
- ✅ SSH-01/04 #2：上述会话的 `run.record` 与 `run.lock` 均为 600；OMP PID/PGID
  均为 76291，`argv0` 为部署的 18.10.3 OMP，`flock -n run.lock` 失败。
- ⚠️ SSH-01/04 #3：第二条真实 Phi 会话 run `85eae59e-cc40-4cc8-8ecd-94b006c35f60`
  已批准 `sleep 600` 并进入 `tool_call_started`；杀掉其独占 SSH master 后，本地以
  `TRANSPORT_LOST` 失败且没有重发。node3 的旧 OMP 与长命令随 SSH 通道退出，锁释放；
  显式恢复同一 journal 成功。此实测覆盖“旧运行退出”分支，**没有**覆盖清单要求的
  “OMP 存活、恢复时 TERM/KILL 旧进程组”分支；该项仍未通过。
- ✅ node3 上另用隔离的持久进程验证存活接管分支：按源码 `buildRunGuardWrapper` 建立
  0600 记录与真实 Linux `flock`，源代码 `runRpcStartupTransaction` 在新 SSH 连接中
  验证 PID/PGID/argv0/nonce 后接管旧 PID 69390，返回 `status=ready`；测试进程和目录
  已清理。这证明接管算法在 node3 可运行，但不能替代上一项要求的真实 OMP 界面时间线。
- ✅ 真实 OMP 存活接管界面分支：在保留的 node3 会话 `50758880-...` 上，用官方
  OMP 18.10.3 建立脱离 SSH 通道的 PID/PGID 46070，核对真实可执行文件、nonce、
  `run.record` 和独占 `run.lock`；源码版 Phi 恢复时旧进程退出，新 PID 74269 持锁，
  `remote_run_stopped` 恰好一次写入本地历史。发现界面缓存未吸收无前台 run 的提示，
  已修复恢复及会话切换时的缓存合并；真实界面显示一次“已停止上一次远端运行”，
  切走再切回仍可见，原聊天记录保留。测试临时目录已清理，回执
  `.phi-acceptance/receipts/2026-10-23-node3-real-omp-survivor-50758880.json`。
  此次持锁 OMP 使用隔离测试 journal，并未保持一条执行中的长 Bash；该细分行为未验。
- ✅ SSH-01/04 #4：在第二条会话目录由无关进程持有 `run.lock` 时，Phi 拒绝连接，
  无关进程保持存活。源码修复后界面明确显示“该会话仍被另一个进程占用；Phi 没有终止该进程”；
  移除测试进程后同一 journal 恢复成功。
- ✅ 在线远程会话删除：前两次一次性会话删除在 node3 的 NFS 上失败，原因是删除命令
  仍持有 `lease.lock`/`run.lock` 的文件句柄；NFS 把被删锁文件改名为 `.nfs*`，
  `rm -rf` 因目录非空失败，本地索引按设计保留。已在同一挂载上复现并验证“持锁改名
  → 关闭句柄 → 删除隔离目录”顺序。新源码下的完整首删会话
  `39b1016c-6c25-4a5f-bdaa-308e9d0d2fcf` 一次确认后从 Phi、本地和 node3 同时消失，
  无 `.deleting-*` 残留；另外两条 node3 会话仍在。删除事务也已改用独立 SSH 连接。
  相关 17 项测试通过。
- ✅ 断网删除的人工界面场景通过：一次性会话 `8d5d3b52-2212-4c6a-a94c-96ef531e8b99`
  先由 DeepSeek `read` 得到 `ok\n`；确认删除时只杀两条新建 node3 SSH master，Phi 显示
  “无法确认服务器上的删除结果。本地会话已保留，请重新连接、核对服务器后重试。”本地索引和
  node3 会话目录均在，另外两条会话不受影响。连接恢复后，同一条会话在线重试删除，
  Phi、本地、node3 同时消失，另外两条仍在。回执
  `.phi-acceptance/receipts/2026-10-23-node3-offline-delete-8d5d3b52.json`。
  早先 `7d880855-...` 的断线发生在远端已删除之后，不计入离线通过证据。
- ✅ 同步后的源码版 Phi 上，真实 DeepSeek V4.1 Flash run
  `0e9c4ab2-6349-48ef-802c-ab6acc6026b3` 在原 node3 会话重新调用 `read`，远端结果
  `ok\n`、`isError=false`，界面回复 `ok`。先前 run `f71bbc7b-...` 因模型附带可选 `i`
  意图字段触发 bootstrap 拒绝，已仅允许有界意图并在授权后丢弃；RPC bootstrap 安全套件 13/13 通过。
- ⏳ 无缓存新桌面的首次官方 OMP 下载仍需验证。最终候选源码版的真实 DeepSeek `read`、
  Notebook 执行/保存与在线/离线删除已重验。

## 当前放开决定（2026-10-23）

- `yzhang-node3` 与 GPU 在干净候选 `98a8508d` 的 R8 通过，可继续在显式
  `PHI_REMOTE_OMP_RPC=1` 下进行内部验收；共享源码已同步同一修复。
- 暂不把开关改为全局默认开启。剩余发布门槛按顺序关闭：
  1. 在目标无缓存桌面实走 [x64 预置前置](remote-omp-preseed.md)并留 SHA-256 回执，
     或证明官方完整下载可用；当前只在全新临时缓存目录验证了生产命中。
  2. 关闭静态警告预算及测试类型检查基线债务；真实 DeepSeek `read`、Notebook 与
     在线/离线删除均已在固定候选源码版完成。
  3. 若发布标准要求“长 Bash 运行时 SSH 断开但 OMP 仍存活”，需再补该精确场景；
     现有实机已分别证明长 Bash 断线退出和真实 OMP 存活接管，未把两者混作一次验证。
- 当前源码 `src/main/index.ts` 为 4261 行，已低于 4288 行上限；结构门禁通过。
  `npm run lint` 有 0 错误、1451 警告，仍高于 1396 的预算；未修改主分支基线为 1542 警告。
  测试类型检查有 479 错误，原基线为 480；这些门禁尚未通过，不通过上调阈值冒充验收完成。

已知 UX 行为：

- 远程 OMP 会话在应用重启后可先显示“远程会话尚未连接”；点击侧边栏中的会话会尝试连接
  经验证的原有历史，不会重发消息或任务。无法安全连接时保留“恢复原会话”及诊断入口；
  当前源码在 node3 已验证点击连接、显式恢复和两条会话往返切换。
- 远程 Jupyter 需要先在 Runtime 面板显式启动；未连接时 kernel 按钮因没有诊断信息而禁用，
  点击无反应。两处都可以在后续补自动重连/更明确的提示。

## 收尾

- 三项都通过后，同步勾选 [路线图 §6.5](../roadmap/omp-decoupling-upgrade-plan.md)，
  并把日期、提交与回执补进 [验收记录](omp-remote-acceptance.md) 顶部。
- 默认切换仍需稳定一个升级周期，之后才是 T18；本清单不改变这一顺序。
