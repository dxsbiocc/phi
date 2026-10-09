# 远程项目与本地能力对齐实施计划

状态：**设计已确认，待实施第 1 步**
创建日期：2026-10-08
前置：`.omx/plans/remote-wrapper-capability.md`（文件/命令/Wrapper 闭环）、`docs/roadmap/remote-e01-validation.md`

> 本文是"远程能力对齐"的唯一实施依据。执行者为 Codex（gpt-5.6-sol xhigh）；所有验证命令使用 `bun run`。
> 路线图说明：`internal-beta-implementation.md` 把 remote/HPC 排在 beta 之后；本计划按用户 2026-10-08 的明确优先级执行，不夹带无关功能。

## 1. 目标与非目标

**目标**：远程项目不因服务器而缺功能。用户在远程项目里能用到与本地项目相同的入口：文件、命令、终端、Notebook、Skills、受管环境、MCP、专家子智能体、Office/交付物、Git、Wrapper。服务器能力不足时，界面**明确标出降级项与原因**，不静默失败，也不回退到本机执行。

**非目标**：
- 不把智能体运行时搬到服务器。模型调用、会话历史、密钥始终留在本机（服务器可能离线，例如 HPC 计算节点）。
- 不自动上传大型数据，输入数据仍以"已在服务器上"为主路径。
- 不在服务器上编译任何东西、不从服务器联网下载任何东西。
- 不自动安装 Nextflow/Java/容器，不修改用户 shell 启动文件，不在登录节点常驻进程。
- 暂不支持需要交互式密码/MFA 的登录（`BatchMode=yes` 保持不变）。

## 2. 现状差距（2026-10-08 代码核对）

| 能力 | 远程现状 | 依据 |
| --- | --- | --- |
| read/write/edit/glob/grep/bash | 已有同名远程实现 | `src/main/agent/omp/omp-sdk-worker.ts`（`remoteRoot` 分支） |
| Wrapper（Nextflow/Slurm） | 已有；GPU 单机与 HPC 集群已实跑 | `src/main/agent/wrappers/composition/remote-*.ts` |
| 文件面板预览/下载 | 已有 | `src/main/agent/remote-workspace-file-ui.ts` |
| 终端 | 不支持 | `src/main/terminal/terminal-workspace.ts`（`remote_unsupported`） |
| Notebook/Jupyter | 不注入 | `src/main/index.ts`（`notebookPrompt = remoteProject ? null : …`） |
| Skills / 脚本工具 / viz | 关闭 | `index.ts`（`shouldLoadBundledSkills = !remoteProject`）、worker（`skillTools = remoteRoot ? undefined`） |
| 受管环境 / `env_request` | 抛错 | worker（`environment binding is not supported for remote projects yet`） |
| 项目级 MCP / 项目 agent | 仅全局 MCP；agent 仅 Wrapper | `index.ts`（`isRemoteResourceScope`、`remoteWrapperAgent`） |
| Office 工具 / `present_files` | 关闭 | worker（`officeCustomTools = remoteRoot ? [] …`） |
| Git | 无专门支持 | — |
| 专家子智能体 | 仅 Wrapper 拿到远程工具 | worker（`remoteTools` 过滤） |

待核实（第 1 步内顺带确认）：`buildProjectDownloadTool(cwd, agentDir)` 在远程项目下仍使用本地锚点目录。

## 3. 核心设计决定

### 3.1 统一底层：`WorkspaceHost`

不再为每个工具单独写远程版本。所有"碰项目文件或进程"的消费者改为接收 host：

```
WorkspaceHost {
  fs:   stat / read(range) / write(atomic, expectedHash) / list / glob / mkdirp / remove
  exec: run(cmd, {cwd, env, timeout, maxOutput, signal}) / spawn(background, process group)
  pty:  open(cols, rows) / write / resize / close            // 能力协商，可能不可用
  watch: subscribe(path)                                     // 可能降级为轮询
  forwardPort: open(remotePort) -> localPort                 // 可能不可用
  capabilities(): HostCapabilityProfile
}
实现：LocalHost、SshHost
```

- `runInEnvironment`（运行时基础的执行原语）必须支持 host。skill 脚本、viz、`env_request`、Notebook 内核、MCP stdio 都经过它，改一处同时打通一批功能。
- 工具层的 `remoteRoot ? … : …` 分支收敛为单一 host 注入点；本计划完成后新增工具必须声明 `host-aware` 或 `local-only`（见 §6 防漂移）。

### 3.2 传输：预编译静态 helper + 纯 SSH 兜底

- 大脑在本机，helper 只做执行（fs、exec、pty、端口转发、监听），**不做推理**。参考 Codex 的 `app-server` 形状，但不搬整个运行时。
- helper 用 **Go**，`CGO_ENABLED=0` 静态编译，首批只发 linux-x86_64、linux-aarch64；macOS 远端暂不支持（探测到 darwin 时降级到纯 SSH 并说明）。不依赖服务器 glibc（HPC 为 2.17）、Python/Perl/Node、编译器或联网。
- helper 只从**本机随应用发布的二进制**上传，校验 sha256，路径含版本号（`~/.phi/remote/<ver>/`），不同版本并存，不覆盖运行中的旧版本。
- 通信：经现有 OpenSSH 连接的 stdio，长度前缀 JSON 帧（JSON-RPC 2.0 形态）；SSH 断开 helper 即退出，不留后台服务，不监听任何网络端口。
- helper 不保存密钥、不自行决定操作；所有写入/命令仍走 Phi 的审批与路径边界，helper 内再校验一次项目根。
- helper 不可用时（`noexec`、架构不支持、被安全软件拦截）自动降级到现有纯 SSH（shell/perl）路径，并在能力档案中标出受影响能力。

### 3.3 首次连接检测与能力档案

检测脚本只用 POSIX `sh`，不依赖 helper。结果写入**服务器能力档案**并缓存，设置页展示（同时补上"测试连接"按钮）。

| 步骤 | 检测 | 可自动修复 |
| --- | --- | --- |
| 平台 | `uname -sm`；glibc/musl | 否，不支持则降级并说明 |
| 落点 | 家目录可写？`noexec`？配额？共享盘？ | 是：换备用可执行目录 |
| 上传 | 传 helper，sha256 校验，`chmod +x` | 是：重传一次 |
| 试运行 | `helper --selftest` | 否，降级并给原因 |
| 能力探针 | helper 自测 pty / 进程组 / 端口转发 / 监听 | 逐项标 可用/降级/不可用 |
| 工具链 | git、nextflow、java、conda、sbatch、容器运行时、`module` | **只报告，不安装** |

可自动修复的只限：换可执行目录、重传 helper、更新 helper 版本。其余一律给出可复制的修复建议。现有 `remote-doctor.ts`、`remote-submit-preflight.ts`、`remote-nextflow-install.ts` 并入同一档案，不另起一套。

### 3.4 运行时环境（与 helper 分离）

helper 解决"能不能执行"；受管环境（micromamba + `phi-base`）解决"结果一致不一致"。服务器上的环境按需安装到共享盘；离线集群由本机打包 lock 与离线包后上传。该部分属第 2 步，复用运行时基础设计（`docs/design/phi-runtime-foundation.md`）。

## 4. 实施步骤（按依赖排序）

每步是一个可独立合并的块；块内任务按序执行，完成后更新 §7 记录。

### 第 1 步：Host 抽象、能力档案、helper 骨架（当前唯一待实施块）

**R1.1 `WorkspaceHost` 接口与 `LocalHost`**
- 新增 `src/main/agent/workspace-host/`：`types.ts`（接口与 `HostCapabilityProfile`）、`local-host.ts`。
- 仅定义 fs + exec + capabilities；pty/watch/forwardPort 先声明为可选能力。
- 验收：`LocalHost` 契约测试通过；接口不含任何 SSH 专有概念。

**R1.2 `SshHost`（基于现有纯 SSH，不引入 helper）**
- `ssh-host.ts` 封装现有 `RemoteSshSession`（`src/main/agent/wrappers/remote-ssh-session.ts`）与 `remote-workspace-*.ts` 的读写/搜索/命令实现，对外只暴露 `WorkspaceHost`。
- 不改变现有审批、路径包含（`remote-path-containment.ts`）、冲突检查与断线语义（未知写入/命令先对账、不自动重放、不回退本机）。
- 验收：现有远程工具测试不改断言全部通过；同一份契约测试同时跑 `LocalHost` 与 `SshHost`（用 `tests/helpers/localShellSession.ts`）。

**R1.3 让现有远程工具经 host 注入**
- `omp-sdk-worker.ts` 中六个远程工具构造改为读取 host，而不是各自持有 `requestHost('remoteWorkspace.*')` 的专有路径；行为与消息格式保持不变。
- 顺带核实并记录 `buildProjectDownloadTool` 在远程项目下的行为；若确认使用本地锚点，修正为 host 感知或在远程项目中禁用并给出明确提示。
- 验收：`tests/remote-*.test.ts`、`tests/main-integration.test.ts` 相关用例全过；无新增 `remoteRoot ? … : …` 分支。

**R1.4 首次连接检测与服务器能力档案**
- 新增 `src/main/agent/workspace-host/probe.ts`：纯 `sh` 探测脚本（经 stdin 发送，避免命令行长度限制）+ 解析器 + `HostCapabilityProfile` 序列化（含探测时间、helper 版本、各能力状态与原因）。
- 档案缓存在 Phi 主机档案旁（`~/.phi/`），按「主机别名 + 项目根」键控；helper 二进制按主机共享、档案按项目根独立；支持手动重新检测。
- 并入现有 doctor/preflight 的工具链检查；缺失项只报告并附修复建议。
- 设置页（`features/wrapper/components/` 下现有远程设置）显示档案摘要与"测试连接"；若 `WrapperRemoteSettings.tsx` 超过 600 行，按 `AGENTS.md` 先提取项目卡片/状态 hook，再加入新 UI。
- 验收：对 glibc 2.17 + 无 Perl、`noexec` 家目录、只读家目录、架构不支持（含 darwin）四种伪造环境，探测输出各自正确；脱敏（不含用户名/主机名/路径）。

**R1.5 Go helper 最小骨架**
- 新增 `helper/`（独立 Go 模块，`go.mod` 无外部依赖或仅纯 Go 依赖）：帧协议、`--selftest`、`--version`、fs（stat/read range/atomic write with expected hash/list）、exec（process group、输出上限、超时、取消）。**本步不做 PTY/监听/端口转发。**
- `scripts/build-helper.mjs`：`CGO_ENABLED=0` 交叉编译两个 Linux 目标，输出到 `resources/remote-helper/<ver>/`，生成 sha256 清单；`check:resources` / `check:asar-unpack` 同步纳入。
- 主进程 `helper-installer.ts`：按档案选择二进制 → 上传 → 校验 → 试运行；失败自动降级到 `SshHost` 纯 SSH 路径并写入档案。
- `SshHost` 增加 helper 传输实现，能力协商决定使用哪条路径；两条路径通过同一契约测试。
- 验收：helper 在本机以 `localShellSession` 冒充 SSH 通道跑通契约测试；断开通道后进程退出无残留；`--selftest` 在 `CGO_ENABLED=0` 产物上通过；上传中断/哈希不符/`noexec` 三种故障各自降级且不影响纯 SSH 路径。

**第 1 步完成门禁**：`bun run test`、`bun run lint`、`bun run typecheck`、`bun run build` 通过；`bun run check:architecture` 通过；在 GPU 机与 HPC 各做一次真实探测与 helper 安装/降级记录（脱敏），写入 §7。

### 第 2 步：Skills、受管环境、脚本工具、专家子智能体

- `runInEnvironment` 支持 host；服务器按需安装 `phi-base`；离线集群走"本机打包 lock + 离线包 → 上传共享盘"。
- 解除 `skillTools`、`env_request`、bundled skills 的远程关闭；专家子智能体统一获得 host 提供的工具集（不再仅 Wrapper）。
- **用受管环境替换远程 Nextflow 的 curl 安装器**（2026-10-09 用户要求）：`remote-nextflow-install.ts` 现在在服务器上执行 `curl https://get.nextflow.io` 并装到 `~/.local/bin`，它早于运行时基础，Java 另需预装、版本不锁定、需要服务器联网。目标是改为：从本机上传 linux micromamba，按 `resources/runtime/environments/phi-nextflow/environment.yml` 的锁在服务器上构建 `phi-nextflow` 环境（Nextflow 与 Java 同锁）；离线集群走本机打包的离线包。本机目前只打包 darwin-arm64 的 micromamba，需先补 linux-x86_64/aarch64 的获取与校验（`scripts/runtime/fetch-micromamba.mjs`、`resources/runtime/manifest.json`）。完成前保留 curl 安装器作为过渡，界面上仍由用户点击触发，不自动执行。
- 前置：第 1 步完成；需单独确认远程环境存放位置与配额策略。

### 第 3 步：远程终端

- helper 增加 PTY（resize、背压、进程组清理）；终端工作区解析改为按 host 能力，替换 `remote_unsupported`。
- 保持"agent 只起草命令，用户显式发送才写入 PTY"的既有约束；终端环境变量仍用白名单。

### 第 4 步：远程 Notebook/Jupyter

- 内核跑在服务器（经 `runInEnvironment`），helper 做端口转发到本机；ipynb 读写经 host fs。
- 恢复远程项目的 notebook 提示词与工具注入。

### 第 5 步：项目级 MCP 与 agent 发现

- 从远程项目根扫描 `.phi/` 资源，加信任门禁；HTTP 连接器留在本机，stdio 连接器在选定 host 上运行。

### 第 6 步：交付物链路

- Office 与 `present_files`：远端落地 → 本地缓存预览 → 哈希冲突检查后回写；缓存有大小上限并可清理。

### 第 7 步：收尾

- Git（基于 exec）、带断点续传的上传/下载、PBS/LSF 执行器、Nextflow 被硬杀后的 Slurm 残留作业清理。

## 5. 降级原则

- 能力状态三档：**可用 / 降级 / 不可用**，写入能力档案，UI 据此显示入口；降级必须带原因与建议。
- 离线计算节点、登录节点禁止常驻进程、交互式 MFA、`noexec` 家目录等是服务器侧限制，只做检测与提示，不绕过。
- 任何远程故障都不得回退到本机执行（沿用既有规则）。

## 6. 防漂移机制

1. **契约测试**：同一套工具/host 契约测试参数化跑 `LocalHost` 与 `SshHost`（含 helper 与纯 SSH 两条路径）。
2. **声明检查**：新增 `scripts/check-host-awareness.mjs`，要求每个注册的工具/能力声明 `host-aware` 或 `local-only`（附原因）；纳入 `bun run lint`。
3. **对齐矩阵**：本文 §2 表格随每步更新，作为发布门禁。

## 7. 验证与记录

- 自动化：`bun run test`、`bun run lint`、`bun run typecheck`、`bun run build`、`bun run check:architecture`。
- 真实环境：GPU 单机（docker、可联网）与 HPC 集群（Slurm、sbatch 控制器、计算节点离线、glibc 2.17、conda）；站点细节见记忆 `hpc-cluster-quirks`。
- 实测记录只写版本与脱敏结果，不保存用户名、真实主机名、密钥、环境变量或私有绝对路径。
- 完成记录（按步追加）：

  - 第 1 步（代码 2026-10-09 完成，**真实服务器验证待做**）：
    - R1.1 `WorkspaceHost` 与 `LocalHost`：`a4df11ce`/`71b45b3d`；R1.2 `SshHost`；R1.3 六个远程工具经 host 注入：`db6b8322`（`download_file` 在远程项目暂时禁用，host 写入契约尚无流式、续传与二进制对账语义）；R1.4 探测与能力档案：`962352ad`；R1.5 Go helper 与安装/降级：`546b0f21`。
    - 过程中顺带修复：夹具 `/var/var` 路径拼接（`7b094a9b`）；取消 detached 远程运行时，启动器尚未成为进程组组长即取消会落空的**生产缺陷**（`0c3f1719`，回归测试 `99983e21`）。
    - 验证方式：每一块都在只含该块改动的干净 `HEAD` 副本里重跑 typecheck、架构检查、ESLint 与相关测试，不采信带用户在途改动的工作区结果。R1.5 末次为 56 个测试文件 448/448；两个 Linux 产物确认为静态链接（amd64 为 3,252,384 字节）。注：同一份源码在不同时间点构建出过不同的 sha256（`2428c95c…` 与 `913a9268…`），原因未查明，所以**不要把构建当作跨时间可复现**；完整性依赖安装时服务器文件与构建清单的哈希比对，这一点已在真实服务器上验证。Go 1.27.2 的四个平台校验值已与 go.dev 官方 JSON 逐项核对。
    - **真实服务器验证（2026-10-09，GPU 与 HPC-node3，驱动脚本经项目自己的探测/注册表/SshHost 代码）**：
      - 通过：GPU 机探测结果与真实值一致；有档案时 helper 装上、`--selftest` 通过、会话期间 1 个进程、释放后 0 个；删除或截断 helper 后下次连接自动重装；降级到纯 SSH 时读写与命令仍正常；两台服务器清理干净。HPC-node3（glibc 2.17）上手动上传 helper：`--version`、`--selftest` 通过，`serve` 在 stdin 关闭时退出码 0，无残留进程。
      - **发现三个缺陷（已由 R1.6 修复，提交 `2fe21b7e`；它依赖的“开发模式按需准备 helper”先提交为 `fb9a95d4`）**：(1) 没有缓存档案时 helper 永远不安装，因为 `RemoteWorkspaceHostRegistry.create` 只在读到缓存档案时才带 helper 配置，用户不先点「测试连接」就走纯 SSH；(2) HPC-node3 上能力探测超过 30 秒默认超时，整份档案变成全部未知（连 `uname` 都丢），helper 因此被降级，探测应分成快速阶段（平台、libc、存储）与慢速阶段（工具链版本），慢阶段超时不得丢掉快阶段结果；(3) 平台未知时降级原因被写成「remote helper supports Linux only」，应为「平台未知（探测不完整）」，且不完整的档案不应被当作最终结果缓存。
      - **R1.6 修复后重跑（同日，GPU 与 HPC-node3）**：(1) 无缓存档案时 helper 自动安装并运行（两台均是），释放后进程为 0；(2) HPC-node3 上探测从超时变为 76 秒内完成，平台与 libc（glibc 2.17）、存储、git/java/sbatch/singularity 完整且正确，`nextflow` 与 `conda` 如实标为「版本检查超时」而非「未安装」；(3) 删除或截断 helper 后自动重装，降级时工具仍可用。两台服务器验证后无残留进程、目录或 `~/.phi`。helper 在 glibc 2.17 上以 `fs.stat` 实测可响应。
      - **统计 helper 进程时要用进程名**（`ps -u "$(id -un)" -o comm= | grep -c '^phi-helper$'`）。HPC 的老版本 `ps` 在管道输出时把整行截断在约 101 个字符，按命令行统计会漏掉 helper，曾因此误判「helper 没有被使用」。
      - **E 组 Wrapper 回归（2026-10-09，单样本 fastp，经 `startRemoteWrapperComposition`/`attachRemoteWrapperComposition`，状态目录与启用配置为临时副本）**：
        - GPU（local 执行器、docker）与 HPC-node3（Slurm、sbatch 控制器、conda、`--exclude=node4`）均通过：E1 提交并完成（32 秒 / 91 秒，输出与 9 月 28 日链路一致）；E2 脱离后接管（启动器进程号/作业号前后一致，没有重复提交，日志重复行 0）；E3 提交后立即取消（`0c3f1719` 修的竞态场景，取消成功、无残留）；E4 并发取消互不影响；E5（HPC）`squeue` 可见控制器作业、排除节点为 node4、取消后该作业消失；E6 读取小结果字节数一致。结束后两台服务器均无残留进程、目录、Slurm 作业与容器。
        - GPU docker 配置下取消会杀掉已启动的任务：任务 `.exitcode` 为 143，容器在取消后约 10 秒内停止。
        - **缺陷（Slurm + sbatch 控制器）**：取消只取消了控制器作业，Nextflow 已提交的任务作业不会被一起取消。实证：控制器作业 `CANCELLED`，其任务作业 `nf-FASTP` 在控制器被取消 18 秒后 `COMPLETED`（退出码 0:0），而不是 `CANCELLED`。单样本 fastp 只多跑了 18 秒；取消长时间的 STAR 比对则会一直占用集群直到任务自己结束，并继续写入该 run 的工作目录。即「未做」清单里的“Nextflow 被硬杀后残留的 Slurm 任务作业清理”。建议修复方向：取消控制器时先 `scancel --full --signal=TERM` 让 Nextflow 自行清理，再按任务作业的 `WorkDir`（位于该 run 的 `work/` 下，唯一）扫描并 `scancel` 残留。
        - 脚本若不主动退出会多挂约 9 分钟（Node 事件循环里有句柄未释放），应用本身是长驻进程不受影响，但值得查出是哪个定时器或连接。
      - **仍未验证**：在真实 Phi 界面里「测试连接」与档案摘要的展示与脱敏、E 组 Wrapper 回归（RNA-seq 小样本、提交后立即取消、并发取消、Slurm `scancel`）、`remote-ssh-real-identity` 测试（需在沙箱外跑）。
    - 待收紧：R1.1 契约测试 `workspace host terminates commands after their timeout` 断言耗时 `< 2000ms`，机器上有其他测试并行时会在约 2.1 秒失败（单独重跑 6/6 通过），应放宽上限或改为相对超时的比例。
    - 启动调整（2026-10-09）：`predev`/`prestart` 不再准备 Go 或编译 Helper。开发版在首次远程使用时按服务器架构准备，源码、工具链指纹及产物校验一致时复用；发布 `build` 仍生成两个 Linux 目标，安装后的客户端连接服务器时使用预构建产物。
    - 遗留：远程 Nextflow 的 curl 安装器为过渡实现，见第 2 步；并发取消测试的 `waitFor` 原先没有超时上限，已在新增回归测试里加了有限超时，旧测试未改。

## 8. 风险

| 风险 | 对应 | 处理 |
| --- | --- | --- |
| helper 在 glibc 2.17 或受限环境不可用 | R1.4、R1.5 | 静态编译 + selftest + 自动降级到纯 SSH |
| 抽象改动破坏已跑通的 Wrapper 链 | R1.2、R1.3 | 现有测试断言不改；`smoke:wrappers` 与两台真实服务器回归 |
| 二进制体积与多平台发布 | R1.5 | 只发两个 Linux 目标；清单校验；`check:asar-unpack` 覆盖 |
| helper 扩大攻击面 | §3.2 | 仅 stdio、无监听、项目根二次校验、审批不下放 |
| 共享盘上缓存/并发 | R1.4 | 版本化路径、原子写入、校验后再用 |

## 9. 已决定与待决问题

已决定（2026-10-08，用户确认）：
- helper 首批只发 Linux（x86_64、aarch64），macOS 远端后续再议。
- 能力档案按「主机别名 + 项目根」键控。

待决：
- 远程受管环境的默认位置与配额（第 2 步前决定）。
