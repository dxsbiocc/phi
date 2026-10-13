# OMP 解耦、远程运行时与 OMP 升级计划

状态：**阶段 1（T0–T7）已验收并经用户授权合入 main（`6d9d9ef3`）**。用户要求 T8 暂留分支并继续后续任务；main 未再修改。T8–T10 已完成各自的代码审查与自动化验收，人工清单仍待验证。T11 网关、隧道与生命周期基础、T12 宿主桥基础、T13 主审批基础、T15 存储与恢复基础均已通过独立审查并保存分支提交；完整产品接入继续实施。提供商矩阵发现 Anthropic opaque thinking 与仅终态注册 API 的兼容缺口，保留失败证据并实施适配。进度及验收边界见 [远程运行时验收记录](../runtime/omp-remote-acceptance.md)。2026-10-14 更新；Codex 负责接替 Claude 管理与审查。
创建日期：2026-10-12
执行：Codex 原生 subagents；负责人：当前 Codex 主会话（任务拆分、进度管理、独立质量审查与最终验收）。所有项目验证命令使用 `bun run`；限定测试采用同一脚本的 Node runner，避免参数附加后误跑全套。
关联文档：`docs/roadmap/remote-parity-implementation.md`、`docs/roadmap/internal-beta-implementation.md`、`docs/architecture/frontend-feature-boundaries.md`

> 路线图说明：internal beta 路线图要求"把 SDK 会话文件视为实现细节"，本计划沿同一方向把 OMP 收敛为可替换的引擎。远程/HPC 在 beta 路线图里排在 beta 之后，但用户已在 2026-10-08 把远程能力对齐提到当前优先级；本计划第 3 阶段是该工作的结构性收尾，不夹带新功能。
>
> 架构决定（用户 2026-10-13 确认）：远程项目改为**在服务器上运行 OMP**，桌面端通过 SSH 以 RPC 方式驱动它；本地项目继续在本机进程内运行 OMP。这推翻了 `remote-parity-implementation.md` 中"不把智能体运行时搬到服务器"的非目标。依据见第 0.4 节。

---

## 接管核对（2026-10-13）

用户此前要求“等阶段 1 做完再合并”。下表区分已提交成果和本轮已验收成果；历史验证报告不替代本轮验收。

| 任务 | 已保存成果 | 当前状态 |
|---|---|---|
| T0 基线与边界检查 | `70aa7cb9` | 已合入 `main` |
| T1 `PhiTool` 与目录迁移 | `f66875fe` | 已实现并通过集成验收；M2 参数过滤及 browser union schema 已补齐 |
| T2 `PhiSettings` | `571b20c1` | 已实现并通过本轮审查及集成验收 |
| T3 `PhiAuth` | `049ac371`（由 `9084f84a` 合入 T2） | 已实现并通过本轮审查及集成验收 |
| T4 内部函数/MCP 收口 | `99845de2` | 已实现并通过本轮审查及集成验收 |
| T5 worker 拆分、`PhiEngine` | `5f6e22ca`、`d422a51b` | 已实现并通过集成验收；Phi 自有事件/摘要契约已补齐 |
| T6 Phi 扩展包 | 原 `t6-extension-package` 工作区的未提交成果已保留 | 恢复完成并通过独立审查、构建及全套测试；原工作区保留 |
| T7 引擎契约测试 | 基于 T5 的独立副本 | 13 个真实 worker 契约通过，含审批、中断、子会话、恢复、API key/OAuth 存储状态 |
| T8 OMP 升级 | `codex/omp-upgrade-18-10-3`，精确锁定 18.10.3 | 实现、独立审查及自动化验收通过；人工清单待验证 |
| T9 R1 分发部署 | `3e8462a8`；候选分支整合为 `46df9dc8` | 独立 APPROVE；两项缓存缺陷红绿修复；18.10.3 下复跑 27/27 和专用测试类型检查通过 |
| T10a 基础 RPC | `codex/omp-rpc-foundation` | 两路独立 APPROVE；协议 26/26，真实基础及回归新增 20/20，原 18 条契约保留通过；生产 typecheck/lint/build/asar 通过；全量 4862 项、0 失败/取消 |
| T10b 扩展启动与部署         | `codex/omp-rpc-bootstrap`                                      | 三路独立 APPROVE；整合核心 159/159 自然退出；生产 typecheck/lint/build/asar 通过，完整串行回归 4930 项、0 失败/取消                                         |
| T11 模型代理与隧道 | `eaabd7b9`，nullable selection `e9a1b77e` | 基础独立 APPROVE；提供商矩阵存在真实兼容失败，完整 R3 未验收 |
| T12 宿主工具桥 | `16e9a23f`，typed errors `18e13c4b` | 基础独立 APPROVE；大结果无损传输与实际服务接入继续实施 |
| T13 主会话审批 | `c237d2b6` | 基础独立 APPROVE；真实运行归属与 bridge-ready 接入实施中，产品入口仍只读 |
| T14 子智能体 | 原生 task / 子会话权限设计已完成 | 公开 SDK 接缝调查完成；尚未实施完整 R6 |
| T15 会话存储与恢复 | `ee2cb6e7`、`5e5fc292`、`8801a1ca` | 三块基础独立 APPROVE；持久化启动、严格服务端验证及产品路由继续实施 |
| T17 升级手册 | [操作手册](../runtime/omp-upgrade-runbook.md) | 已记录本次实际升级步骤、验证证据和人工缺口；T8 合入权限单独记录 |
| T8 | 升级到 18.10.x | T6、T7 | 阶段 2 验收 |
| T9 | R1 分发与部署 | T8 | R1 测试通过 |
| T10 | R2 `RpcEngine` 启动与连接，契约测试对 `RpcEngine` 跑通基础用例 | T9 | M8 基础用例通过 |

阶段 1 接管边界：先完成并审查阶段 1。后续 T8 与 T9 在独立副本推进，不连接真实服务器、不扩展 UI。继续保留本计划已注明的测试辅助/评测白名单例外；边界检查通过不代表这些过渡例外已经删除。

T6 沿用原任务的明确范围：本次只整理自包含扩展包、注入 host 与进程内 builder；`-e` 默认入口留 R4/R5，`agents/*.md` 留 D4/R6。它们是待实施能力，不计为本次 T6 已完成的功能。

阶段 1 审查结论：**已达到合并条件并于 2026-10-13 经用户明确授权合入 main**。工具参数过滤、事件契约、远程 guard、独立旧源码对照和模块扫描问题已闭环；T1–T7 分工审查、负责人集成验收均通过。

本轮验收（集成当前 `main` 的 `28793618` 主题改动）：

| 项目 | 结果 |
|---|---|
| 生产 typecheck（node/web/scripts） | 通过 |
| lint / architecture / engine boundary / resources / asar / content checks | 通过；2 条既有 prettier 警告 |
| 集成核心测试 | 40/40 通过 |
| 主进程 VM 集成补测 | 221/221 通过；补齐真实事件模块映射与 SDK 合法压缩事件夹具，业务断言不变 |
| 完整测试（Node runner，并发 4） | 4771 项：4746 通过、0 失败、24 既有跳过、1 既有 todo；288 秒 |
| 生产构建 / asar closure | 通过；已在最终整合代码上复核 |

首轮默认并发运行有 4770 项、236 个失败：222 个由新增事件模块未登记到 VM 测试夹具导致，已经修复；另 14 个在进程/环境探测的时间限制下失败。固定文件并发为 4 后全套零失败；与 `.github/workflows/content.yml` 的现有 CI 配置一致，因此标准 `test` 脚本也固定为 4，保持全部断言、超时和跳过条件。第二轮多出的 1 项来自并入的主题主按钮测试，未删除测试。

附加测试层类型检查：T5/T6 基线 407 项历史诊断；整合当前主分支后为 412，其中增加的 5 项位于主分支已有的 `startup-splash.test.ts`，该文件及生产启动模块与 `28793618` 完全一致。本次迁移和新契约文件无新增诊断；专用契约类型检查通过。

验证边界：真实 OAuth 浏览器/设备交换及刷新、实际自动压缩触发、打包应用的 Finder 人工验证、远程 RPC/真实服务器仍按后续阶段验证。现有 6 个 smoke/eval 引用保持明确过渡白名单。

---

## 0. 背景：现状数据（2026-10-12 核对）

### 0.1 本地与远程各有一套实现

- 本地项目的 `read` / `write` / `edit` / `glob` / `grep` / `bash` 使用 OMP 内建工具；远程项目在 `src/main/agent/omp/omp-sdk-worker.ts` 的 `remoteRoot` 分支里，用同名 CustomTool 替换它们（`src/main/agent/remote-workspace-*-tool.ts`）。两边参数结构不同，例如远程 `read` 只接受 `path`。
- `omp-sdk-worker.ts` 3199 行，含 41 处 `remoteRoot`；`src/main` 下 57 个文件按本地/远程分叉；远程专用代码约 1.1 万行。
- 近期修复（`8dc5de03`、`58bbbe8d` 等）都是"同名工具两套实现、参数不一致"的直接后果。
- **OMP 内建工具没有可替换的文件/执行后端**：18.x 的 `BashToolOptions {}` 为空，grep 源码注释明确"没有文件系统接口"；只有 `legacy-pi-coding-agent-shim` 带 `operations`，但它使用旧参数结构。因此"让 OMP 工具直接跑在 SSH 上"不可行。
- 已有可复用的基础：`WorkspaceHost` 接口（`src/main/agent/workspace-host/types.ts`）、LocalHost 与 SshHost 两个实现、对两者跑同一套用例的 `tests/workspace-host-contract.ts`（由 `workspace-host-local.test.ts`、`workspace-host-ssh.test.ts` 调用）。

### 0.2 与 OMP 的耦合面

- 约 40 个文件直接 import `@oh-my-pi/*`；其中约 20 处为内部子路径（`mcp/manager`、`mcp/client`、`mcp/oauth-flow`、`plan-mode/*`、`session/compaction-methods`、`modes/runtime-init`、`extensibility/legacy-pi-coding-agent-shim` 等）。
- OMP 的 `package.json` 以 `"./*"` 暴露全部内部文件，不承诺内部 API 稳定。
- 多数工具文件只为拿 `CustomTool` 类型而 import OMP。

### 0.3 升级到 18.10.1 的实测结果

在临时 worktree 中把 `@oh-my-pi/pi-coding-agent`、`@oh-my-pi/pi-natives` 从 18.1.10 改为 18.10.1，`bun run typecheck:node` 得到 **58 个错误、3 个文件**（`omp-sdk-worker.ts` 55、`web-search-settings.ts` 2、`featured-mcp-auth.ts` 1）。`typecheck:web`、`typecheck:scripts`、测试与运行时**未验证**。

| 类别 | 数量 | 内容 |
|---|---|---|
| `Settings` 读写方式变化 | 34 | 字符串键 `settings.get('x.y')` / `set` / `override` 被移除，改为每个设置项一个注册对象（`cfgXxx.get(settings)`）。**`Settings` 是包根导出，照样不兼容** |
| `AuthStorage` 方法变化 | 18 | `login`、`logout`、`listStoredCredentials`、`getCredentialOrigin`、`describeCredentialSource`、`hasOAuth`、`hasAuth`、`hasConcreteAuth`、`removeCredential`、`get`、`set` 挪到 `pi-ai` 新的 auth/oauth/pool 接口 |
| 内部路径被删 | 3 | `pi-coding-agent/thinking`（改为包根导出）、`modes/utils/context-usage`（`estimateToolSchemaTokens` 迁到 `@oh-my-pi/pi-tui/status-line/context-usage`）、`config/provider-globals`（移除） |
| 内部导出改名 | 2 | `pi-catalog/provider-models/descriptors` 不再导出 `getCatalogProviderEntry`；`web/search/types` 不再导出 `SEARCH_PROVIDER_CHOICES` |
| 连带类型错误 | 1 | `web-search-settings.ts` 的 `satisfies` 断言 |

changelog 中编译期发现不了的行为变化（18.2.2 起；更早的条目新版 changelog 已截断）：

| 版本 | 变化 | 对 Phi 的影响 |
|---|---|---|
| 18.2.5 | TUI 模块迁到 `@oh-my-pi/pi-tui`，原子路径失效；**包根导出名保持不变** | 解释了 `context-usage` 失效 |
| 18.2.7 / 18.4.4 | bash 去掉 `env` 参数 | 本地 bash 行为变化 |
| 18.2.9 | read 不再支持图片 `?q=` 和裸图片路径 | 本地 read 行为变化 |
| 18.3.0 | edit 补丁语法改为 `*** Edit File / Find / Replace`；`hub` 工具弃用 | 本地 edit 提示词/行为变化 |
| 18.3.4 | `task` 的 `complexity` 改为 `solutionSpace` | Phi 未使用（已 grep 确认），远程 guard 已拒绝内建 `task` |
| 18.5.0 | `SessionStorage.claimSessionFile` 改为 `claimSession` | Phi 未实现自定义 SessionStorage，需确认 |
| 18.6.3 | 恢复会话时模型不可用，`createAgentSession` 直接抛错 | 影响会话恢复与 unavailable-model 处理 |
| 18.8.2 | `task` 等去掉单次调用的 `model` 覆盖 | Phi 未使用 |
| 18.8.5 | 子智能体改为同进程运行，移除 `PI_SUBPROCESS_CMD` | 需确认 Phi 是否设置过该变量 |

OMP 发版频率：2026-09-23 至 2026-10-12 约 40 个版本，同一天多次发版常见。

### 0.4 远程运行时原型测试（2026-10-13，yzhang 集群 node3）

目的：验证"在服务器上运行 OMP、桌面端通过 SSH 以 RPC 驱动"是否可行。测试用本机的假模型服务（OpenAI 兼容接口，按固定剧本返回工具调用），不涉及真实密钥。测试脚本保留在会话临时目录，结论记录在此。

环境：node3，CentOS 7.9，内核 3.10.0-1160，glibc 2.17，x86_64。没有 tmux/screen，有 setsid。家目录 `mkdir` 报"磁盘配额已满"（`quota` 却显示没有配额），测试改放 `/tmp`。

| 测试项 | 结果 |
|---|---|
| OMP 官方 Linux 单文件可执行程序（GitHub release `omp-linux-x64`，18.1.10，约 200 MB，SHA256 与 release 一致） | ✅ 在内核 3.10、glibc 2.17 上运行，`--version` 0.7 秒。原生模块依赖的最高 glibc 版本是 2.17 |
| `omp-linux-musl-x64` | ❌ 启动报"No such file"：需要系统里有 musl 动态加载器 |
| 上传两个可执行文件（约 350 MB） | 34 秒 |
| `ssh … omp --mode rpc`，JSON 行协议走 SSH 标准输入输出 | ✅ 2.7–4.4 秒就绪（含 SSH 连接），之后每次工具调用往返 0.1–0.35 秒 |
| OMP 原生 `bash`、`read` 在服务器上执行 | ✅ 主机名 node3、内核 3.10、工作目录在服务器上 |
| 模型经 SSH 反向隧道（`-R`）调用本机服务 | ✅ 密钥不需要离开本机 |
| 宿主工具（RPC `set_host_tools` / `host_tool_call` / `host_tool_result`） | ✅ 服务器上的智能体调用、桌面端执行并返回 |
| 主会话审批（扩展在 `tool_call` 中调用 `ctx.ui.confirm`，经 RPC `extension_ui_request` / `extension_ui_response`） | ✅ 拒绝后命令被拦下，未产生副作用 |
| TypeScript 扩展直接加载（`-e <目录>`） | ✅ 服务器上不需要构建工具 |
| 子智能体：扩展目录下的 `agents/*.md` 被发现，OMP `task` 在服务器上创建子会话 | ✅ 子会话只拿到声明的工具（另加 `yield`、`hub`）；`subagent_event` / `subagent_progress` / `subagent_lifecycle` 实时转发；结果异步送回主会话 |
| 子会话里的审批 | ❌ 确认请求没有送到桌面端，被直接按"拒绝"处理（安全，但需要设计） |
| SSH 断开后进程是否保留、登录节点是否清理常驻进程 | 未测 |

---

## 1. 目标与非目标

**目标**

1. 本地与远程项目运行**同一份 OMP**：本地在桌面进程内，远程在服务器上经 RPC 驱动。OMP 原生工具在两边都是"本地工具"，Phi 不再维护远程版本的 `read` / `write` / `edit` / `glob` / `grep` / `bash`。
2. OMP 升级时，需要修改的代码**只在引擎适配层**（`src/main/agent/engine/`）内；服务器端只需换成同版本的 OMP 可执行文件。
3. 升级到 OMP 18.10.x，并建立可重复的升级流程（桌面端与服务器端同步）。

**非目标**

- 本地项目不改运行方式，继续在本机进程内运行 OMP。
- 不替换 OMP 的模型层（pi-ai / pi-catalog）、对话循环、上下文压缩、计划模式。
- 模型密钥不上传到服务器；服务器上的 OMP 通过隧道调用桌面端的模型代理。
- 第一版不做断线后继续运行（服务器上的 OMP 随 SSH 连接存在）。断线续跑等登录节点常驻进程政策确认后再做。
- 不做旧会话数据的迁移层（沿用 beta 路线图原则）。

---

## 2. 底层机制（先定，再排任务）

### M1 引擎边界

- 新建 `src/main/agent/engine/`。现有 `src/main/agent/omp/` 整体迁入，作为**唯一**允许 import `@oh-my-pi/*` 的目录。
- 例外（白名单，带理由）：
  - `src/main/terminal/terminal-worker.ts`、`terminal-supervisor.ts` 使用 `@oh-my-pi/pi-natives` 的 `PtySession` / `Process`。这是原生进程能力，不属于 agent 引擎；保留，但只允许 `pi-natives` 包根。
  - `scripts/` 下只使用 `@oh-my-pi/pi-natives` 包根的终端测试与试验脚本（`terminal-host-smoke.ts`、`terminal-pty-spike.ts`、`terminal-pty-spike/helpers.ts`、`terminal-stress-smoke.ts`），理由同上。
- 新增检查脚本 `scripts/check-engine-boundary.mjs`，接入 `bun run lint`：
  - 扫描 `src/`、`tests/`、`scripts/` 下的源码文件；检查的是模块引用（`import`、`import type`、`export ... from`、动态 `import()`、`require()`、`import x = require()`），只用作字符串的包名或 `node_modules/...` 路径不算引用。
  - 引擎目录外出现 `@oh-my-pi/*`（白名单除外）即失败。白名单按"文件 + 具体引用路径"记录，已在白名单里的文件新增一个引用路径同样失败。
  - 引擎目录内可以直接引用包根；内部子路径 import 必须列在 `scripts/engine-boundary-allowlist.json` 中。每条记录写明用途和"计划移除/长期保留"。
  - 白名单里的过期条目（文件已删除，或文件已不再引用该路径）同样失败，因此列表**只减不增**；新增条目需要在 PR 中说明。

### M2 Phi 自有类型

引擎外的代码只依赖下列 Phi 类型（放在 `src/main/agent/engine/types.ts`，不 re-export 任何 OMP 类型）：

| 类型 | 用途 | 适配 |
|---|---|---|
| `PhiTool` / `PhiToolResult` / `PhiToolContext` | 所有 Phi 自定义工具 | 进程内：`toOmpCustomTool(tool)`；RPC：`toRpcHostTool(tool)` |
| `PhiAgentEvent` | 引擎 → main → renderer 的事件流 | `translateOmpEvent(event)`，进程内事件与 RPC 事件共用 |
| `PhiSettings` | Phi 用到的 OMP 设置项（类型化，按领域分组） | `createPhiSettings(ompSettings)` |
| `PhiAuth` | 模型登录、凭据列举与删除、MCP OAuth 凭据 | `createPhiAuth(ompAuth)` |
| `PhiThinkingLevel`、`PhiModelRef` | 思考级别、模型引用 | 引擎内转换 |

规则：`PhiTool` 的 `parameters` 由 Phi 定义，入参统一经 `pickDeclaredToolInput` 过滤（沿用 `8dc5de03` 的修复）。

### M3 引擎的两种运行方式

定义 `PhiEngine` 接口（创建会话、发送、中断、steer、订阅事件、注册宿主工具、回答界面请求、子智能体查询），两种实现：

| 实现 | 用于 | 做法 |
|---|---|---|
| `InProcessEngine` | 本地项目 | 现有 worker：OMP SDK 进程内运行 |
| `RpcEngine` | 远程项目 | `ssh <host> <runtimeRoot>/omp/<version>/omp --mode rpc …`，JSON 行协议走 SSH 标准输入输出（第 0.4 节已验证） |

引擎外的代码（main、IPC、renderer）只依赖 `PhiEngine`，不知道背后是哪一种。

### M4 Phi 工具按执行位置分两类

现有 Phi 工具的 `execute` 大多只是调用 `requestHost(method, payload)`，真正的工作在桌面端主进程里。这正好对应 OMP RPC 的宿主工具。

| 类别 | 例子 | 本地（进程内） | 远程（RPC） |
|---|---|---|---|
| **宿主工具**：在桌面端执行 | browser、ask_user、present_files、render_blocks、palette、library、notebook、wrapper_*、skill_run 与脚本工具、env_request、HTTPS MCP 工具 | `toOmpCustomTool`，`execute` 调 `requestHost` | `set_host_tools` 注册；`host_tool_call` 由桌面端执行同一个处理函数 |
| **运行时扩展**：在 OMP 所在机器上执行 | 审批（`tool_call` 拦截）、项目边界检查、下一步建议等扩展，以及 Phi 智能体定义 | 作为扩展加载 | 打成一个 **Phi 扩展包**（目录：入口 `index.ts` + `agents/*.md`），按内容哈希上传到服务器，启动时 `-e <目录>` 加载 |

同一个 Phi 扩展包在本地和远程都加载，本地进程内也改为从这个包加载，保证两边行为一致。

### M5 远程运行时的部署与启动

- **分发**：Phi 维护一份清单（类似 `resources/remote-helper/manifest.json`），记录每个支持版本的 `omp-linux-x64` / `omp-linux-arm64` 的下载地址与 SHA256（取自 OMP release 的 `SHA256SUMS.txt`）。桌面端下载并缓存，校验后经 helper 的断点续传上传到 `<runtimeRoot>/omp/<version>/omp`，在服务器上再校验一次。不支持 musl 版本。
- **安装位置**：必须在 Phi 已有的"服务器运行时根目录"下，不默认放家目录（node3 家目录有配额问题）。
- **配置目录**：`HOME` 与 `PI_CODING_AGENT_DIR` 都指向 `<runtimeRoot>/omp-home/` 下的 Phi 专用目录，不读写用户自己的 `~/.omp`。
- **版本一致**：每次启动先执行 `omp --version`，与桌面端 OMP 版本不一致就重新部署。
- **工作目录**：服务器上的项目根目录。

### M6 模型调用经隧道走桌面端

- 桌面端起一个只监听 `127.0.0.1` 的模型代理，按 provider 转发请求，由桌面端加上凭据。
- SSH 反向转发：服务器端口随机，避免多人共用登录节点时冲突。
- **共享登录节点上其他用户也能连 `127.0.0.1` 的端口**，所以代理必须校验每个会话独立的随机令牌（写在服务器端 `models.yml` 的 `apiKey` 里，文件权限 600），没有令牌一律拒绝。
- 服务器端的 `models.yml` 由 Phi 生成，列出桌面端当前可用的模型，`baseUrl` 指向隧道端口。

### M7 审批

- **主会话**：Phi 扩展包里的审批扩展在 `tool_call` 中调用 `ctx.ui.confirm`；RPC 的 `extension_ui_request` 由桌面端交给现有审批界面（`tool-approval.ts`），结果用 `extension_ui_response` 返回。已验证。
- **子会话**：原型测试中子会话的确认请求没有送到桌面端，被直接拒绝。候选方案（第 3 阶段 R6 内先做技术调查再定）：
  1. 子会话里的审批扩展改为调用一个宿主工具或宿主 URI 请求桌面端审批；
  2. 桌面端在派生子会话前下发规则（例如按项目或命令前缀自动批准），子会话里只按规则判断；
  3. 使用 OMP 自带的审批机制（`tools/approval.ts`），确认它在 RPC 模式下是否会把子会话的审批转给宿主。

### M8 引擎契约测试

`tests/engine-contract/` 只通过 `PhiEngine` 测试，不 import OMP。**同一组用例对 `InProcessEngine` 和 `RpcEngine`（RPC 端用本机 OMP 进程 + 本地 stdio，不需要 SSH）各跑一遍**：

- 创建会话、发送一轮、收到 `PhiAgentEvent` 序列（开始、文本增量、工具调用、工具结果、结束）。
- 宿主工具注册与回调，参数过滤、`isError` 结果正确传递。
- 中断进行中的一轮。
- 主会话审批：批准与拒绝。
- 子智能体：派生、事件转发、结果送回。
- 上下文压缩开关与阈值经 `PhiSettings` 生效。
- 恢复会话：模型可用、模型不可用（覆盖 18.6.3 的抛错行为）。
- `PhiAuth`：API key 写入、列举、删除；OAuth 状态判断。

模型调用用假模型服务（OpenAI 兼容、按剧本返回，第 0.4 节的测试已经实现过一版）。

---

## 3. 需要用户确认的决策

| 编号 | 决策 | 状态 / 推荐 | 说明 |
|---|---|---|---|
| D1 | 远程项目在服务器上运行 OMP（RPC），本地项目不变 | **已确认（2026-10-13）** | 取代原来"Phi 自己维护 6 个工作区工具"的方案；原 D2（edit 统一 replace 模式）、D3（本地打包 ripgrep）、D4（URL 读取改用 fetch）随之取消 |
| D2 | 升级节奏：锁精确版本，每 2–4 周集中升级一次，桌面端与服务器端同步 | 推荐：是 | 新功能最多延后一个周期 |
| D3 | 阶段顺序：阶段 1（适配层）→ 阶段 2（升级）→ 阶段 3（远程运行时） | 推荐：是 | 远程运行时要求两端同版本，先升级可以避免在旧版本上做完再迁一次 |
| D4 | Phi 智能体改为 OMP 智能体定义（放在 Phi 扩展包的 `agents/` 下），由 OMP `task` 派生；Phi 的 `agent_status` / `agent_wait` / `agent_steer` / `agent_stop` 映射到 OMP 的子智能体接口 | 推荐：先在 R6 中调查映射是否完整，再定 | 原型测试证明派生、事件和结果都可行；steer、停止、并发上限、后台唤醒的对应关系还没核对 |
| D5 | 远程会话以服务器上的 OMP 会话文件为准，桌面端照常保存 Phi 自己的时间线（`~/.phi/sessions`）。服务器会话丢失时，用桌面端时间线摘要开新会话 | 推荐：是 | 服务器不可达时不能恢复原会话，只能延续摘要 |

---

## 4. 实施阶段

每个阶段单独提交、可单独回滚。每个阶段结束都要跑：

```bash
bun run typecheck
```

```bash
bun run lint
```

```bash
bun run test
```

### 阶段 0：基线（约 0.5 天）

1. 在 18.1.10 上记录 `typecheck`、`lint`、`test` 的当前结果，写入本文附录 A，作为后续"无回归"的比较对象。（已完成）
2. 新增 `scripts/check-engine-boundary.mjs` 与 `scripts/engine-boundary-allowlist.json`。白名单初始内容为当前全部 OMP import，接入 `lint`。2026-10-13 实际为 52 个文件（`src/` 40、`tests/` 7、`scripts/` 5）：其中 46 条计划移除，6 条长期保留（M1 列出的终端例外）。
3. ~~现有未提交改动先提交或搁置~~：已完成（2026-10-12）。

验收：`lint` 通过；新增一个引擎目录外的 OMP import 时 `lint` 失败。

### 阶段 1：引擎适配层（在 18.1.10 上完成，不改变行为）

**1a 目录迁移与 `PhiTool`**

- `src/main/agent/omp/` → `src/main/agent/engine/`，更新引用。
- 定义 `PhiTool` 与 `toOmpCustomTool`。把从 OMP 引用 `CustomTool` / `CustomToolContext` 的文件改为依赖 `PhiTool`：`remote-workspace-*-tool.ts`、`notebook/notebook-tools.ts`、`library/library-tools.ts`、`download/*-tool.ts`、`deliverables/*-tool.ts`、`content/skill-tools.ts`、`content/env-request-tool.ts`、`browser/browser-tool.ts`、`palettes/tools.ts`、`user-interaction-tools.ts`、`wrappers/tools.ts`、`wrappers/composition/tools.ts`、`memory/learn-tool.ts`、`memory/project-memory-worker.ts` 中的 `CustomTool`、`agents/` 下引用 `CustomTool` 的文件（`run-tools.ts`、`tool-resolution.ts`、`tool.ts`），以及只引用 `CustomTool` 类型的测试 `tests/content-skill-tools.test.ts`、`tests/phi-agent-runs.test.ts`。
- 每个 `PhiTool` 标明执行位置（宿主工具 / 运行时扩展，见 M4）。
- 每改一个文件，从白名单删去对应条目。
- **T1 不处理**（2026-10-13 用户确认，按性质归到后续任务）：
  - `agents/` 下引用 `ExtensionFactory` 的守卫与策略文件（`environment-binding.ts`、`fallback-policy.ts`、`project-tool-boundary.ts`、`remote-project-tool-guard.ts`、`remote-url-guard.ts`）和扩展加载 `specialist-tool-call-extensions.ts`：属于运行时扩展，归 T6（1f）。
  - `memory/project-memory-worker.ts` 中的记忆存储 API、`mcp-key-credentials.ts` 的 MCP 配置类型、`web-search-settings.ts` 的搜索提供方列表：归 T4（1d）。
- 验收：引擎目录外不再有 `CustomTool` / `CustomToolContext` 引用；白名单中引擎目录外剩下的条目只有终端例外、上面列出的 T4/T6 文件，以及直接用 OMP 驱动真实会话的程序（测试辅助程序与 `scripts/eval/db-vs-fetch.ts`，见阶段 1 完成标准）。

**1b `PhiSettings`**

- 当前用到的设置键（`omp-sdk-worker.ts`），按领域分组成类型化接口：
  - 上下文压缩：`compaction.enabled`、`compaction.thresholdPercent`、`compaction.thresholdTokens`、`compaction.methodOrder`（读与 override）
  - 网页搜索：`providers.webSearchOrder`、`providers.webSearchExclude`、`searxng.endpoint`、`searxng.engines`、`searxng.token`、`searxng.basicUsername`、`searxng.basicPassword`
  - MCP 与扩展：`mcp.enableProjectConfig`、`mcp.notifications`、`extensions`，以及 `extensionsSourceLevel()`
  - 记忆：`memory.backend`（override 为 `local`；计划写成时还没有记忆功能，2026-10-13 补记）
  - 写盘：`flush()`；会话自带的设置对象（`session.settings`）的读取同样经 `PhiSettings`
- 打开设置的方式（`Settings.init` / `Settings.loadReadOnly`）和交给 OMP 的原始 `Settings` 对象留在引擎内部，`PhiSettings` 包装它，不替代它。
- 引擎外不出现设置键字符串。
- 验收：worker 内不再直接调用 `settings.get/set/override`；新增单元测试覆盖每个分组的读写。

**1c `PhiAuth`**

- 封装当前 15 处调用（`omp-sdk-worker.ts` 中的模型登录、登出、凭据列举/删除、来源描述，以及 `featured-mcp-auth.ts` 的 MCP OAuth 凭据读写）。
- 对外方法草案：`listProviders()`、`credentialStatus(providerId)`、`setApiKey(providerId, key)`、`login(providerId, controller)`、`logout(providerId)`、`listApiKeys(authId)`、`removeApiKey(authId, entryId)`、`getMcpOAuth(url)`、`setMcpOAuth(url, credential)`。
- 2026-10-13 核对：T1 之后所有 `authStorage` 调用都已在引擎目录内，"引擎外不出现 `AuthStorage`"已经满足；1c 的实际目标是让 worker 不再直接调用 `authStorage` 的方法，全部经 `engine/in-process/auth.ts`。`ModelRegistry`、`createAgentSession`、MCP 管理器与 OAuth 流程仍拿原始 `AuthStorage` 对象，`PhiAuth` 包装它，不替代它。
- 必须保留的现有语义：网页搜索服务保存 API key 时保留同一 authId 下已有的非 API key 凭据、只替换 API key；清除时只删 API key；模型 provider 的"已配置"判断为 `hasAuth || hasConcreteAuth || 有已存凭据`。
- 验收：worker 内不再直接调用 `authStorage` 的方法；单元测试覆盖各方法。

**1d 零散内部工具函数收口**

- `estimateToolSchemaTokens`、`parseConfiguredThinkingLevel`、`applyProviderGlobalsFromSettings`、`authPolicyFor`、`getCatalogProviderEntry`、`SEARCH_PROVIDER_CHOICES`、`resolveCompactionMethodOrder` 等，每个在引擎里包成一个 Phi 函数，统一放在 `engine/omp-internals.ts`。升级时只看这一个文件。
- MCP 内部模块（`mcp/manager`、`mcp/client`、`mcp/oauth-*`、`mcp/transports/stdio`、`mcp/config`）先集中到 `engine/mcp/`。
- 实施记录（T4）：`SEARCH_PROVIDER_CHOICES` 单独放在 `engine/omp-web-search.ts`。`omp-internals.ts` 会加载带 JSON import 的 `pi-catalog`，Node 直接运行的测试加载不了，而 `web-search-settings.ts` 会被这些测试加载。`omp-sdk-worker.ts` 中创建会话用的 `legacy-pi-coding-agent-shim` 与 `modes/runtime-init` 留到 T5 的 `session-factory.ts`；`agents/*` 留到 T6。

**1e 拆分 `omp-sdk-worker.ts`，抽出 `PhiEngine`**

按职责拆分，每个文件尽量控制在 600 行以内（AGENTS.md 要求）：

| 新文件 | 内容 |
|---|---|
| `engine/types.ts` | `PhiEngine` 与 M2 类型 |
| `engine/in-process/main.ts` | worker 入口、消息分发 |
| `engine/in-process/session-factory.ts` | `createAgentSession` 调用、系统提示词组装 |
| `engine/in-process/tool-registry.ts` | 工具集合解析与注册 |
| `engine/in-process/mcp-runtime.ts` | MCP 加载、通知、OAuth |
| `engine/in-process/auth.ts` | `PhiAuth` 实现 |
| `engine/in-process/settings.ts` | `PhiSettings` 实现 |
| `engine/events.ts` | `translateOmpEvent`（两种引擎共用） |
| `engine/in-process/subagents.ts` | Phi 子智能体会话 |

只搬代码、不改逻辑；每搬一块跑一次完整测试。

实施记录（T5）：分两步提交。T5a 只搬代码，worker 入口改为 `engine/in-process/main.ts`；表外的处理函数按领域另建文件（`session-creation`、`session-runtime`、`session-history`、`runtime-context`、`resources`、`mcp-profile`、`web-search`、`tool-support`、`ipc`、`common`），共享可变状态集中在 `in-process/state.ts`，最大文件 442 行。T5b 在 `engine/types.ts` 定义 `PhiEngine`（按领域分组，共 55 个操作），由 `engine/in-process-engine.ts` 转发给 `OmpBridge`；`index.ts` 与 `runtime-adapter.ts` 只通过 `getPhiEngine()` 调用，引擎目录外不再 import `omp-bridge`。

**1f Phi 扩展包**

- 把现有以扩展形式注入的逻辑（审批、项目边界、下一步建议等）整理成一个扩展包目录（入口加 `agents/`），本地进程内改为从这个包加载。行为不变。

**1g 引擎契约测试**

- 按 M8 实现 `tests/engine-contract/`，本阶段先只对 `InProcessEngine` 跑。
- 验收：在 18.1.10 上全部通过。

阶段 1 完成标准：白名单中只剩 `engine/` 内的条目、终端例外，以及直接用 OMP 驱动真实会话的程序：测试辅助程序（`tests/helpers/` 下的 `*Smoke.ts`、`ownedStdioScopeFixture.ts`）与评测脚本 `scripts/eval/db-vs-fetch.ts`。它们的用途注明由 T7 引擎契约测试或 R9 清理取代（2026-10-13 用户确认测试辅助程序按此处理；评测脚本性质相同，按同一决定处理）。三项验证命令结果与附录 A 基线一致或更好。

### 阶段 2：升级 OMP 到 18.10.x（只改 `engine/`）

**T8 自动化验收记录（2026-10-13）**：现有直接依赖及完整 OMP 闭包精确锁定 18.10.3；独立安装与官方完整性核对通过。Auth、Settings、事件、不可用模型恢复、专家环境绑定和 stdio 适配已完成，独立审查无未解决代码问题。生产 node/web/scripts 类型检查、lint、构建、asar 闭包全部通过。冻结代码的完整测试共 **4789 项：4764 通过、0 失败、0 取消、24 既有跳过、1 既有 todo，308.84 秒**；真实 worker 引擎契约 18/18、stdio 52/52、旧 18.1 会话恢复及本机 PTY 4 项通过。两个此前被系统睡眠打断的运行日志保留；最终运行仅临时阻止系统睡眠，没有改变断言、超时或跳过条件。

删除已失效的 provider globals 调用及 TUI 工具估算依赖；新上游传递依赖 axe-core 已纳入 asar 解包清单。此次打包清单与白名单调整属于必要兼容改动，不新增直接依赖。Bash 环境包装有明确差异：顶层 `return/local` 获得函数作用域语义；普通命令的环境隔离、用户 export、cwd、退出和取消已对照真实 18.1 worker 验证。

**不能据此宣称整个阶段 2 的人工清单完成**：真实 provider/OAuth 交换与刷新、实际自动压缩、外部 HTTPS MCP OAuth、专家显式 async/PTY、Finder 打包启动和真实服务器仍待验证。没有读取用户密钥或连接真实服务器。T8 可供审查的分支成果与阶段 1 的 main 合入分别记录。

1. 新分支 `chore/omp-<version>`，同时升级 `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-natives`，并检查锁文件中 `pi-ai`、`pi-catalog`、`pi-tui` 是否跟随到同一版本。以开始升级当天的最新 18.10.x 为准。
2. 按第 0.3 节的清单修改：

| 问题 | 改法 |
|---|---|
| `Settings` 字符串键 | `engine/in-process/settings.ts` 改为 OMP 的注册设置对象；`PhiSettings` 接口不变 |
| `AuthStorage` 方法 | `engine/in-process/auth.ts` 改接 `pi-ai` 新的 auth、OAuth、pool 接口；`PhiAuth` 接口不变 |
| `thinking` | 改为从包根导入 |
| `context-usage` | 在引擎内自行估算工具 schema 的 token 数，不为此依赖 TUI 包 |
| `provider-globals` | 查清新版对应的初始化方式；找不到替代就删除这次调用，并用契约测试确认 provider 配置仍然生效 |
| `getCatalogProviderEntry` | 在 `pi-catalog` 中找到新名字或改用包根 API |
| `SEARCH_PROVIDER_CHOICES` | 改用新导出；如果新版只有显示名，就在 Phi 侧维护可选列表 |

3. 行为变化逐项确认：
   - 18.6.3 会话恢复抛错：在 `session-factory.ts` 捕获 `Could not restore model`，转成 Phi 现有的 unavailable-model 状态。契约测试覆盖。
   - 18.8.5 子智能体同进程：确认 Phi 未设置 `PI_SUBPROCESS_CMD`；跑 `phi-agent-runs`、`phi-agent-run-wake`、`agent-runs-overview` 测试。
   - 18.5.0 `claimSession`：确认 Phi 没有自定义 SessionStorage。
   - 18.2.7 / 18.2.9 / 18.3.0 工具行为变化（bash 无 `env`、read 图片参数、edit 新补丁语法）：本地直接跟随 OMP；检查 Phi 的系统提示词和测试里有没有写死旧用法。
4. 运行时验证（实机，按清单记录结果）：
   - 本地项目：一轮对话、工具调用、中断、上下文压缩、恢复旧会话。
   - 模型登录：API key 与 OAuth 各一个 provider。
   - MCP：一个 HTTPS 连接器（含 OAuth）、一个本地 stdio 连接器。
   - 子智能体：并行、后台、steer。
   - 远程项目（仍是旧实现）：一轮带 read/edit/bash 的对话。
   - 打包版：`asar` 解包、Finder 启动下的 worker 代理（参考 `482c7aea`、`b340b2e9`）。
5. 验收：三项验证命令通过，引擎契约测试通过，运行时清单全部通过；改动只在 `engine/`、`package.json`、锁文件以及与行为变化对应的测试里。

如果第 4 步发现阻塞问题，回滚到 18.1.10，问题记入附录 B，等 OMP 修复或 Phi 侧绕过后再升级。

### 阶段 3：远程运行时（`RpcEngine`）

远程项目由一个设置项决定走旧实现还是 `RpcEngine`，默认旧实现；R1–R8 全部通过并完成实机验证后再切换默认值，R9 再删除旧实现。

**R1 分发与部署**（M5）

- 版本清单、下载缓存、SHA256 校验、经 helper 断点续传上传到 `<runtimeRoot>/omp/<version>/`，服务器端校验，`--version` 检查与版本不一致时重新部署。
- 安装位置不可写或空间不足时，给出明确原因，指向"服务器运行时根目录"设置。
- 测试：用 `localShellSession` 假服务器覆盖部署、重用、版本不一致、校验失败。

**R2 启动与连接**

实施拆分（2026-10-13）：T10a 使用 Node-only 协议与窄 `RpcSessionBackend`，真实本地 CLI 和 InProcess 运行同一基础契约，不伪装完整 55 操作 `PhiEngine`。`response` 仅代表 prompt 接收，完成依赖 same-id `prompt_result` 并读取真实状态/历史。两路独立审查已修复 turn lock、同 ID 换代、同步/异步 observer、旧 cleanup 错误污染和 wire metadata 校验；协议 26/26、基础及回归新增 20/20、原丰富契约 18/18 全部通过，含真实 >1 MiB 多字节流/历史和 64 MiB 分块上限。候选分支冻结提交 `053c3f88` 的完整测试共 4862 项：4837 通过、0 失败、0 取消、24 既有跳过、1 既有 todo，296.71 秒；生产 node/web/scripts 类型检查、lint、构建与 asar 闭包通过。首轮相同代码的 50 个失败全部为沙箱禁止回环端口监听（EPERM），允许隔离本地监听后整组通过；代码、断言、超时与跳过条件均未变。

T10b 已完成真实默认 ExtensionFactory、安全加载确认、完整扩展内容哈希部署和现有 SSH stdio 启动工厂。锁定 18.10.3 的 CLI 使用 `--trusted-extension <rpc-entry.ts>`；它与 `-e` 不能同时使用。只有明确列出的扩展命令通过 nonce、会话、项目、版本、内容哈希和守卫状态验证，才将会话标为就绪，加载失败不会回落到模型。完整源码单份随应用打包；稳定缓存与 staging 保留续传身份，内核 `flock` 在断线时释放，锁丢失立即取消发布，服务器必须预装该工具。私有 CLI 配置阻断项目 MCP 和环境扩展在守卫之前执行。

审批桥接前只放行项目内已有普通文本的 native read，写入、执行和其他工具保持拒绝；Unicode 空格改写、反斜杠及 `:raw` 字面路径替代冲突明确拒绝。这是 pre-R5 限定范围。A/B/C 三路独立 APPROVE，实际 CLI、部署、协议、初始化、原引擎契约合并测试 159/159、0 失败/取消、自然退出 64.98 秒；生产 typecheck/lint/build/asar 通过。审查发现的 1 HIGH、5 MEDIUM 及文件名绑定 P2 已关闭。完整串行回归 4930 项、0 失败/取消。模型代理、宿主工具、审批、子会话、持久会话和远程恢复仍按 R3–R7 推进；窄后端尚不代表完整 PhiEngine 或产品可用远程功能。当前不接新 UI，不连接真实服务器。

- `RpcEngine`：建立 SSH 连接（复用现有 SSH 会话管理与主机密钥校验），启动 `omp --mode rpc`，设置 `HOME`、`PI_CODING_AGENT_DIR`、工作目录、`--trusted-extension <Phi 扩展包>/rpc-entry.ts`。
- 处理就绪、协议版本协商（`negotiate_protocol`）、进程退出、SSH 断开（第一版：标记会话中断，可重新连接并恢复会话）。
- Phi 扩展包按内容哈希上传与复用（复用 Skill 包上传的做法）。

**R3 模型代理与隧道**（M6）

- 桌面端模型代理、随机端口反向转发、每会话随机令牌、生成服务器端 `models.yml`。
- 安全测试：没有令牌或令牌错误的请求一律拒绝；令牌文件权限 600。

**R4 宿主工具桥接**（M4）

- `toRpcHostTool`：把宿主类 `PhiTool` 注册为 RPC 宿主工具，`host_tool_call` 交给桌面端同一个处理函数，支持 `host_tool_update`（进度）和 `host_tool_cancel`（取消）。
- 逐个接入：browser、ask_user、present_files（远程版本）、render_blocks、palette、library、notebook、wrapper_*、skill_run 与脚本工具、env_request、HTTPS MCP 工具。
- 契约测试：M8 的宿主工具用例对 `RpcEngine` 通过。

**R5 主会话审批**（M7）

- `extension_ui_request`（confirm / select / input）接到现有审批界面；超时与取消按现有规则处理。
- 契约测试：批准、拒绝、取消。

**R6 子智能体与子会话审批**（M7、D4）

- 调查并确定 D4：Phi 智能体到 OMP 智能体定义的转换、`agent_*` 工具到 OMP 子智能体接口的映射、并发上限、后台唤醒。
- 解决子会话审批（M7 的三个候选方案中选一个），补契约测试。

**R7 会话存储与恢复**（D5）

- 服务器会话文件路径记入 Phi 会话清单；重新连接时用 `switch_session` 恢复；服务器会话不可用时按 D5 处理。

**R8 实机验证**（yzhang node3 与 GPU 单机各一遍）

- 一轮"搜索 → 阅读 → 修改 → 运行"对话；审批批准与拒绝；一个宿主工具（notebook 或 wrapper）；一个子智能体；断线后重连恢复。
- 记录启动耗时、工具往返耗时、部署耗时。

**R9 清理**（切换默认值并稳定一个升级周期之后）

- 删除 `remote-workspace-{read,write,edit,bash}-tool.ts`、`remote-workspace-search-tools.ts` 及其实现文件、worker 中对应的 `remoteRoot` 分支。
- `remote-project-tool-guard.ts` 中针对同名远程工具的签名校验随之删除；保留对宿主工具和 MCP 来源的校验。

### 阶段 4：后续收敛清单（本计划不实施）

远程运行时上线后，以下服务可以从"桌面端远程操作服务器"改为"在服务器上的 OMP 里直接执行"，逐项评估：

| 能力 | 现状 | 方向 |
|---|---|---|
| Skills / `skill_run` | 桌面端上传 Skill 包、经 helper 远程执行（`remote-runtime/skill-service.ts`） | 改为运行时扩展，在服务器上直接执行 |
| 受管环境 / `env_request` | 桌面端远程操作 micromamba（`remote-runtime/environment-service.ts`） | 评估改为服务器端直接执行 |
| MCP stdio | 经 SSH 在服务器上启动（`mcp/remote-project-mcp-service.ts`） | 由服务器上的 OMP 直接启动 |
| Notebook | 桌面端经端口转发连接服务器上的 Jupyter | 保持宿主工具，或评估由服务器端直接连接 |
| 断线续跑 | 第一版随 SSH 连接存在 | 确认登录节点常驻进程政策后，评估 `setsid` 加重新接管 |
| MCP 客户端 | 依赖 OMP 内部 `mcp/*` | 评估改用官方 `@modelcontextprotocol/sdk`，以缩小白名单 |

### 阶段 5：常态化升级流程

已交付 [OMP 升级操作手册](../runtime/omp-upgrade-runbook.md)。本次已按记录完成本地自动化部分，人工与远程清单仍待验证；每次升级照做：

1. 新分支 `chore/omp-<version>`；在 `package.json` 中锁精确版本，同时检查 `pi-ai`、`pi-catalog`、`pi-tui`、`pi-natives` 版本一致。
2. 更新远程运行时清单：同版本的 `omp-linux-x64` / `omp-linux-arm64` 地址与 SHA256。
3. 读上次升级版本到目标版本之间的 changelog，摘出 Breaking Changes、Removed，以及涉及 tool、session、settings、auth、MCP、extension、subagent、RPC 的条目，写进 PR 描述。
4. 跑 `typecheck`、`lint`、`test` 与引擎契约测试（两种引擎）。修改范围应该只在 `engine/`；如果引擎外的代码需要改，说明适配层漏了什么，先补适配层。
5. 跑阶段 2 第 4 步的运行时清单，加上 R8 的远程实机清单。
6. 白名单中如果出现新的内部路径，必须在 PR 里说明理由。
7. 合并后更新本文附录 C 的"已验证版本"表。

---

## 5. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 服务器无法运行 OMP 可执行文件（更老的 glibc、非 x86_64/arm64、noexec 挂载） | 远程项目不可用 | R1 启动检查给出明确原因；在切换默认值前保留旧实现作为退路 |
| 共享登录节点上其他用户访问模型代理端口 | 用户的模型额度被盗用 | M6 每会话令牌，没有令牌一律拒绝 |
| 登录节点清理长时间运行的进程 | 会话中途被杀 | 第一版随 SSH 连接存在；R7 支持重连恢复；断线续跑放到阶段 4 |
| 子会话审批无法送到桌面端 | 子智能体无法执行需要审批的命令 | R6 先调查再选方案；方案确定前，远程子智能体只开放只读工具 |
| 部署体积（约 200 MB/版本） | 慢网络下首次使用要等 | 断点续传、后台进度、同版本复用；只在升级时重新上传 |
| OMP RPC 协议在新版本中变化 | `RpcEngine` 失效 | 启动时做协议协商；契约测试对 `RpcEngine` 覆盖；升级 runbook 检查 RPC 相关 changelog |
| 引擎契约测试找不到合适的假 provider | 契约测试写不出来 | 用第 0.4 节的假模型服务（OpenAI 兼容、按剧本返回） |
| `Settings` 新接口中找不到某个旧设置项 | 升级阻塞 | 阶段 2 回滚；在 `PhiSettings` 中先把该项改为 Phi 自管 |
| OMP 发版太快，升级窗口内又出新版本 | 升级不收敛 | 以开始升级当天的版本为准，过程中不追新版本 |
| 打包环境差异（asar、Finder 启动） | 开发环境正常、打包版失败 | 运行时清单强制包含打包版验证 |

---

## 6. 交给 Codex 的任务拆分

每个任务独立提交，验证命令使用 `bun run`。

| 编号 | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T0 | 引擎边界检查脚本与白名单 | 无 | 阶段 0 验收 |
| T1 | `omp/` → `engine/`，引入 `PhiTool`（标明执行位置），迁移所有 `CustomTool` 引用 | T0 | 1a 验收 |
| T2 | `PhiSettings` | T1 | 1b 验收 |
| T3 | `PhiAuth` | T1 | 1c 验收 |
| T4 | 零散内部函数收口到 `omp-internals.ts`，MCP 收口到 `engine/mcp/`；含记忆存储 API、`mcp-key-credentials.ts`、`web-search-settings.ts` | T1 | 1d 完成，白名单收敛 |
| T5 | 拆分 worker，抽出 `PhiEngine` 与 `InProcessEngine` | T2–T4 | 1e 完成，测试无回归 |
| T6 | Phi 扩展包，本地改为从包加载；含 `agents/` 下的守卫、策略与扩展加载文件 | T5 | 1f 完成，行为不变 |
| T7 | 引擎契约测试（`InProcessEngine`）与假模型服务 | T5 | 1g 验收 |
| T8 | 升级到 18.10.x | T6、T7 | 阶段 2 验收 |
| T9 | R1 分发与部署 | T8 | R1 测试通过 |
| T10 | R2 `RpcEngine` 启动与连接，契约测试对 `RpcEngine` 跑通基础用例 | T9 | M8 基础用例通过 |
| T11 | R3 模型代理与隧道 | T10 | R3 安全测试通过 |
| T12 | R4 宿主工具桥接 | T10 | R4 验收 |
| T13 | R5 主会话审批 | T10 | R5 验收 |
| T14 | R6 子智能体与子会话审批（先调查，D4 定稿后实施） | T12、T13 | R6 验收 |
| T15 | R7 会话存储与恢复 | T10 | R7 验收 |
| T16 | R8 实机验证（需要用户确认后连接服务器） | T11–T15 | R8 清单通过 |
| T17 | 升级 runbook | T8 | 阶段 5 文档完成 |
| T18 | R9 清理旧远程工具实现 | T16 之后一个升级周期 | R9 完成 |

T9 可以在 T8 完成前先做分发清单与上传部分（只依赖 helper）。T12、T13、T15 都只依赖 T10，可以并行。

---

## 7. 完成定义

- 引擎目录外没有 `@oh-my-pi/*` import（终端例外除外），白名单只包含已说明理由的条目。
- 远程项目通过 `RpcEngine` 在服务器上运行 OMP；引擎契约测试对两种引擎都通过；R8 实机清单在 node3 与 GPU 单机上通过。
- 远程同名工具实现已删除（R9）。
- OMP 运行在 18.10.x，桌面端与服务器端版本一致。
- 升级 runbook 已写好，并至少按它完成过一次升级（即本次）。

---

## 附录 A：基线（阶段 0 填写）

记录于 2026-10-12，提交 `63088e84`（合并 `origin/main` 之后，原生 Office 功能已移除），OMP 18.1.10。

| 命令 | 18.1.10 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| `bun run lint` | 通过；0 个错误，2 个警告 |
| `bun run test` | 4677 个：通过 4657，失败 8，跳过 11，todo 1；用时约 6 分钟 |

全套运行中失败的 8 个测试，单独运行对应文件时全部通过，说明它们只在满载时出现超时或竞态，不是稳定复现的失败：

| 文件 | 全套中的失败数 | 单独运行 |
|---|---|---|
| `envs-application-bun` | 2（约 5–8 秒超时） | 23/23 通过 |
| `envs-application-tools` | 1（约 5 秒超时） | 13/13 通过 |
| `jupyter-runtime-backend` | 2（各约 20 秒超时） | 8/8 通过 |
| `remote-nextflow-install-flow` | 1 | 2/2 通过 |
| `remote-notebook-tools-e2e` | 1 | 1/1 通过 |
| `workspace-host-runtime-root` | 1（慢容量探测用例） | 19/19 通过 |

此前在 `476d4843` 上的一次全套运行中，`workspace-host-contract` 的"暂存期间外部写入"竞态用例也失败过一次（local 25/25、ssh 27/27 单独运行通过），同样视为满载不稳定项。

后续阶段的"无回归"标准：typecheck 与 lint 无错误；全套测试中除上表列出的满载不稳定项外无失败，上表各文件单独运行仍全部通过。

## 附录 B：升级阻塞记录

（暂无）

## 附录 C：已验证的 OMP 版本

| 版本 | 日期 | 验证人 | 说明 |
|---|---|---|---|
| 18.1.10 | 2026-10-13 | Codex | 阶段 1 main 基线；4771 项全量零失败 |
| 18.10.3 | 2026-10-13 | Codex + 独立 subagent 审查 | T8 分支自动化验收通过，4789 项全量零失败；人工清单待验证 |

T10b 冻结提交 `e4447c5d` 的全套串行验收：4930 项，4905 通过、0 失败、0 取消、24 既有跳过、1 todo，1096.00 秒。23 个生产/测试/打包文件哈希及运行前后 HEAD 完全一致。此前标准并发 4 两轮分别有 3 项与 2 项不同的既有失败；Bun 5 秒版本探测、容量探测和 Jupyter readiness 用例按原断言/期限单独复现均通过，相关源码和测试与 main 一致。未放宽期限/断言、未新增跳过、未改标准并发脚本；并行稳定性波动仍作为验证限制保留，不将串行结果表述为标准并发全量通过。后续 T11/T12 在另一副本实施，不再重开 T1–T7 审查。
