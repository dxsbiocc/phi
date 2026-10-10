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

| 类别        | 实际注册面                                                                                                                                                                                                                             | R2.5 结论                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A           | `browser`、`web_search`、`ask_user_question`、`palette_suggest`                                                                                                                                                                        | 浏览器、搜索、Phi 问答 UI 与调色板不使用项目 cwd，逐项放行。`browser` 仍沿用远程会话当前的输入动作限制。SDK 没有独立 `web_fetch`：网页抓取原本是 builtin `read(URL)` 分支，而远程项目的 `read` 已被服务器文件读取覆盖；本次以 `browser`/`web_search` 为可用替代，不把 URL 交给本机项目 `read`。                                                                                |
| A           | 动态 Phi agent 名（远程当前只有 `Wrapper`）、`agent_status`、`agent_wait`、`agent_steer`、`agent_stop`，以及 Wrapper 专家内部的 `wrapper_search`、`wrapper_inspect`、`wrapper_run`、`wrapper_status`、`wrapper_wait`、`wrapper_cancel` | 只在对应 Phi custom tool 已实际注册时放行。Wrapper 运行已有远程 job 后端；管理工具只操作本会话的 run registry，不解析本机项目路径。builtin `task` 不在此列。                                                                                                                                                                                                                   |
| B（后续）   | 条件 builtin `checkpoint`、`rewind`、`todo`、`goal`、`think`、`yield`、`ask`、`hub`；SDK 条件工具 `generate_image`、`tts`                                                                                                              | 这些 SDK 工具不是本轮的 Phi 子智能体管理面；其中 checkpoint/todo/hub 可能读取 cwd、写会话文件或管理本机进程，图像/语音工具还需确认远程输出与交付路径。逐项证明不触碰本机项目锚点前继续 fail-closed。                                                                                                                                                                           |
| B（已有）   | `read`、`bash`、`glob`、`grep`、`write`、`edit`                                                                                                                                                                                        | 保持现有同名远程实现与 description/source 验签；任何 builtin 同名实现都拒绝。                                                                                                                                                                                                                                                                                                  |
| B（R2.5b）  | `skill_run`、动态 `<toolPrefix>_<name>` 脚本工具；Skills 列出/读取（资源能力，不是独立工具名）                                                                                                                                         | 远程目录只列出/读取已启用的全局 Skills，忽略本机 anchor 中伪造的项目资源。经过校验的完整 Skill 目录按内容哈希上传到服务器运行时根 `skills/<hash>/`，已完成的相同哈希直接复用；脚本以远程项目目录为 cwd，经 `WorkspaceHost.exec` 在登录节点运行，并可用 `micromamba run -p <remote-env>`。guard 只放行远程服务实际声明且注册的动态工具名。项目级 Skill 仍留待远程资源信任机制。 |
| B（R2.5b）  | `env_request`                                                                                                                                                                                                                          | 保留原参数、结果与对话确认流程；远程分支只用 R2.2 配置的服务器运行时根和其中已安装的 micromamba，在 `envs/<内容哈希>/` 创建或复用环境。创建有超时、输出上限和取消，缺少 micromamba 时指向远程主机设置的安装按钮，conda 源不可达时提示配置镜像或先在可联网机器构建；不自动安装、不调用本机 solver/build、不写本机项目 anchor。                                                  |
| B（R2.5）   | `download_file`                                                                                                                                                                                                                        | URL 与目标先校验，随后由服务器直接下载到远程项目目录。服务器缺少下载器或无法联网时明确报错；旧的 `remoteProject: true` 无后端路径继续拒绝且保持零本机 fetch/写入。                                                                                                                                                                                                             |
| B（R2.5）   | `present_files`                                                                                                                                                                                                                        | 用远程 host 校验项目内普通文件，记录 `ssh://` 引用；打开时复用已有远程预览/下载链，不把文件复制到本机 anchor。                                                                                                                                                                                                                                                                 |
| B（后续）   | `notebook.list`、`notebook.read`、`notebook.insert_cell`、`notebook.update_cell`、`notebook.delete_cell`、`notebook.run_cell`、`notebook.save`；`lib.save`、`lib.update`、`lib.remove`、`lib.list`、`lib.find`、`lib.audit`            | 当前实现把 SDK cwd 交给本机 Notebook/Jupyter 或项目 literature store，不能放行。待各自接入 WorkspaceHost/远程 Jupyter 或明确的远程 library store；当前替代是远程 `read`/`write`/`bash`。                                                                                                                                                                                       |
| B（后续）   | builtin `ast_grep`、`ast_edit`、`debug`、`eval`、`github`、`lsp`、`security_scan`、`task`                                                                                                                                              | 都会读取 cwd、启动本机进程或创建继承本机 cwd/工具的子会话；逐个拥有远程后端前继续拒绝。`task` 的替代是已验证的 Phi agent/Wrapper 委派。                                                                                                                                                                                                                                        |
| B（R2.6）   | 动态 `mcp__<server>_<tool>`、全局/项目 MCP 配置                                                                                                                                                                                        | 放行精确来自应用级 `agentDir/mcp.json` 的 HTTPS MCP，以及配置未引用本机项目路径、只调用外部 API 的桌面端 stdio MCP；工具名还必须同时出现在当前 `MCPManager` 工具集且注册来源为 `sourceInfo.source === "mcp"`。项目级 MCP、未知来源/同名 builtin、依赖本机项目文件的 stdio 继续拒绝；后者提示需在服务器运行且暂未支持，不读取或回退本机 anchor。                                                |
| C           | `office_read`、`office_apply`、`office_deliver`，以及安装 Skill 可能声明的本机 Office 脚本工具                                                                                                                                         | 当前 Office 后端绑定本机已打开文档、草稿与应用进程句柄。远程调用必须说明该原因，并建议先把文件下载到本机 Office 工作流，或在服务器用 `skill_run`/`bash` 生成普通文件后用 `present_files` 交付。不得注册本机 Office 后端作为远程后备。                                                                                                                                          |
| C           | `memory_edit`、`retain`、`recall`、`reflect`、`learn`、`manage_skill`，以及未声明 host-aware 的 extension/plugin tool                                                                                                                  | 这些条件工具绑定本机全局存储或内容写入；R2.5 不扩大权限，继续以具体原因拒绝。未来只有在明确区分全局状态与项目路径并补齐远程测试后才可改类。                                                                                                                                                                                                                                    |

主 agent 的完整 builtin 注册候选还包括 `read`、`bash`、`edit`、`glob`、`grep`、`write` 及上表列出的条件工具；`search`/`find` 只是 `grep`/`glob` 的兼容别名。Phi custom tools 还包括上述交付、下载、Notebook、library、Skill、环境、Office、浏览器、用户交互和动态 agent 工具。远程关闭 extension discovery、LSP 与 MCP，因此未实际进入远程工具表的候选仍记录在此，但不会因分类而被隐式注册。

## R2.5b 远程 Skill 与环境执行

R2.5b 把 R2.5 已展示但仍拒绝的 Skill/环境能力接到登录节点运行时，范围不含 Slurm、Wrapper 运行策略、计算节点环境或 MCP：

- `env_request` 的远程 handler 从 Phi 会话归属解析 SSH 项目和运行时根；项目覆盖优先于主机覆盖，最后使用默认值。环境目录和别名元数据只写服务器运行时根，内容哈希相同且完成标记有效时复用。
- micromamba 必须已由设置页安装到 `<runtime-root>/bin/micromamba-<version>/micromamba` 并通过 `micromamba run` 激活验证；运行命令固定使用 `--override-channels -c conda-forge --yes`，不追加基础环境声明的其他 channel，设置 `MAMBA_ROOT_PREFIX` 到远程运行时根，并把 AbortSignal、超时和输出上限交给 `WorkspaceHost.exec`。网络/软件源错误返回中文恢复建议，绝不转到本机。含 pip 或额外源码包的基础环境在远程安装器实现对应阶段前明确拒绝并给出预构建迁移方案，不静默删减规格；尚未建立服务器 alias 的 `project:` 环境不会读取本机 anchor，未绑定所属插件的 `plugin:` 环境也不会猜测来源，两者分别提示改用 `phi:`/预构建迁移或对应插件专家会话。
- 全局 Skill 的普通文件、二进制资源与依赖一起哈希（含执行位）；纯 SSH 路径对二进制/大文件分块上传，复用时逐文件复核精确文件集、内容、长度与脚本可执行性。上传与远端 bundle 目标都拒绝符号链接和路径穿越，目录为 0700、脚本为 0755，完成标记最后写入。`skill_run` 和动态脚本都从服务器 bundle 取脚本，在远程项目 cwd 执行；`input-path`/`project-path` 只解析到远程项目，现有或悬空的越界符号链接会拒绝。声明 `./environment.yml` 的 Skill 在远程环境打包落地前明确拒绝，并提示改用 `phi:` 或预构建迁移，不回退本机。
- `skill_run`、`env_request` 只有在精确描述签名的 Phi custom backend 实际注册时才放行；动态脚本还必须出现在该会话从远程 Skill 服务取得的工具名集合中。未知工具、builtin 同名工具、未声明 extension、项目级 Skill 和本机 Office/GUI 路径继续拒绝。
- 服务级测试通过现有本机 bash 假 SSH 夹具覆盖环境创建/复用、缺失 micromamba、conda 不可达、上传幂等、执行、取消、输出截断、路径穿越、远程路径解析以及零本机 anchor 回退；worker 编排仍由 Node 可导入的小模块测试，避免测试直接导入 Bun worker。
- 往返次数优化记录（2026-10-10）：纯 SSH bundle 复用改为一次只读 stdin 脚本校验完成标记、精确文件集、SHA-256 与 0600/0700/0755 权限，首次上传改为一次 stdin 整包暂存并在完成标记最后写入后发布；环境 alias、完成标记与 `conda-meta/history` 也由一次只读脚本联合检查。计数型 `WorkspaceHost` 夹具的入口调用由 Skill 首传/复用/动态脚本 `25/24/20` 降至 `5/4/3`，环境创建/复用由 `9/9` 降至 `6/2`（不含生产 workspace 打开时固定的一次运行时根解析）。

## R2.6 远程 MCP

- SDK 把 MCP 工具规范化为 `mcp__<清洗后的 server>_<清洗后的 tool>`（超长名称会截断并附稳定哈希）。`AgentSession.getAllToolInfos()` 对当前 MCP 工具给出 `sourceInfo.source === "mcp"`，但 `sourceInfo.path` 只是 `<mcp:工具名>` 形式的合成标识，不包含配置文件路径；所以远程 guard 不能只信前缀或 `sourceInfo`，还必须把工具名与当前 `MCPManager.getTools()` 中、由应用级配置实际连接得到的 `mcpServerName` 逐项交叉验证。同名 builtin 的 source 仍是 `builtin`，未知或未在白名单中的名称继续拒绝。
- 远程主会话和专家会话的 SDK `cwd` 都固定为本机 `agentDir`，远程项目路径只进入系统提示与 `WorkspaceHost` 身份；本机 remote-project anchor 不是会话 cwd。远程 MCP 加载也固定从 `agentDir` 发起并传 `enableProjectConfig: false`，随后按 source path 精确过滤为 `agentDir/mcp.json`。因此项目 anchor 下的 `.mcp.json`、`.phi/mcp.json`、`.omp/mcp.json`、`.pi/mcp.json` 或其他项目级来源不会进入远程 `MCPManager`；本地项目仍保持按项目 cwd 与设置读取项目级 MCP 的既有行为。
- HTTPS HTTP/SSE MCP 继续在桌面端连接。stdio 也继续在桌面端启动，但仅限不依赖项目文件、用途为调用外部 API 的连接器：缺省 `cwd` 显式收敛到 `agentDir`；若 `cwd` 落在本机项目 anchor、配置的 `command`/`args`/`env`/受管环境元数据引用该 anchor，或任一执行字段使用项目路径占位符，则拒绝并提示“该 MCP 依赖项目文件，需要在服务器运行，暂未支持”，绝不把 cwd 回退到本机项目 anchor。服务器端 stdio 的上传、安装与进程生命周期不在 R2.6 范围内。
- MCP 工具参数由服务器自定义 JSON Schema，完全可能包含路径。R2.6 不把本机路径翻译成服务器路径；调用参数若显式包含本机项目 anchor，同样在 guard 阶段拒绝，并建议改用远程 `read`/`bash`/`skill_run`，或等待服务器端 stdio MCP。相对路径和远程绝对路径不会被擅自解释为本机项目路径。

## R4 远程 Notebook/Jupyter 设计

本节只设计第 4 步的 Notebook/Jupyter 对齐，不改变 R2.5 对 `lib.*` 的结论：文献库仍需独立的远程 store 设计。目标是让本地与 SSH 项目共用 Notebook 文档模型、`analysis.*` IPC、Jupyter session/execution 客户端和七个 `notebook.*` 工具；差异只收敛在“项目文件由哪个 `WorkspaceHost` 读写”和“Jupyter/内核在哪个环境启动”。本阶段不连接真实服务器，也不实现 Slurm 计算节点内核。

### R4.1 已核实的本地完整链路

1. **Jupyter Server 的启动与连接**：`src/main/index.ts` 创建单例 `JupyterServerRegistry`，注入本地 `environmentBuilds` 和用户显式配置的 Jupyter 路径；`ensureJupyterServerReady`、`analysis:startJupyter` 与首次执行 cell 都会触发它。`src/main/agent/notebook/managed-jupyter-server.ts` 优先使用用户显式选中的 host Jupyter，否则解析本地受管环境 `phi:jupyter@1`，只会复用已就绪环境或加入正在进行的 build；当前 `src/main/index.ts` 没有给它 `runtimeSessionId`/确认回调，因此不会在这个入口静默新建环境。它把 Jupyter 的 data/config/runtime/kernels 目录收敛到本机 Phi runtime root，并限制 kernelspec 搜索到 Phi 自己的目录。
2. **监听地址、端口与 token**：`src/main/agent/notebook/analysis-jupyter-server.ts` 当前不是随机端口，而是整个应用固定的 `127.0.0.1:28888`，`port_retries=0`、`allow_remote_access=False`。它显式传入空的 `ServerApp.token` 和 `ServerApp.password`，所以本地实现**不生成也不保存 token**；`JupyterServerConnection.token` 只是兼容可选 token 的数据结构。注册表从进程输出提取 endpoint，或轮询 `http://127.0.0.1:<port>/`；固定端口被旧 Jupyter 占用时还会用 `/api/status` 识别并接管。进程被 `unref()`，普通停止和应用退出时只向记录的子进程发送 `SIGTERM`。
3. **内核发现、选择与创建**：`src/main/agent/environment/index.ts` 的 `detectConfiguredAnalysisKernels` 调用 `src/main/agent/notebook/analysis-kernels.ts`。`src/main/agent/notebook/managed-kernels.ts` 声明本地受管 `phi-python -> phi:python@1` 与 `phi-r -> phi:r@1`，只为已经 ready 的环境写 kernelspec；未构建环境仍显示为 `not-built`，但不会写出可启动 spec。用户环境来自显式配置/检测到的 host Jupyter kernelspec；有效 spec 在列举时被复制为 `host-<name>` 并用 host PATH 包装，但只有 notebook metadata 精确指定该名字时才会选中。`src/main/agent/notebook/analysis-jupyter-sessions.ts` 其余情况再按 display name、语言、首选 `phi-python`、首个非 host kernel 回退；当前 `src/main/index.ts` 构造 session registry 时没有注入 `prepareKernel`，所以未构建内核环境由环境面板/其他环境入口先准备，不在连接 session 时自动构建。
4. **`.ipynb` 的读取、草稿与保存**：`src/main/agent/notebook/analysis-notebooks.ts` 直接用本机 `node:fs` 在真实项目根递归发现 `.ipynb`（默认深度 8、最多访问 2,000 项、最多返回 200 个，并跳过缓存、工作目录等）；`src/main/agent/notebook/analysis-notebook-files.ts` 用 `realpathSync` 做项目内包含检查，用 `readFileSync` + `parseNotebook` 打开，用 `serializeNotebook` + `writeFileSync` 保存。保存前用 `savedRevision` 做乐观冲突检查，但写入本身不是 host 抽象也不是原子写。`src/main/agent/notebook/notebook-tool-executor.ts` 把打开后的文档和 `savedRevision` 保存在主进程内存；insert/update/delete/run 只更新这份草稿，只有 `notebook.save` 才写回磁盘。`src/main/agent/notebook/analysis-notebook-watch.ts` 用本机 `fs.watch` 监听外部变化。
5. **session、执行与结果回流**：`src/main/agent/notebook/analysis-jupyter-sessions.ts` 先 GET `/` 获取 XSRF cookie，再 POST `/api/sessions` 创建 notebook session；token 若存在则放在 HTTP `Authorization`。`src/main/agent/notebook/analysis-jupyter-execution.ts` 连接 `/api/kernels/<id>/channels` WebSocket，token 若存在只放在连接 URL 内存中，发送 `execute_request`，最多等待 30 分钟并以同时收到 `execute_reply` 和 `status: idle` 为完成条件；stream、display、execute_result、error 被规范化为 `NotebookOutput`。renderer 的 `analysis:executeNotebookCell` 在 `src/main/index.ts` 中把 execution count、outputs、时长写回草稿并通过 IPC 返回；renderer/agent 的草稿同步都经 `analysis:notebookDraftChanged` 广播到 UI。agent 的 `notebook.run_cell` 复用同一个 session registry 和 executor，不另起执行链。
6. **关闭、打断与清理**：关闭或删除 notebook 时，`src/main/index.ts` 先调用 `closeSession`；`src/main/agent/notebook/analysis-jupyter-sessions.ts` DELETE `/api/sessions/<id>` 后移除内存记录，interrupt 则 POST kernel interrupt。`analysis:stopJupyter` 先关闭项目全部 session、停止 watcher，再让 registry `SIGTERM` Jupyter；主窗口退出时 `cleanupMainWindowRuntime` 释放 watcher 并 `disposeAll()`。当前本地路径没有进程组升级清理，且异常退出后的固定端口 Jupyter 可能被下一次启动接管；远程实现不得复制这种“可接管孤儿”的语义。

七个 agent 工具对本机资源的实际依赖如下；这些依赖解释了 R2.5 为什么必须继续 fail-closed，直到 R4 后端注册完成：

| 工具 | 当前本机依赖（代码依据） | R4 后替换点 |
| --- | --- | --- |
| `notebook.list` | `analysis-notebooks.ts` 的本机 `readdirSync/statSync/realpathSync` | `WorkspaceHost.fs.glob/list/stat`，沿用深度、数量与忽略目录上限 |
| `notebook.read` | `analysis-notebook-files.ts` 读取本机绝对路径；executor 以内存 map 缓存草稿 | host 内项目路径 + `readRange`，草稿仍留桌面内存 |
| `notebook.insert_cell` / `update_cell` / `delete_cell` | 必须先从本机文件建 state；之后只改主进程内存并发 draft event | 文档变更逻辑不变，只替换 state 初次装载的文件后端 |
| `notebook.run_cell` | 本机 kernel 探测、Jupyter 子进程、HTTP/WebSocket localhost 连接 | 服务器登录节点的 Jupyter/内核 + 桌面本机 SSH tunnel endpoint |
| `notebook.save` | `writeFileSync` 写本机 `.ipynb`，以 document revision 防冲突 | `WorkspaceHost.fs.writeAtomic(expectedHash)`；revision 与远程文件 hash 双重防覆盖 |

### R4.2 远程总体方案

**共享上层、替换两个后端。** 抽出 `NotebookWorkspace`（list/open/create/save/delete/watch）与 `JupyterRuntimeBackend`（status/start/stop/connection）两个窄接口；本地 adapter 包装现有 `node:fs`/`JupyterServerRegistry`，SSH adapter 使用 `RemoteRuntimeWorkspace.projectHost`/`runtimeHost` 和远程 Jupyter lease。`AnalysisNotebookSessionRegistry`、`AnalysisNotebookExecutor`、Notebook document 变更函数、现有 IPC payload 与工具 schema 保持共享，避免形成第二套“remote notebook”。远程失败绝不读取或写入本机 remote-project anchor。

**文件后端。** `.ipynb` 的发现、打开、创建、删除、保存全部经 `WorkspaceHost.fs`，路径始终相对服务器 canonical project root 并复用 host 的 realpath/符号链接边界。读取以有上限的 `readRange` 循环完成，解析和草稿仍在桌面主进程内存；保存使用 `writeAtomic(expectedHash)`，磁盘 revision 与打开时内容 hash 任一不匹配都要求重新载入，不做最后写入获胜。远端 `watch` 不可用时，只在 notebook 页面打开期间对已打开文件做低频、可取消轮询；为保持列表的 `modifiedAt` 与避免每次全量下载，R4 需要让 host stat/list 暴露受契约测试约束的 mtime，NFS 时间粒度不足时仍以内容 hash 为最终冲突依据。

**环境与 kernelspec（依赖 R2.5b）**。R4 不直接拼 micromamba 命令，也不另建环境索引；它按 R2.5b 文档定义的远程环境服务接口解析、创建、复用和取消环境。首次准备的默认远程 Jupyter 环境必须由 R2.2 安装的 micromamba 建在 `<runtime-root>/envs/<内容哈希>/`，至少包含 Python、`jupyter_server`、`jupyter_client`、`ipykernel`；同一完成标记有效时复用。默认 `phi-python` 可直接指向这个环境。其他受管/用户选择的服务器环境必须显式解析为远端 prefix：Python kernel 要有 `ipykernel`，R kernel 要有 `r-irkernel`；缺依赖时通过同一远程环境服务创建派生环境并走既有确认/取消流程，不原地污染用户环境，不使用桌面端 Python/R。kernelspec 只写 `<runtime-root>/jupyter/kernels/`，argv 指向服务器 prefix。host/unmanaged kernel 只有在用户明确选择了服务器上的环境或精确 kernelspec 时才登记，绝不从桌面复制 host spec。当前 R2.5b 对带额外源码包的基础环境会拒绝，因此 `phi-r` 完整环境若仍受此限制，R4 必须先提供一个可由 conda 包完整构建的精简 R notebook 环境，或等待 R2.5b 补齐该能力；不能把 R 支持标为完成却退回服务器系统 R。

服务器无法访问 conda 源时，环境服务必须原样收敛为可操作的失败：说明“无法安装含 Jupyter + ipykernel 的远程 Notebook 环境”，引导用户配置服务器管理员提供的 conda 镜像，或在可联网机器预构建后迁移到该 runtime root；不得改在本机创建、不得无限重试，也不得启动缺包的半成品环境。

**Jupyter 进程与 SSH tunnel。** Jupyter Server 和所有 kernel 都运行在服务器登录节点，cwd 为服务器项目目录；Jupyter 仅绑定服务器 `127.0.0.1` 的随机高位端口，`port_retries=0`。桌面先向操作系统申请随机本机 loopback 端口，再启动系统 OpenSSH：`ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>`，加 `ExitOnForwardFailure=yes` 并沿用已验证的 host profile、主机密钥、BatchMode、identity 与 keepalive 规则。当前 `src/main/agent/workspace-host/ssh-host.ts` 明确把 `forwardPort` 标成未实现，helper 协议也没有该方法，所以本阶段由独立的系统 SSH tunnel/lease 实现，**不走 helper、不因 helper 可用而换路径**。

为保证无孤儿，tunnel 与远端 supervisor 采用同一条长连接 lease：远端固定 launcher 以前台 shell 持有一个独立 Jupyter 进程组，安装 `EXIT/HUP/TERM` trap，依次 TERM、限时等待、KILL 整组；桌面关闭该 SSH 子进程就同时关闭 `-L` tunnel。正常 session/project 释放、手动 stop、连接失败、应用退出都必须等待这条清理链收敛。突然断网时，本机 keepalive 使 SSH 失败，服务器侧 sshd 会关闭会话并触发 trap；重连前必须确认旧 lease 已退出，不能靠固定端口“接管”旧 Jupyter。若无法确认清理，阻止第二个 runtime 并提示用户，而不是冒险并存。

**token 与运行时文件。** 每次 lease 用桌面 `crypto.randomBytes` 生成至少 256 bit token，只保存在主进程 runtime record 和远端进程环境内；通过 SSH stdin/敏感环境通道传递，不出现在本机或远端 argv、状态对象、错误、telemetry、Jupyter banner、测试快照或任何文件。Jupyter 必须关闭包含 token 的 server-info/redirect 文件写入；该选项在打包的 Jupyter 版本上要有自动化断言。HTTP 使用 `Authorization: token ...`，WebSocket URL 仅在内存中短暂构造且日志 sanitizer 必须同时遮蔽精确 token 与 `token=` 参数。远端 Jupyter data/config/runtime 目录可以写 `<runtime-root>/jupyter/`，kernel connection file 也可存在，但其中不得出现 Server token。端口、PID、非敏感 lease id 可以记在内存状态；不持久化 token。

**资源边界。** 登录节点只允许交互式、轻量 notebook：每项目只启动一个 Jupyter Server，kernel 数量、单 cell 时限、进程组 RSS/CPU 与线程数均设可配置上限；默认给 BLAS/OpenMP 类变量保守线程数，并以 `nice` 降低优先级。服务器有 `prlimit`/等价能力时在进程组启动前施加硬限制；没有时由 supervisor 周期采样进程组总 RSS/CPU，越限先 interrupt、再 TERM/KILL，并在 UI 说明站点限制。能力探测无法可靠执行上限且管理员策略要求硬限制时，Notebook 标为不可用，不能无上限运行。环境创建也沿用 R2.5b 的超时、输出上限和 AbortSignal。

### R4.3 生命周期、断线重连、取消与冲突语义

```text
stopped
  -> preparing_environment
  -> allocating_ports
  -> starting_lease
  -> probing_through_tunnel
  -> ready

ready -> stopping -> stopped
任一启动态 -> cleaning -> stopped | error
ready -- SSH/tunnel lost --> disconnected -> cleaning -> stopped
stopped -- 仍有打开的 notebook 且远程连接恢复 --> preparing_environment（新 token、新端口、新 kernel）
```

- `preparing_environment` 可安全重试并按内容哈希复用；取消时把 AbortSignal 交给 R2.5b 服务。后续各启动态取消都关闭本机 SSH 子进程并等待远端进程组退出；清理操作幂等，TERM 超时后 KILL，最终同时断言 tunnel 已关、Jupyter PID/进程组不存在、session registry 已清空。
- `ready` 只在带 token 的 `/api/status` 通过**本机 tunnel endpoint**后成立；禁止直接访问服务器端口。服务器随机端口冲突时杀掉当次 lease 后换端口重试；本机端口占用或 OpenSSH `ExitOnForwardFailure` 时关闭失败 tunnel、重新向 OS 取端口，重试次数有限且不改变远端监听范围。
- 关闭单个 notebook 先 DELETE 对应 Jupyter session/kernel；关闭最后一个 notebook 是否立即停 server 由下文待决的 idle policy 决定。关闭 Phi 远程会话、释放项目、SSH 断线或应用退出则无条件停止整个 Jupyter 进程组并关闭 tunnel，不等待 idle timeout。
- 执行中的用户取消先 POST kernel interrupt；在宽限期内没有回到 idle，就 DELETE 该 session；仍无法确认时终止整个 lease。取消后的 cell 保留取消前草稿，不伪造 outputs，也不自动保存。
- 断线中的执行结果标成 `unknown/disconnected`，**绝不自动重放 cell**，避免重复写文件、提交作业或产生外部副作用。连接恢复后创建全新 Jupyter/runtime session；桌面内存草稿保留，已保存内容从远端文件重读，旧 kernel 变量状态明确丢失并在 UI 标出“kernel 已重启”。空闲时可以按策略自动重连；执行中断后的重新执行必须由用户触发。
- 本机固定端口的“发现旧 Jupyter 后接管”只属于当前 local backend；remote backend 每次使用新 token、双端随机端口和受 lease 所有权约束的 PID/进程组，不接管未知进程。

### R4.4 与 Slurm 的关系

本阶段**只覆盖登录节点**，不提交 Slurm 作业，也不把 kernel 偷渡到计算节点。这样可以先验证文件、环境、tunnel、session、输出和清理闭环；同时 UI 必须写明“当前 kernel 在登录节点”，资源上限默认按登录节点策略执行。若站点禁止登录节点运行 Jupyter/内核，R4 本阶段应直接标为不可用，而不是绕开策略。

计算节点 kernel 后续仍有必要：大内存/GPU/长计算应在调度资源内运行。扩展方向是在共享 runtime root 写非敏感 connection metadata，由一个受管 kernelspec launcher 提交 `sbatch`/`srun`，记录 job id，等待分配节点后让登录节点 Jupyter 连接到计算节点 kernel；必须先探测登录节点与计算节点间的 ZMQ 端口可达性、共享目录、作业最长时间及站点防火墙。另一可选方案是把整套 Jupyter Server 放进 Slurm 作业，再经登录节点跳转 tunnel。无论采用哪种，都需要取消时 `scancel`、断线租约/超时清理、作业重连身份和五个 kernel channel 的安全转发；这些均不在 R4 实现范围，不能复用本阶段的单 HTTP `-L` 就宣称支持。

### R4.5 实施拆分与验收

按下列顺序做小步提交；每步只在实现阶段改对应范围。本机自动化统一用现有 bash/local-shell 夹具冒充 SSH，并把可执行的假 `jupyter`/假 kernel 放进临时 remote env；假脚本必须能记录**已脱敏** argv、模拟 REST/WebSocket、端口占用、长运行、SIGTERM/SIGKILL 与断线，测试不得连接外网或真实服务器。

| 顺序 | 范围与涉及文件 | 本机测试与验收 | 必须真机验证 |
| --- | --- | --- | --- |
| R4-I1 host-aware 文件层 | 抽出 `src/main/agent/notebook/analysis-notebooks.ts`、`analysis-notebook-files.ts`、`analysis-notebook-watch.ts` 的 `NotebookWorkspace`；让 `notebook-tool-executor.ts` 注入它；必要时扩展 `workspace-host/types.ts` 的 mtime 契约 | 同一套 list/open/create/save/delete/越界 symlink/冲突/大文件上限测试参数化跑 LocalHost 与假 SshHost；断言远程模式零本机 anchor 读写，atomic hash 冲突不会覆盖 | NFS 上 mtime/hash 冲突与原子 rename 语义 |
| R4-I2 **依赖 R2.5b：环境与 kernelspec** | 通过 R2.5b 公共环境服务准备 `<runtime-root>/envs/` 下的 Jupyter + ipykernel 环境；涉及 `src/main/agent/remote-runtime/controller.ts`/环境服务的公开调用面、`resources/runtime/environments/phi-jupyter/environment.yml` 或等价远程声明，以及新的 remote kernelspec adapter；以 R2.5b 最终文档接口为准，不复制其内部实现 | 假 micromamba 覆盖首次创建、内容哈希复用、缺失 binary、取消、输出截断、源不可达、Python/user/R kernelspec；断言 prefix/argv 全在服务器路径且没有本机 solver/build | 在线源、站点镜像、完全离线三种路径；Python kernel；R kernel 若本阶段宣称支持则必须实测 |
| R4-I3 系统 SSH lease/tunnel | 新增 notebook 专用 OpenSSH `-L`/supervisor（建议放 `workspace-host/ssh-port-forward.ts` 与 `notebook/remote-jupyter-server.ts`）；让 `remote-workspace-boundary.ts` 提供经授权的 connection config；`ssh-host.ts` 的 helper 仍不承担 forward | fake ssh 检查 `127.0.0.1` 双端绑定、随机端口、`ExitOnForwardFailure`、host profile 参数、token 不在 argv/log/file；fake jupyter 覆盖 ready、冲突重试、启动取消、断线与 TERM->KILL，结束后进程组和 tunnel 均为 0 | 真实 OpenSSH 配置/identity/ControlMaster 组合、真实 `-L`、拔网/杀客户端/退出 Phi 后服务器无残留 |
| R4-I4 共享 runtime/session/execution | 引入窄 `JupyterRuntimeBackend`，让 `analysis-jupyter-sessions.ts`、`analysis-jupyter-execution.ts` 同时使用 local/SSH connection；remote 禁止固定端口接管 | 复用现有 Jupyter session/execution 测试；假 HTTP/WebSocket 验证 token、XSRF、execute_reply+idle、错误输出、30 分钟超时的可配置替身、interrupt/delete/escalation、断线不重放 | 打包 Jupyter 版本的 REST/WebSocket、token/server-info 行为与大输出回流 |
| R4-I5 IPC 与 UI 路由 | `src/main/index.ts` 按 project location 解析两个 backend；`src/preload/index.ts`、`src/preload/index.d.ts`、renderer analysis/runtime hooks 保持现有 `analysis.*` 形状，只增加必要的 remote 状态/错误文案 | main integration + renderer tests覆盖远程 list/open/save/start/status/execute/interrupt/close；断言所有返回 path 是服务器语义且 UI 显示登录节点、重连和 kernel 重启 | 真实 Phi 逐项点击与窗口关闭/重开 |
| R4-I6 工具放行 | 远程 worker 注册同一组 `buildNotebookCustomTools`，host handler 路由到远程 workspace/runtime；更新 `remote-project-tool-guard.ts` 只放行精确注册且描述匹配的七个 `notebook.*`；`lib.*` 继续拒绝 | 七工具端到端：list/read/insert/update/delete/run/save；审批级别不变；未知/同名 builtin/缺后端继续 fail-closed；无本机 anchor 回退 | 在远程对话中执行一轮读取、插入、运行、保存并从服务器核对文件 |
| R4-I7 资源与恢复门禁 | supervisor 加 kernel 数、线程、RSS/CPU、idle、cell timeout 和最终清理；接入远程 session/project/app lifecycle | 假 `ps`/`prlimit` 覆盖越限、无法限额、idle、并发 kernel、断线恢复、旧 lease 未清理时拒绝二次启动；活动句柄测试无 timer/child 泄漏 | 登录节点实际限制工具与管理员策略；长 cell 取消；30 秒级断网；进程/端口清零且未提交 Slurm 作业 |

完成门禁：现有 local Notebook 测试不得改语义；新增 remote 契约与 main integration 全过；`bun run typecheck`、`bun run lint`、`bun run check:architecture` 通过。真机记录必须脱敏，只写版本、状态、耗时和“进程/端口是否清零”，不写主机名、用户名、token、私有路径或环境变量。

### R4.6 风险与待用户决定

**已识别风险**：OpenSSH 通用选项当前含 `ClearAllForwardings=yes`，专用 tunnel builder 必须用测试证明显式 `-L` 没有被清掉；不同 Jupyter Server 版本对 token 环境变量、server-info 文件和 banner 的行为可能不同，必须锁定版本并测试；NFS mtime/rename/锁语义可能导致外部编辑冲突；登录节点缺 `prlimit` 时只能由 supervisor 监控；R2.5b 尚未支持的源码包会阻塞完整 R kernel；硬断网期间清理只能依赖 sshd/keepalive lease，恢复连接前必须对账；大型富输出会占用 WebSocket、主进程内存和 `.ipynb`，需要沿用/补充单消息与单 notebook 上限。

待用户决定：

- 是否默认允许 Jupyter 在登录节点长期运行；建议默认只允许交互会话，关闭远程 Phi session 即停，并在最后一个 notebook 关闭后进入短 idle grace。
- idle timeout、单 cell timeout、最大并发 kernel、线程数、进程组 RSS/CPU 的默认值，以及站点级覆盖入口。
- 空闲断线后是否自动重建 Jupyter/kernel；建议空闲时有限自动重连，执行中断时只恢复连接、不自动重放 cell。
- 是否允许登记任意服务器 user/host kernel，还是 beta 首批只允许 R2.5b 管理的环境；建议首批只允许受管环境 + 用户显式选择且通过依赖检查的 prefix。
- `phi-r` 是在 R4 首批通过精简 conda-only 环境交付，还是等 R2.5b 支持额外源码包后再宣称与本地 R kernel 对齐。
- 关闭最后一个 notebook 是立即停 server，还是保留短暂复用窗口；无论选择哪种，远程会话/项目释放、SSH 断线和应用退出都必须立即清理。

### R4-I1 完成记录（2026-10-10）

已抽出 host-aware `NotebookWorkspace`，`list/open/create/save/delete/watch` 可统一经
`WorkspaceHost.fs` 运行，工具 executor 支持按 cwd 注入该文件后端；现有本地同步入口与
测试语义保持不变。LocalHost 与本机 bash 假 SshHost 共用的契约已覆盖远程 anchor 零本机
访问、越界符号链接、路径注入、1 MiB 上限、mtime、revision/内容 hash 冲突、
`writeAtomic(expectedHash)` 竞争保护和可取消 watch 轮询。R4-I1 未接入 IPC/UI/Jupyter
runtime，也未放行任何远程 `notebook.*` 工具；这些仍由 R4-I5/R4-I6 负责。

### R4-I3 完成记录（2026-10-10）

已新增 notebook 专用系统 OpenSSH `-L` tunnel 与远程 Jupyter lease/supervisor 底座：
tunnel、远端 launcher 与 token stdin 共用同一条 SSH lease；本机和服务器端口均为随机回环
端口，专用 argv 显式保留 `-L`、启用
`ExitOnForwardFailure=yes`，且不继承会清空转发的 `ClearAllForwardings=yes`。每次 lease
使用 `crypto.randomBytes(32)` 生成新 token，只经 SSH stdin 进入远端 Jupyter 环境；Jupyter
关闭 server-info/browser-open 文件写入，状态、argv、文件、错误和分块日志均不保存 token。
远端 launcher 以 `setsid` 持有 Jupyter 进程组，SSH EOF、tunnel/lease 断开、主动 stop 与进程
退出都执行组/PID/组的 TERM→KILL 清理，并覆盖取消发生在 `setsid` 前的竞态；只有 PID/PGID
消失后的非敏感 cleanup ack 才允许回到 stopped，硬断线无法确认时阻止第二个 runtime。本机
tunnel 失败和服务器端口冲突均有限重试。自动化只使用本机 Bash/Perl 假 SSH 与假 Jupyter，
覆盖双端绑定、host profile 参数、脱敏、重试上限、断线、无孤儿进程和活动句柄收敛。本步未接
IPC/UI、远程环境服务或任何 `notebook.*` 工具放行，也未连接真实服务器；真机 OpenSSH、
ControlMaster、拔网与应用退出验证仍按 R4-I3 真机门禁保留。

### R4-I2 完成记录（2026-10-10）

已增加远程 `phi-jupyter` 固定声明（Python 3.12、`jupyter_server` 2.21.1、
`jupyter_client` 8.10.0、`ipykernel` 7.4.0）和独立 remote kernelspec adapter。adapter
只调用 R2.5b `RemoteEnvironmentService.request/bindSession` 创建、复用并绑定
`<runtime-root>/envs/<内容哈希>/`，不复制环境服务实现、不自行拼 micromamba 命令；随后只在
服务器 `<runtime-root>/jupyter/kernels/` 写绝对服务器 argv，并按现有
`AnalysisKernelDiagnostics` 形状列出/选择默认 `phi-python`。adapter 不把服务器 prefix 写入
日志，返回 UI 的诊断也不包含 prefix；缺 micromamba、conda 源不可达和创建失败继续携带
`env_request` 的中文恢复建议且不回退本机。首批只默认允许受管 kernel；
`allowUserPrefixes` 开关默认关闭并清理旧 `host-*` spec，显式开启后也必须先在服务器用所选
prefix 的 Python 通过 `ipykernel` 导入检查，才登记为只能精确选择的 unmanaged kernel。自动化
仅使用本机假 SSH/micromamba，覆盖首次创建、内容哈希复用、三类失败提示、
kernelspec 列出/选择、服务器路径约束、用户 prefix 默认拒绝及依赖门禁。本步未声明 R kernel，
未接 IPC/UI、未放行任何远程 `notebook.*` 工具，也未连接真实服务器；在线源、站点镜像和完全
离线迁移仍按 R4-I2 真机门禁保留。

### R4-I4 完成记录（2026-10-10）

已新增仅含 `status/start/stop/connection` 的窄 `JupyterRuntimeBackend`，local adapter 继续复用
固定 `127.0.0.1:28888`、空 token 和旧 Jupyter 接管语义；SSH adapter 先经 R4-I2 adapter
准备受管环境与 `phi-python` kernelspec，再用该环境的绝对 `bin/jupyter`、服务器项目 cwd、
Phi 专用 Jupyter 目录和 R4-I3 supervisor 启动 lease。远程 ready 仍只由带 token 的本机 tunnel
`/api/status` 探测成立，不直接访问服务器端口，也不进入 local 的固定端口接管路径；环境准备可
随 AbortSignal 取消。

共享 session/execution 客户端现以非敏感且每次 runtime 唯一的 `runtimeId` 隔离 XSRF 与
session/kernel：lease 换代后旧 session 只从桌面内存移除，不向新 server DELETE/interrupt，
下一次显式 ensure 才创建新 kernel。HTTP token 仅进入 `Authorization`，WebSocket token 仅在
内存 URL 中短暂构造，状态与错误同时遮蔽精确 token 和 `token=`；执行仍只发送一次
`execute_request`，须同时收到 `execute_reply` 与 `idle` 才完成，默认 30 分钟且测试可替换，
断线、错误或超时均不自动重放。关闭最后一个 notebook 只 DELETE session，server idle policy
仍留给 R4-I7。

自动化使用纯内存假 HTTP/WebSocket 与 R4-I3 的本机假 SSH/Jupyter，覆盖 token、XSRF、
interrupt/delete、错误输出、超时替身、断线不重放、换代新 token/端口/kernel、并发 start 合并
及最后 session 关闭语义。本步未接 IPC/UI、未放行远程 `notebook.*` 工具、未增加资源限制，
也未联网或连接真实服务器；打包 Jupyter 的 REST/WebSocket、server-info 与大输出回流仍保留为
真机门禁。

### R4-I7 完成记录（2026-10-10）

远程 Jupyter launcher 现按 `prlimit`、`ulimit`、只读 `ps` 进程组监控的顺序施加或核对资源
边界；硬限额不可用或被管理员策略拒绝时会在状态中明确标为降级并继续低频监控，不再静默无限
制。站点配置要求硬限额时，探测失败会在启动 Jupyter 前标为不可用。监控汇总进程组 RSS、CPU
时间与线程数，越限或监控本身不可用均 fail-closed，先 TERM 后由既有 lease 最终 KILL 整组；
BLAS/OpenMP 线程环境也随 lease 注入。资源 watcher、sleep、idle timer、Jupyter 进程组与 SSH
tunnel 共用最终清理链。

session registry 只在 remote backend 提供资源接口时执行 kernel claim/release/activity，local
Notebook 语义不变；remote backend 另暴露可供 R4-I5 调用的资源状态、cell timeout、
`releaseProject` 与 `disposeAll`。最后一个 notebook 关闭后进入 idle 计时，远程 session 关闭、
项目释放、SSH 断线和应用退出均可直接走 `stop`，不等待 idle。R4-I3 的旧 lease 清理未确认即
拒绝二次启动保持不变。自动化只使用本机假 `ssh`/`jupyter`/`prlimit`/`ps`，未联网、未连接
真实服务器；登录节点工具、管理员策略与断网清零仍保留为真机门禁。

以下均为**待用户确认的默认值**，可由站点/调用方覆盖：

| 项目 | 默认值 |
| --- | --- |
| 单项目 Jupyter 服务 RSS | 4 GiB（硬限额用 address-space 近似，监控核对实际 RSS） |
| 同时 kernel 数 | 2 |
| BLAS/OpenMP 线程数 | 2 |
| 进程组总线程数 | 16 |
| 进程组 CPU 时间 | 30 分钟 |
| idle timeout | 30 分钟 |
| 单 cell timeout | 30 分钟（沿用现有执行默认值） |
| 资源监控间隔 | 5 秒 |
| 站点必须具备硬限额 | 否；默认允许明确提示后降级为监控 |

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
    - **第 2 步 R2.2 远程 micromamba（2026-10-10，提交 `d26a512f`、`ff0e74ca`、`25ff8cac`）**：Linux x86_64 与 aarch64 的 micromamba 2.9.0-0，由用户在设置里点击安装（需先过运行时根目录检查与警告确认）；版本目录布局为 `<runtime-root>/bin/micromamba-<version>/micromamba`，保持幂等与版本并存，并在隔离环境中实际验证 `micromamba run`。旧的 `<runtime-root>/bin/micromamba-<version>` 文件布局会标记为不可用于 `run`，重新安装时保留旧二进制后迁移到新布局；能力档案只记脱敏状态。下载来源经两次真机反馈才定型：
        - 第一版“桌面下载再上传”被用户指出设计错误（服务器能联网就应自己下载）。第二版只探测一个地址，实测两台服务器的 github.com 时通时断，探测曾误报可达，随后下载空等约 5 分钟才回退。
        - 现行为：候选来源按“GitHub 主地址 → 用户在设置里填的镜像前缀 → manifest 镜像前缀（gh-proxy.com、ghfast.top）”顺序，每个来源先做约 256 KiB 的测速（要求不低于 50 KiB/s、共享约 8 秒），实际下载 20 秒低速即放弃、整体时限随文件大小最高 600 秒；每个来源下载的文件都用固定的 SHA-256 与大小校验，错误页面一类的文件丢弃并换下一个来源；全部来源失败才由桌面通过 SSH 中转。进度与档案只出现来源的主机名。
        - 干净副本验证：tsc 三项 0 错误；77 个测试文件 668/668；架构检查与资源检查通过。
        - 真实服务器验证（GPU、HPC-node3，随机子目录内操作并在结束时删除）：中转路径（首版）两台首次安装、重复安装（幂等）、二进制被截断后的识别与修复、不支持平台、错误哈希全部符合预期；现行为下两台均由服务器直接下载（GitHub 当时可达：GPU 8 秒、HPC 18 秒，桌面下载次数 0）；把主地址换成不存在的域名后，两台均自动改用 gh-proxy.com 直接下载成功（GPU 4 秒、HPC 14 秒）。已确认两台服务器都能访问 conda.anaconda.org（约 1 MB/s），因此 R2.3 可直接在线从 conda-forge 构建环境。
        - **遗留**：设置页（镜像输入、状态、进度）只有组件测试，没有在真实 Phi 界面里点过；`ghfast.top` 速度偏低（约 0.3 MB/s），gh-proxy.com 为第三方服务，可用性不受我们控制，故保留用户自填镜像与桌面中转两道后备。
    - **ripgrep 受管安装记录（R2.2 补充，2026-10-10）**：服务器 PATH 没有可用 `rg` 时，用户可在「设置 → 远程主机」用已安装的 micromamba 显式创建独立前缀 `<runtime-root>/tools/ripgrep-<version>/`；临时前缀经 `rg --version` 验证并写完成标记后原子激活，重复操作复用有效版本。Phi 不自动安装 micromamba 或 ripgrep；缺少 micromamba 与 conda 源不可达分别给出设置入口和镜像/预构建提示。本记录仅经假远端测试，未连接真实服务器、未联网。
    - **R2.5b/R2.6 远程 skill、环境与全局 MCP 的真机验证与修正（2026-10-10，提交 `e4dea602`、`dc31b66b`、`7488a224`、`6c67a77d`）**：
        - 干净副本验证：tsc 三项 0 错误，eslint 0 错误，171 个测试文件 1436 项；并行跑时的 5 个超时单独跑均通过。
        - **真机发现并修正一个真实缺陷**：micromamba 要求可执行文件名必须是 `micromamba`，R2.2 装成了 `micromamba-<版本>`，`create` 可用但 `run` 的激活钩子失败（`unknown MAMBA_EXE`），`skill_run` 脚本虽然退出码 0，环境并未激活。R2.2 当时只验证了 `--version`，测试用的假 micromamba 也不检查文件名。修正：安装为 `bin/micromamba-<版本>/micromamba`，安装后加一次离线 `run` 验证，旧布局识别为不可用且原样保留，假 micromamba 改为与真实二进制一样检查文件名。
        - 修正后真机（GPU、HPC-node3，随机子目录内操作并清理）：环境创建（GPU 12 秒，HPC 约 4 分钟）与复用、环境内 `python` 来自服务器环境且 `import six` 成功、`stderr` 为空；`skill_run` 在服务器项目目录运行并读到随 skill 上传的依赖；运行中取消后无残留进程；`../` 越界被拒绝；缺 micromamba 时明确拒绝并指引、不回退本机。
        - **性能**：HPC 登录节点单次 SSH exec 约 1 秒、纯 SSH 的单次文件操作约 3 秒（GPU 为 15 毫秒与 0.3 秒），导致 `skill_run` 复用路径约 230 秒。已压缩往返次数（skill_run 首次上传 25→5、复用 24→4、脚本工具 20→3、env_request 创建 9→6、复用 9→2），由计数型 WorkspaceHost 测试守住上限。**优化后的真机耗时尚未重测。**
    - **ripgrep 受管安装（R2.2 补充，2026-10-10）真机验证**：两台服务器的 PATH 里都没有 `rg`。受管安装（micromamba 前缀 `tools/ripgrep-<版本>/`，服务器直接下载）：GPU 4.3 秒、HPC 16.4 秒，版本 15.2.0；重复安装为 already-installed（GPU 0.04 秒、HPC 2.9 秒）；受管 `rg` 遵守 `.gitignore`（2 个文件），回退的 `grep` 不遵守（3 个文件）；无临时前缀残留，测试目录已清理。干净副本验证（HEAD `182558f0`）：tsc 0 错误，92 个测试文件 755 项，唯一失败是他处改了提示文案而测试未同步，已修（`6c67a77d`，同时恢复“安装 micromamba”按钮指引）。**尚未验证**：设置页的 ripgrep 状态与按钮在真实界面中的表现；远程 `grep` 工具在带项目注册表的真实会话里实际选用受管 `rg`。
    - **R4-I1/I2/I3（2026-10-10，提交 `d812dff4`、`0ce01038`、`b9d4e86b`）**：notebook 文件层经 `WorkspaceHost`、远程 Jupyter 环境与 kernelspec、系统 `ssh -L` 隧道与进程 lease 三块底座已提交，均未接 IPC/界面、未放行 `notebook.*` 远程工具。干净副本验证：tsc 0 错误，Go vet/test 通过，135 个测试文件 1001 项（999 通过、2 个需显式开关的集成测试跳过）。**真机门禁未做**：拔网与应用退出后服务器清零、真实 Jupyter 对 token 与 server-info 开关的行为、真实 OpenSSH ControlMaster。
    - **第 2 步 R2.5 远程工具分类（2026-10-10，提交 `36c911ae`）**：远程项目此前只放行文件工具与 Wrapper 工具，其余全部拦截。现按工具逐个分类（见上文 R2.5 小节）：与项目文件系统无关的工具直接放行；`present_files`、`download_file`（服务器直接下载，仅 HTTPS、固定公网 IP、禁代理与重定向、硬链接发布不覆盖）、skills 读取走服务器；系统提示词带脱敏的运行时根目录与 micromamba 状态。`skill_run`、动态 skill 脚本、`env_request`、MCP、Office、notebook 等仍拒绝并说明原因与替代做法，不回退本机。干净副本验证：tsc 0 错误，116 个测试文件 981 通过 0 失败 1 跳过。**尚未做真机验证**（R2.5b 之后一并做）。
    - **ripgrep 搜索接入记录（R2.5 补充，2026-10-10）**：远程 `grep`/`glob` 依次使用服务器 PATH 的 `rg`、完成标记有效的最新受管 `rg`、有界 `find`/`grep -E` 回退；结果引擎区分 `rg`、`rg-managed` 与 `find`。回退仍不应用 `.gitignore` 且通配符受限，提示用户去远程主机设置安装；远程系统提示词只报告系统已有/受管/未安装三态，不含路径或用户名，并禁止 agent 自动安装。
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
