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
- Phi **不会自行主动**在服务器上安装 Nextflow/Java/容器、修改 shell 启动文件或常驻进程；这是默认的不擅自行动原则，不是禁令。用户通过设置里的明确操作，或在对话里下指令让 agent 去做时，允许执行（agent 的远程命令仍走既有审批与权限模式）。
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

## R2.5 远程工具分类

分类口径：A 类不读取或解析项目文件系统，可在远程项目直接使用；B 类必须由已验证的 `WorkspaceHost` 或远程运行时后端执行；C 类绑定本机文件、进程或应用句柄，远程项目继续拒绝。所有放行都按“工具名 + 已注册后端来源”逐项验证，未知工具、同名 builtin、动态扩展和 `mcp__*` 不因前缀而自动放行；远程失败也不得回退到本机项目锚点。

| 类别 | 实际注册面 | R2.5 结论 |
| --- | --- | --- |
| A | `browser`、`web_search`、`ask_user_question`、`palette_suggest` | 浏览器、搜索、Phi 问答 UI 与调色板不使用项目 cwd，逐项放行。`browser` 仍沿用远程会话当前的输入动作限制。SDK 没有独立 `web_fetch`：网页抓取原本是 builtin `read(URL)` 分支，而远程项目的 `read` 已被服务器文件读取覆盖；本次以 `browser`/`web_search` 为可用替代，不把 URL 交给本机项目 `read`。 |
| A | 动态 Phi agent 名（远程当前只有 `Wrapper`）、`agent_status`、`agent_wait`、`agent_steer`、`agent_stop`，以及 Wrapper 专家内部的 `wrapper_search`、`wrapper_inspect`、`wrapper_run`、`wrapper_status`、`wrapper_wait`、`wrapper_cancel` | 只在对应 Phi custom tool 已实际注册时放行。Wrapper 运行已有远程 job 后端；管理工具只操作本会话的 run registry，不解析本机项目路径。builtin `task` 不在此列。 |
| B（后续） | 条件 builtin `checkpoint`、`rewind`、`todo`、`goal`、`think`、`yield`、`ask`、`hub`；SDK 条件工具 `generate_image`、`tts` | 这些 SDK 工具不是本轮的 Phi 子智能体管理面；其中 checkpoint/todo/hub 可能读取 cwd、写会话文件或管理本机进程，图像/语音工具还需确认远程输出与交付路径。逐项证明不触碰本机项目锚点前继续 fail-closed。 |
| B（已有） | `read`、`bash`、`glob`、`grep`、`write`、`edit` | 保持现有同名远程实现与 description/source 验签；任何 builtin 同名实现都拒绝。 |
| B（R2.5 部分完成） | `skill_run`、动态 `<toolPrefix>_<name>` 脚本工具；Skills 列出/读取（资源能力，不是独立工具名） | 远程目录现只列出/读取全局 Skills，忽略本机 anchor 中伪造的项目资源；remote specialist 不再无条件清空其声明的全局 Skill。脚本执行仍需把经过校验的 Skill 资源按需放入服务器运行时根目录的内容寻址目录，再用服务器环境运行；完整 remote runtime service 落地前 `skill_run`/动态脚本工具继续明确拒绝，禁止调用本机 `runSkillScript`。项目级 Skill 留待远程资源信任机制。 |
| B（R2.5 待后端） | `env_request` | 目标是仅使用 R2.2 配置的服务器运行时根和已安装、可运行的 micromamba 创建/复用环境；未安装、版本/平台不可用或服务器离线时返回明确指引，不自动安装、不转到本机求解或构建。现有 `environments.request` 会写本机 project/runtime，不能复用；独立 remote runtime service 完成前继续拒绝。 |
| B（R2.5） | `download_file` | URL 与目标先校验，随后由服务器直接下载到远程项目目录。服务器缺少下载器或无法联网时明确报错；旧的 `remoteProject: true` 无后端路径继续拒绝且保持零本机 fetch/写入。 |
| B（R2.5） | `present_files` | 用远程 host 校验项目内普通文件，记录 `ssh://` 引用；打开时复用已有远程预览/下载链，不把文件复制到本机 anchor。 |
| B（后续） | `notebook.list`、`notebook.read`、`notebook.insert_cell`、`notebook.update_cell`、`notebook.delete_cell`、`notebook.run_cell`、`notebook.save`；`lib.save`、`lib.update`、`lib.remove`、`lib.list`、`lib.find`、`lib.audit` | 当前实现把 SDK cwd 交给本机 Notebook/Jupyter 或项目 literature store，不能放行。待各自接入 WorkspaceHost/远程 Jupyter 或明确的远程 library store；当前替代是远程 `read`/`write`/`bash`。 |
| B（后续） | builtin `ast_grep`、`ast_edit`、`debug`、`eval`、`github`、`lsp`、`security_scan`、`task` | 都会读取 cwd、启动本机进程或创建继承本机 cwd/工具的子会话；逐个拥有远程后端前继续拒绝。`task` 的替代是已验证的 Phi agent/Wrapper 委派。 |
| B（仅设计） | 动态 `mcp__<server>_<tool>`、全局/项目 MCP 配置 | 本次不实现。项目配置以后必须由 WorkspaceHost 从远程项目根读取并经过信任门禁；HTTP transport 可留在本机，但每个工具仍需后端 provenance；stdio 必须在服务器运行时执行。配置读取、stdio 启动、工具参数中的路径都不得读取本机 anchor 或静默回退。远程 `enableMCP` 继续为 `false`。 |
| C | `office_read`、`office_apply`、`office_deliver`，以及安装 Skill 可能声明的本机 Office 脚本工具 | 当前 Office 后端绑定本机已打开文档、草稿与应用进程句柄。远程调用必须说明该原因，并建议先把文件下载到本机 Office 工作流，或在服务器用 `skill_run`/`bash` 生成普通文件后用 `present_files` 交付。不得注册本机 Office 后端作为远程后备。 |
| C | `memory_edit`、`retain`、`recall`、`reflect`、`learn`、`manage_skill`，以及未声明 host-aware 的 extension/plugin tool | 这些条件工具绑定本机全局存储或内容写入；R2.5 不扩大权限，继续以具体原因拒绝。未来只有在明确区分全局状态与项目路径并补齐远程测试后才可改类。 |

主 agent 的完整 builtin 注册候选还包括 `read`、`bash`、`edit`、`glob`、`grep`、`write` 及上表列出的条件工具；`search`/`find` 只是 `grep`/`glob` 的兼容别名。Phi custom tools 还包括上述交付、下载、Notebook、library、Skill、环境、Office、浏览器、用户交互和动态 agent 工具。远程关闭 extension discovery、LSP 与 MCP，因此未实际进入远程工具表的候选仍记录在此，但不会因分类而被隐式注册。

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
- 前置：第 1 步完成；远程环境存放位置已定（见 §9），空间阈值待实现时确认。

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
        - **已修复（`6c7a8b4c`、`7896a9f4`，同日在真实 HPC 上复测）**：取消时先 `scancel --full --signal=TERM` 让 Nextflow 自行清理，宽限期后取消控制器，再按任务作业的 `WorkDir`（按目录边界匹配 `<runDir>/work`）扫描并取消残留并最终确认；复测任务作业 `CANCELLED`（退出码 143），队列 3 秒内清空，取消前后作业数 0→0。第一版修复把用户取消报告成了失败（Slurm 17.11 把被 TERM 终止的批处理脚本记为 `FAILED ExitCode=0:15`，而解析时丢了信号位），由 `7896a9f4` 修正：仅当 Phi 已发出取消请求且无残留时才判为 cancelled，其余仍为 failed/lost。假 Slurm 没有复现这一状态转换，是真实集群才暴露的。轮询循环遇到取消不再自行宣布 cancelled，保持 `cancelling` 直到清理确认；已用测试证明它在清理成功、仍有残留、连接中断、重启对账四类情况下都会收敛，未发现卡死路径。
        - **已查明并修复**：远程 Wrapper watcher 的可取消轮询用 `Promise.race` 提前唤醒时，没有清除输掉竞态的轮询定时器；会话虽已关闭，该句柄仍会存活到当次轮询时限（实测脚本约多挂 9 分钟）。`Control.pause` 现在在完成、取消或脱离路径都清除定时器，并有无网络的活动句柄回归测试覆盖。
      - **补验（2026-10-10，GPU 与 HPC 登录节点，驱动脚本经项目自己的 `SshHost` 与 `startRemoteWrapperComposition`，每台在自己的随机子目录内操作并在结束时删除）**：
        - 清单 D1–D5、B2/B3/B6/B7、C1/C2、A2/A5 两台主机全部通过（GPU 13/13 加 D4 复测，HPC 14/14）：写入与读取只发生在服务器且本机无副本；`glob` 与带哈希保护的编辑可用、过期哈希被拒绝；命令的 `pwd` 是服务器项目目录；取消后无残留 `sleep`；5 MB 输出被截断到 100 KB（约 70 毫秒）；helper 哈希与打包一致、selftest 通过、会话期间 1 个进程、关闭后 0 个；删除或截断 helper 后工具仍可用且自动重装；能力档案的架构与 glibc（GPU 2.35、HPC 2.17）与真实值一致；保存的档案里搜不到用户名、主机名、家目录路径。
        - 第一次 D4 报“残留 2 个 sleep”是检查方法的缺陷（`pgrep -f` 匹配到了执行检查的那条 ssh 命令自己），改成按进程名精确统计后通过，不是产品缺陷。
        - **E4 并发取消（HPC，Slurm，sbatch 控制器，conda）通过 6/6**：两个 fastp run 都已有任务作业在 Slurm 里（各 2 个）时取消其中一个；被取消的 run 状态为已取消（约 18 秒收敛）、其 Slurm 作业清空，另一个 run 的 2 个作业全程未受影响并最终成功、产出 5 个文件；结束后集群上无遗留作业、无遗留 nextflow/helper 进程。这证明按 `WorkDir` 扫描取消任务作业不会误杀并行 run 的作业。
        - **E6 结果预览与显式下载（GPU 与 HPC，各 15/15）**：结果目录与嵌套目录可列出；小文本、150 KB 文本完整预览；1.5 MB 文本只返回元数据（`large_file`，不返回内容，文本上限 1 MiB）；PNG 预览为图片；3 MB 二进制只返回元数据，显式下载后字节数与 sha256 与服务器完全一致，下载过程经 downloading、verifying、saving，无 `.part` 残留；`..` 路径、绝对路径、指向授权范围外的符号链接（预览与下载）、用 run 范围经 `..` 够到输出目录都被拒绝，且被拒的下载不会在本机写任何文件；错误信息不含用户名、主机名或家目录。
        - `remote-ssh-real-identity` 等真实 OpenSSH 测试在沙箱外已通过（52/52，含冷却门测试）。
        - **仍未验证**：在真实 Phi 界面里「测试连接」与档案摘要的展示；B8（会话中断网 30 秒）；RNA-seq 多步骤全链路的重新回归；冷却门在真实服务器上的行为（需要故意输错密钥，有触发服务器封禁的风险，未做）；密码引导的真实 `sshd` 端到端（需要提供测试用户密码，未做）。
    - 已收紧：R1.1 契约测试 `workspace host terminates commands after their timeout` 改用相对命令运行时间和 timeout 的终止上界，同时保留退出码与信号断言；目标契约单独运行 5/5 轮、并行负载 6/6 个进程及全部 WorkspaceHost 测试均通过。
    - **第 2 步 R2.1 远程运行时根目录（2026-10-10，提交 `6d4e944f` 测试框架修复、`5b2af3eb` 功能）**：主机级与项目级两级覆盖（项目 > 主机 > 默认 `~/.phi/runtime`）；硬性错误只有「非绝对路径/含 `..`」与「最近存在的祖先不可写」，其余（不归当前用户、组或他人可写、符号链接、低空间、磁盘使用率高、`noexec`、共享盘提示）只给带后果说明的警告，用户确认后可继续；检查在服务器上只读，唯一写入是在最近存在且可写的祖先目录放一个临时探针并删除，不创建运行时目录；能力档案不含路径、用户名、主机名；设置里有主机级输入与项目覆盖及检测清单。干净副本验证：tsc 三项 0 错误，73 个测试文件 794/794（含 `main-integration` 218/218）。真实服务器验证（GPU、HPC-node3，只读）：默认位置、用户自己的 `/data/<用户>/…`（GPU，剩余约 4 TB 且无警告，对比默认家目录已用 91%）、NFS 共享盘与共享盘提示、不可写祖先、相对路径、含 `..`、`/tmp` 的警告，结果与事先写下的预期逐项一致，且两台服务器均未留下运行时目录或探针文件。
    - **HEAD 上已存在的两个问题（与 R2.1 无关，记录在此）**：(1) 架构检查失败：`src/renderer/src/types.ts` 被检查脚本数成 1001 行（脚本按换行拆分计数，`wc -l` 为 1000），需要用户决定加文档化的临时例外还是按功能归属拆分；(2) `tests/main-integration.test.ts` 曾因缺少 `./agent/session/home-activity` 的 mock 整体失败（217/217），已由 `6d4e944f` 修复。
    - **R2.1 尚未验证**：设置界面在真实 Phi 里的实际显示与交互（只有组件测试）；Slurm 计算节点是否能看到该根目录（按设计留给 R2.3 的探针作业，需先征得同意）；`noexec`、符号链接、低空间这几类无法在真实服务器上安全构造，只由解析器测试覆盖。
    - **SSH 认证与登录（2026-10-09 至 10-10，`ec47b8c1`、`dc01b7b9`、`b6ece618`）**：
      - 认证冷却门：认证失败或主机信任失败（`authentication_failed`、`host_key_*`）后，对同一目标（主机、用户、端口、生效的密钥路径）冷却 15 分钟，期间不再启动 `ssh`；网络不可达、超时、跳板机、配置、未知错误不阻断。成功连接清除阻断；设置页「测试连接」、远程项目手动重连、项目创建探测是用户主动入口，可绕过；后台检查与 Wrapper 自动预检不可绕过。真实 OpenSSH 测试（本机 sshd）已覆盖，不在真实服务器上故意输错密钥验证。
      - 密码引导：用户在设置里输入一次密码，确认主机密钥指纹后登录一次，生成带口令的专用 ed25519 密钥，幂等安装公钥，用密钥再连一次验证，预览并征得同意后才写 `~/.ssh/config`，随后丢弃密码。密码经 0600 命名管道和 0700 askpass 辅助程序交给 `ssh`，不进命令行、环境变量、日志或磁盘；每次引导最多 3 次尝试，失败计入冷却门。**不保存密码**（钥匙串存密码模式已评估并明确不做，见项目决定）；agent 没有任何相关工具，远程工具出错只指引用户去「设置 → 远程」。只支持 macOS 与 Linux，不支持 Windows、跳板机、MFA、OpenSSH 8.4 以下。带口令密钥在 `BatchMode` 下必须已加载进 ssh-agent，连接前会检查，未加载时提示而不是走到认证失败触发冷却。
      - **后续事项（未做）**：(1) 服务器端撤销已安装的公钥（用户触发、不可由 agent 调用）；(2) 引导进程持锁时崩溃会留下 `.phi-bootstrap.lock` 陈旧锁，需要手动删除，应加过期回收；(3) 强制卸载恰好发生在不可中断的 `ssh-keygen` 或远端安装操作中时可能留下未配置的孤立密钥文件；(4) 真实「只有密码认证的 sshd」端到端测试已写（`ssh-password-bootstrap-real`），需要提供测试用户密码才能跑；(5) 如要支持钥匙串存密码，需要为这类主机单独构造较宽松的 SSH 选项（`BatchMode=no`），不得影响密钥模式的主机。
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

已决定（2026-10-09，用户确认）——**远程受管环境的位置**：
- 统一放在服务器的 `~/.phi` 下，运行时根目录默认 `~/.phi/runtime`，布局与本机 `~/.phi/runtime` 一致（`mambarc`、`pkgs/`、`envs/<envId>/`、`state/environments.json`、`logs/`）；与 helper 已在用的 `~/.phi/remote/<版本>/` 同属 `~/.phi`，二者互不嵌套。
- **用户有特殊指定则按用户的**：主机或项目的远程连接上提供可覆盖的「运行时根目录」设置，优先级为 项目 > 主机 > 默认 `~/.phi/runtime`。解析后的有效根目录（服务器上的规范绝对路径）、所在文件系统类型、剩余空间、是否可执行与是否共享盘，都写进该主机的能力档案。
- 对覆盖路径的约束只设**硬性两条**：绝对路径、当前用户可写。其余只**提示不拦截**：不归当前用户所有、组或其他人可写（实验室共享环境的常见做法）、位于符号链接之下、剩余空间偏少、挂载为 `noexec`（说明原因并指出后果）。默认位置创建时权限 0700；覆盖到共享位置时尊重用户选择，不强行改权限。
- 事实依据（2026-10-09 只读探测）：GPU 机家目录为 ext4，1.6 TB，剩余 147 GB（已用 91%），无配额，inode 充足，该机的 conda 根目录在 `/data/<用户>/miniconda3` 下约 187 GB，即用户习惯把大文件放在 `/data`，是“用户指定位置”的典型场景；HPC 登录节点家目录为 NFS4（`/cluster/home`），18 TB，剩余 17 TB，无配额，inode 充足，工作区 `/cluster` 是另一个 NFS 导出（62 TB，已用 73%）。本机两个受管环境约 3.8 GB，包缓存约 1.4 GB。
- 探测与提示（第 2 步实现项）：剩余空间不足时**警告并让用户确认后继续**，不硬性拒绝（提议 <15 GB 起警告，数值可配置，实现时再确认）；GPU 机这类磁盘已用很满的主机在档案摘要里提示；Slurm 主机必须确认计算节点能看到该根目录，验证方式是提交一个一分钟内结束的探针作业，**只在用户明确触发环境准备时执行，并先征得同意**，不在探测时擅自提交；包缓存与环境只在登录节点构建，计算节点只读使用。

已决定（2026-10-09，用户确认）——**远程服务器操作的入口不限死**：
- **设置里手动操作**：运行时根目录、环境的准备、修复、清理、重新检测，以及（Slurm 主机上）计算节点可见性验证、Nextflow 环境安装等，都做成设置里用户可以手动点的明确操作，并显示当前状态、将要执行的动作与目标位置。
- **对话里让 agent 去做**：用户用自然语言说“在服务器上给 phi-r 环境装某个包”“把运行时挪到 /data/…”“清理旧环境”之类，agent 通过远程项目的工具（命令、文件）和受管环境的操作去执行，仍走既有审批与权限模式；远程项目的系统提示要告诉 agent 该服务器的运行时根目录、能力档案摘要和可用的环境操作，让它不必猜。
- 两个入口调用**同一套**受管环境操作，不各写一份：设置界面和 agent 只是触发方式不同，结果、日志、状态记录一致。
- 提示优先于拦截：能给出原因和后果、让用户确认的，就不硬性禁止。

待决：
- 空间阈值的具体数值（上面提议值是否合适）；在第 2 步实现时确认。
