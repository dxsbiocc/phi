# OMP 解耦、本地/远程统一与 OMP 升级计划

状态：**计划，未开始**
创建日期：2026-10-12
执行者：Codex（gpt-5.6-sol xhigh）；所有验证命令使用 `bun run`
关联文档：`docs/roadmap/remote-parity-implementation.md`、`docs/roadmap/internal-beta-implementation.md`、`docs/architecture/frontend-feature-boundaries.md`

> 路线图说明：internal beta 路线图要求"把 SDK 会话文件视为实现细节"，本计划沿同一方向把 OMP 收敛为可替换的引擎。远程/HPC 在 beta 路线图里排在 beta 之后，但用户已在 2026-10-08 把远程能力对齐提到当前优先级；本计划第 3 阶段是该工作的结构性收尾，不夹带新功能。

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

---

## 1. 目标与非目标

**目标**

1. 本地与远程项目的工作区工具只有**一份实现**，差异只存在于 `WorkspaceHost` 实现与能力档案声明的降级项。
2. OMP 升级时，需要修改的代码**只在引擎适配层**（`src/main/agent/engine/`）内。
3. 升级到 OMP 18.10.1，并建立可重复的升级流程。

**非目标**

- 不把智能体运行时搬到服务器（沿用 remote-parity 计划的原则）。
- 不替换 OMP 的模型层（pi-ai / pi-catalog）、对话循环、上下文压缩、计划模式。这些继续直接跟随 OMP。
- 不在本计划内做 Skills / MCP / 环境的远程收敛，只列入后续清单（第 4 阶段）。
- 不做旧会话数据的迁移层（沿用 beta 路线图原则）。

---

## 2. 底层机制（先定，再排任务）

### M1 引擎边界

- 新建 `src/main/agent/engine/`。现有 `src/main/agent/omp/` 整体迁入，作为**唯一**允许 import `@oh-my-pi/*` 的目录。
- 例外（白名单，带理由）：
  - `src/main/terminal/terminal-worker.ts`、`terminal-supervisor.ts` 使用 `@oh-my-pi/pi-natives` 的 `PtySession` / `Process`。这是原生进程能力，不属于 agent 引擎；保留，但只允许 `pi-natives` 包根。
- 新增检查脚本 `scripts/check-engine-boundary.mjs`，接入 `bun run lint`：
  - 引擎目录外出现 `@oh-my-pi/*`（白名单除外）即失败。
  - 引擎目录内的内部子路径 import 必须列在 `scripts/engine-boundary-allowlist.json` 中；文件里每条记录写明用途和"计划移除/长期保留"。列表**只减不增**，新增需要在 PR 中说明。

### M2 Phi 自有类型

引擎外的代码只依赖下列 Phi 类型（放在 `src/main/agent/engine/types.ts`，不 re-export 任何 OMP 类型）：

| 类型 | 用途 | 适配函数 |
|---|---|---|
| `PhiTool` / `PhiToolResult` / `PhiToolContext` | 所有 Phi 自定义工具 | `toOmpCustomTool(tool)` |
| `PhiAgentEvent` | worker → main → renderer 的事件流 | `translateOmpEvent(event)` |
| `PhiSettings` | Phi 用到的 OMP 设置项（类型化，按领域分组） | `createPhiSettings(ompSettings)` |
| `PhiAuth` | 模型登录、凭据列举与删除、MCP OAuth 凭据 | `createPhiAuth(ompAuth)` |
| `PhiThinkingLevel`、`PhiModelRef` | 思考级别、模型引用 | 引擎内转换 |

规则：`PhiTool` 的 `parameters` 由 Phi 定义，入参统一经 `pickDeclaredToolInput` 过滤（沿用 `8dc5de03` 的修复），不依赖 OMP 的参数行为。

### M3 工作区工具 = 工具定义 × WorkspaceHost

- 6 个工作区工具（`read`、`write`、`edit`、`glob`、`grep`、`bash`）各实现一次，签名形如 `buildReadTool(host: WorkspaceHost, scope: WorkspaceScope): PhiTool`。`WorkspaceScope` 包含项目根、路径约束、Skill 资源读取器等。
- 本地项目注入 LocalHost，远程项目注入 SshHost（经 helper 或直连），工具代码中**禁止**出现 `remote` 判断。
- 注册时关闭 OMP 内建的同名工具；`remote-project-tool-guard` / `project-tool-boundary` 的"注册来源 + 描述签名"校验对本地同样生效（本地也只接受 Phi 注册的这 6 个工具）。
- 参数契约写入 `docs/contracts/workspace-tools.md`，作为唯一依据：

| 工具 | 参数（草案） | 说明 |
|---|---|---|
| `read` | `path`；可选 `offset`、`limit` | 兼容现有 `path:10-50` 行选择语法；支持文本、目录列表、图片；`skill://` 由 scope 中的资源读取器处理 |
| `write` | `path`、`content` | 经 `fs.writeAtomic`，可选 `expectedHash` |
| `edit` | `path`、`old_string`、`new_string`；可选 `replace_all` | replace 模式，歧义替换拒绝（沿用 `remote-workspace-edit.ts` 现有语义） |
| `glob` | `pattern`；可选 `path` | 经 `fs.glob` |
| `grep` | `pattern`；可选 `path`、`glob`、`ignoreCase`、`literal`、`context`、`limit` | 经 M4 的 `search` 能力 |
| `bash` | `command`；可选 `timeout` | 经 `exec.run`，有输出上限、超时与取消 |

### M4 WorkspaceHost 新增搜索能力

- 在 `WorkspaceHost` 上新增可选的 `search.grep(options)`，返回结构化匹配结果。
- SshHost：沿用 `remote-ripgrep` 的托管 ripgrep。
- LocalHost：使用与远程同一分发渠道的 ripgrep 二进制（打包进应用，按平台），不直接调用 OMP natives（否则又把 OMP 带出了引擎边界）。
- 能力档案增加 `search` 项；不可用时 `grep` 返回明确的降级原因，不回退到本机。
- `tests/workspace-host-contract.ts` 增加 grep 用例，两种 host 共用。

### M5 引擎契约测试

`tests/engine-contract/` 只通过 `engine/` 的对外接口测试，不 import OMP：

- 创建会话、发送一轮、收到 `PhiAgentEvent` 序列（开始、文本增量、工具调用、工具结果、结束）。
- `PhiTool` 注册后能被调用，参数过滤、`isError` 结果正确传递。
- 中断进行中的一轮。
- 上下文压缩开关与阈值经 `PhiSettings` 生效。
- 恢复会话：模型可用、模型不可用（覆盖 18.6.3 的抛错行为）。
- `PhiAuth`：API key 写入、列举、删除；OAuth 状态判断（用假 provider）。
- MCP：stdio 服务器注册与工具出现在会话中。

模型调用使用 OMP 支持的假/回放 provider；如果没有，就在引擎里加一个仅测试用的 provider。

---

## 3. 需要用户确认的决策

| 编号 | 决策 | 推荐 | 代价 |
|---|---|---|---|
| D1 | 本地项目放弃 OMP 内建文件工具，改用 Phi 的统一工具 | 是 | 本地失去 hashline/补丁式 edit、ast-grep、读 PDF/SQLite/压缩包、LSP 联动，以及 OMP 后续对这些工具的改进 |
| D2 | `edit` 统一为 replace 模式（`old_string`/`new_string`） | 是 | 不跟随 OMP 18.3.0 的新补丁语法 |
| D3 | 本地 `grep` 使用打包的 ripgrep，而不是 OMP natives | 是 | 安装包增加一个 ripgrep 二进制（约 5 MB/平台） |
| D4 | URL 读取改由 OMP 的 `fetch` 工具提供（不碰工作区，本地远程都可用） | 是 | 提示词中"用 read 读 URL"的说法要改 |
| D5 | 升级节奏：锁精确版本，每 2–4 周集中升级一次 | 是 | 新功能最多延后一个周期 |
| D6 | 阶段顺序：先阶段 1（适配层），再阶段 2（升级），再阶段 3（统一工具） | 是 | 18.10.1 的新功能要等阶段 1 完成后才能用 |

D1 如果不接受，替代方案是：本地保留 OMP 内建工具，远程实现严格对齐 OMP 参数，并对每次升级跑"本地/远程参数一致"契约测试。这种方式每次升级都要追 OMP 的工具变化，不推荐。

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

1. 在 18.1.10 上记录 `typecheck`、`lint`、`test` 的当前结果，写入本文附录 A，作为后续"无回归"的比较对象。
2. 新增 `scripts/check-engine-boundary.mjs` 与 `scripts/engine-boundary-allowlist.json`。白名单初始内容为当前全部 OMP import（约 40 个文件），接入 `lint`。
3. ~~现有未提交改动先提交或搁置~~：已完成（2026-10-12，测试改动已提交，`index.d.ts` 中重复的 import 已丢弃）。

验收：`lint` 通过；新增一个引擎目录外的 OMP import 时 `lint` 失败。

### 阶段 1：引擎适配层（在 18.1.10 上完成，不改变行为）

**1a 目录迁移与 `PhiTool`**
- `src/main/agent/omp/` → `src/main/agent/engine/`，更新引用。
- 定义 `PhiTool` 与 `toOmpCustomTool`。把只为类型而 import OMP 的工具文件改为依赖 `PhiTool`：`remote-workspace-*-tool.ts`、`notebook/notebook-tools.ts`、`library/library-tools.ts`、`download/*-tool.ts`、`deliverables/*-tool.ts`、`content/skill-tools.ts`、`content/env-request-tool.ts`、`browser/browser-tool.ts`、`palettes/tools.ts`、`user-interaction-tools.ts`、`wrappers/tools.ts`、`wrappers/composition/tools.ts`、`agents/*.ts`。
- 每改一个文件，从白名单删去对应条目。
- 验收：引擎目录外只剩 M1 白名单中的终端例外。

**1b `PhiSettings`**
- 当前用到的设置键（`omp-sdk-worker.ts`），按领域分组成类型化接口：
  - 上下文压缩：`compaction.enabled`、`compaction.thresholdPercent`、`compaction.thresholdTokens`、`compaction.methodOrder`（读与 override）
  - 网页搜索：`providers.webSearchOrder`、`providers.webSearchExclude`、`searxng.endpoint`、`searxng.engines`、`searxng.token`、`searxng.basicUsername`、`searxng.basicPassword`
  - MCP 与扩展：`mcp.enableProjectConfig`、`mcp.notifications`、`extensions`
- 引擎外不出现设置键字符串。
- 验收：worker 内不再直接调用 `settings.get/set/override`；新增单元测试覆盖每个分组的读写。

**1c `PhiAuth`**
- 封装当前 15 处调用（`omp-sdk-worker.ts` 中的模型登录、登出、凭据列举/删除、来源描述，以及 `featured-mcp-auth.ts` 的 MCP OAuth 凭据读写）。
- 对外方法草案：`listProviders()`、`credentialStatus(providerId)`、`setApiKey(providerId, key)`、`login(providerId, controller)`、`logout(providerId)`、`listApiKeys(authId)`、`removeApiKey(authId, entryId)`、`getMcpOAuth(url)`、`setMcpOAuth(url, credential)`。
- 验收：引擎外不出现 `AuthStorage`；单元测试覆盖各方法。

**1d 零散内部工具函数收口**
- `estimateToolSchemaTokens`、`parseConfiguredThinkingLevel`、`applyProviderGlobalsFromSettings`、`authPolicyFor`、`getCatalogProviderEntry`、`SEARCH_PROVIDER_CHOICES`、`resolveCompactionMethodOrder` 等，每个在引擎里包成一个 Phi 函数，统一放在 `engine/omp-internals.ts`。升级时只看这一个文件。
- MCP 内部模块（`mcp/manager`、`mcp/client`、`mcp/oauth-*`、`mcp/transports/stdio`、`mcp/config`）先集中到 `engine/mcp/`。是否改用官方 `@modelcontextprotocol/sdk` 留待第 4 阶段评估，本阶段不改。

**1e 拆分 `omp-sdk-worker.ts`**

按职责拆分，每个文件尽量控制在 600 行以内（AGENTS.md 要求）：

| 新文件 | 内容 |
|---|---|
| `engine/worker/main.ts` | worker 入口、消息分发 |
| `engine/worker/session-factory.ts` | `createAgentSession` 调用、系统提示词组装 |
| `engine/worker/tool-registry.ts` | 工具集合解析与注册（本地/远程差异在第 3 阶段消除） |
| `engine/worker/mcp-runtime.ts` | MCP 加载、通知、OAuth |
| `engine/worker/auth.ts` | `PhiAuth` 实现 |
| `engine/worker/settings.ts` | `PhiSettings` 实现 |
| `engine/worker/events.ts` | `translateOmpEvent` |
| `engine/worker/subagents.ts` | Phi 子智能体会话 |

只搬代码、不改逻辑；每搬一块跑一次完整测试。

**1f 引擎契约测试**
- 按 M5 实现 `tests/engine-contract/`。
- 验收：在 18.1.10 上全部通过。

阶段 1 完成标准：`check-engine-boundary` 白名单中只剩 `engine/omp-internals.ts`、`engine/mcp/*`、`engine/worker/*` 内的条目，加上终端例外；三项验证命令结果与附录 A 基线一致或更好。

### 阶段 2：升级 OMP 到 18.10.1（只改 `engine/`）

1. 新分支 `chore/omp-18.10.1`，同时升级 `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-natives`，并检查锁文件中 `pi-ai`、`pi-catalog`、`pi-tui` 是否跟随到同一版本。
2. 按第 0.3 节的清单修改：

| 问题 | 改法 |
|---|---|
| `Settings` 字符串键 | `engine/worker/settings.ts` 改为 OMP 的注册设置对象；`PhiSettings` 接口不变 |
| `AuthStorage` 方法 | `engine/worker/auth.ts` 改接 `pi-ai` 新的 auth、OAuth、pool 接口；`PhiAuth` 接口不变 |
| `thinking` | 改为从包根导入 |
| `context-usage` | 改为从 `@oh-my-pi/pi-tui/status-line/context-usage` 导入，或在引擎内自行估算（推荐自行估算：Phi 只用它估算工具 schema 的 token 数，不值得为此依赖 TUI 包） |
| `provider-globals` | 查清 18.10.1 中对应的初始化方式（可能已并入 `Settings.init` 或 `createAgentSession`）；找不到替代就删除这次调用，并用契约测试确认 provider 配置仍然生效 |
| `getCatalogProviderEntry` | 在 `pi-catalog` 中找到新名字或改用包根 API |
| `SEARCH_PROVIDER_CHOICES` | 改用新导出；如果新版只有显示名，就在 Phi 侧维护可选列表 |

3. 行为变化逐项确认：
   - 18.6.3 会话恢复抛错：在 `session-factory.ts` 捕获 `Could not restore model`，转成 Phi 现有的 unavailable-model 状态（beta 路线图 P0 要求）。契约测试覆盖。
   - 18.8.5 子智能体同进程：确认 Phi 未设置 `PI_SUBPROCESS_CMD`；跑 `phi-agent-runs`、`phi-agent-run-wake`、`agent-runs-overview` 测试。
   - 18.5.0 `claimSession`：确认 Phi 没有自定义 SessionStorage。
   - 18.2.7 / 18.2.9 / 18.3.0 工具行为：如果阶段 3 已完成，这几项不影响 Phi；如果没有完成，本地 bash/read/edit 的提示词和测试需要按新行为调整。**这是 D6 推荐先做阶段 1、再做阶段 3 的原因之一：两者都完成后再升级，工具层就不受影响。**
4. 运行时验证（实机，按清单记录结果）：
   - 本地项目：一轮对话、工具调用、中断、上下文压缩、恢复旧会话。
   - 模型登录：API key 与 OAuth 各一个 provider。
   - MCP：一个 HTTPS 连接器（含 OAuth）、一个本地 stdio 连接器。
   - 子智能体：并行、后台、steer。
   - 远程项目：一轮带 read/edit/bash 的对话（GPU 单机即可）。
   - 打包版：`asar` 解包、Finder 启动下的 worker 代理（参考 `482c7aea`、`b340b2e9`）。
5. 验收：三项验证命令通过，引擎契约测试通过，运行时清单全部通过；`git diff --stat` 中改动只在 `engine/`、`package.json`、锁文件以及与行为变化对应的测试里。

如果第 4 步发现阻塞问题，回滚到 18.1.10，问题记入附录 B，等 OMP 修复或 Phi 侧绕过后再升级。

### 阶段 3：统一工作区工具（Phi 拥有，可在阶段 2 之前或之后做）

**3a 契约文档**：写 `docs/contracts/workspace-tools.md`（M3 表格的定稿），包括参数、错误信息格式、输出上限、截断提示、路径规则。

**3b `read` / `glob` / `grep`**（只读，风险最低）
- 新建 `src/main/agent/workspace-tools/{read,glob,grep}.ts`，依赖 `WorkspaceHost` 与 `WorkspaceScope`。
- 远程现有逻辑（`remote-workspace-read.ts`、`remote-workspace-search.ts`）改造成 host 无关的实现，迁入上述文件。
- 实现 M4（`search` 能力，LocalHost 接入打包的 ripgrep）。
- 本地项目注册新工具、关闭 OMP 同名内建工具；远程项目改用同一实现。
- 测试：新增 `tests/workspace-tools-*.test.ts`，用 LocalHost 和假 SSH host 各跑一遍同一组用例。

**3c `write` / `edit`**
- 迁移 `remote-workspace-write.ts`、`remote-workspace-edit.ts` 的逻辑（原子写、hash 校验、replace 歧义拒绝）。
- 文件面板的变更通知要确认在本地新工具下仍然触发。

**3d `bash`**
- 基于 `exec.run`：超时、输出上限、取消（`AbortSignal`）、退出码与截断提示。
- 本地 bash 原来由 OMP 提供的能力要逐项确认：登录 shell 环境（`login-shell-env.ts`）、受管环境注入（`agents/environment-binding.ts`）、审批（`tool-approval.ts`）、工作目录约束。缺一项就不切换。
- 长时间运行的进程：先只支持前台加超时；后台任务继续使用 Wrapper/作业系统。如果 OMP 本地 bash 的后台作业被用户实际使用，就在切换前补上 `spawnBackground` 支持（另列任务）。

**3e 清理**
- 删除 `remote-workspace-{read,write,edit,bash}-tool.ts`、`remote-workspace-search-tools.ts` 以及 worker 中对应的 `remoteRoot` 分支。
- `remote-project-tool-guard.ts`、`project-tool-boundary.ts`、`agents/tool-resolution.ts` 改为按统一工具的注册来源校验；子智能体的"声明工具 ∩ 远程支持集合"逻辑简化为"声明工具 ∩ host 能力"。
- 系统提示词与工具说明（`remote-workspace-tool-guidance`、`buildPhiRemoteProjectSystemPrompt`）合并为一份，按 host 能力生成差异说明。

**3f 验收**
- 本地与远程跑同一组工具测试，全部通过。
- worker 中与 6 个工作区工具相关的 `remoteRoot` 分支为 0。
- 实机：本地项目和远程项目各完成一轮"搜索 → 阅读 → 修改 → 运行"的对话。

### 阶段 4：后续收敛清单（本计划不实施）

按同一原则（"服务只写一份，host 作为参数"），在 remote-parity 后续步骤中逐项处理：

| 能力 | 现状 | 方向 |
|---|---|---|
| Skills / `skill_run` | 本地与远程两套服务（`content/skill-host.ts`、`remote-runtime/skill-service.ts`） | 合并为一个服务，Skill 包上传由 host 能力决定 |
| 受管环境 / `env_request` | 本地 `envs/*`，远程 `remote-runtime/environment-service.ts` | 统一为 host 上的 micromamba 操作 |
| MCP stdio | 本地 `mcp/custom-stdio.ts`，远程 `mcp/remote-project-mcp-service.ts` | stdio 传输统一基于 `exec.spawnBackground` |
| `present_files` / `download_file` | 本地与远程各一个工具 | 统一为 host 实现 |
| Notebook | 本地与远程两个 Jupyter 后端 | 统一为 host 上的 Jupyter 运行时 |
| MCP 客户端 | 依赖 OMP 内部 `mcp/*` | 评估改用官方 `@modelcontextprotocol/sdk`，以缩小白名单 |

### 阶段 5：常态化升级流程

写成 `docs/runtime/omp-upgrade-runbook.md`，每次升级照做：

1. 新分支 `chore/omp-<version>`；在 `package.json` 中锁精确版本，同时检查 `pi-ai`、`pi-catalog`、`pi-tui`、`pi-natives` 版本一致。
2. 读上次升级版本到目标版本之间的 changelog，摘出 Breaking Changes、Removed，以及涉及 tool、session、settings、auth、MCP、extension、subagent 的条目，写进 PR 描述。
3. 跑 `typecheck`、`lint`、`test` 与引擎契约测试。修改范围应该只在 `engine/`；如果引擎外的代码需要改，说明适配层漏了什么，先补适配层。
4. 跑阶段 2 第 4 步的运行时清单。
5. 白名单中如果出现新的内部路径，必须在 PR 里说明理由。
6. 合并后更新本文附录 C 的"已验证版本"表。

---

## 5. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 统一工具后，本地模型效果不如 OMP 内建工具（OMP 的提示词针对其内建工具调过） | 本地编辑成功率下降 | 3b–3d 每步切换后，用固定任务集对比切换前后的工具调用成功率；明显下降就暂停切换，先改工具说明 |
| OMP 内建工具的某些能力被隐式依赖（如 `read` 读 URL、读 PDF） | 功能缺失 | D4 用 `fetch` 替代 URL 读取；PDF 等格式按需求补到 `read`，或单独做工具 |
| 引擎契约测试找不到合适的假 provider | 契约测试写不出来 | 在引擎内实现一个回放 provider（读取预录的事件序列），只在测试中注册 |
| `Settings` 新接口中找不到某个旧设置项 | 升级阻塞 | 阶段 2 回滚；在 `PhiSettings` 中先把该项改为 Phi 自管 |
| OMP 发版太快，升级窗口内又出新版本 | 升级不收敛 | 以开始升级当天的版本为准，过程中不追新版本 |
| 打包环境差异（asar、Finder 启动） | 开发环境正常、打包版失败 | 运行时清单强制包含打包版验证 |

---

## 6. 交给 Codex 的任务拆分

每个任务独立提交，验证命令使用 `bun run`。

| 编号 | 任务 | 依赖 | 验收 |
|---|---|---|---|
| T0 | 基线记录，加引擎边界检查脚本与白名单 | 无 | 阶段 0 验收 |
| T1 | `omp/` → `engine/`，引入 `PhiTool`，迁移所有工具文件 | T0 | 引擎外只剩终端例外 |
| T2 | `PhiSettings` | T1 | 1b 验收 |
| T3 | `PhiAuth` | T1 | 1c 验收 |
| T4 | 零散内部函数收口到 `omp-internals.ts`，MCP 收口到 `engine/mcp/` | T1 | 1d 完成，白名单收敛 |
| T5 | 拆分 worker | T2–T4 | 1e 完成，测试无回归 |
| T6 | 引擎契约测试 | T5 | 1f 验收 |
| T7 | 升级到 18.10.1 | T6 | 阶段 2 验收 |
| T8 | 工作区工具契约文档与 `search` 能力 | T1 | 3a 与 M4 完成 |
| T9 | 统一 `read`、`glob`、`grep` | T8 | 3b 验收 |
| T10 | 统一 `write`、`edit` | T9 | 3c 验收 |
| T11 | 统一 `bash` | T10 | 3d 验收 |
| T12 | 清理远程同名实现与 guard | T11 | 3f 验收 |
| T13 | 升级 runbook | T7 | 阶段 5 文档完成 |

T8–T12 只依赖 T1，可以与 T2–T7 并行。如果两条线并行，T7 和 T9–T11 都会改 worker 里的工具注册，需要先合并的一方解决冲突。

---

## 7. 完成定义

- 引擎目录外没有 `@oh-my-pi/*` import（终端例外除外），白名单只包含已说明理由的条目。
- 6 个工作区工具只有一份实现；本地与远程跑同一组测试。
- OMP 运行在 18.10.1，引擎契约测试与运行时清单全部通过。
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
| 18.1.10 | — | — | 当前版本 |
