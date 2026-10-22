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

已知 UX 行为：

- 远程 OMP 会话在应用重启后可先显示“远程会话尚未连接”；点击侧边栏中的会话会尝试连接
  经验证的原有历史，不会重发消息或任务。无法安全连接时保留“恢复原会话”及诊断入口；
  此点击连接行为仍待当前候选的实机人工验证。
- 远程 Jupyter 需要先在 Runtime 面板显式启动；未连接时 kernel 按钮因没有诊断信息而禁用，
  点击无反应。两处都可以在后续补自动重连/更明确的提示。

## 收尾

- 三项都通过后，同步勾选 [路线图 §6.5](../roadmap/omp-decoupling-upgrade-plan.md)，
  并把日期、提交与回执补进 [验收记录](omp-remote-acceptance.md) 顶部。
- 默认切换仍需稳定一个升级周期，之后才是 T18；本清单不改变这一顺序。
