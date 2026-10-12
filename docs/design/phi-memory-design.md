# Phi 记忆功能设计（本地与远程项目共用）

状态：**已确认，已实现（内测）**
日期：2026-10-12
关联：`docs/roadmap/internal-beta-implementation.md`（内测范围）、`docs/roadmap/remote-parity-implementation.md`（R2.5 把记忆类工具归为 C 类）

## 1. 现状

- Phi 没有记忆功能。omp SDK 的 `memory.backend` 默认是 `off`，Phi 也没有覆盖它，所以本地会话不运行任何记忆。
- 远程项目会话里，`memory_edit`、`retain`、`recall`、`reflect`、`learn`、`manage_skill` 都被远程守卫拒绝（R2.5 C 类）。
- 已核对 SDK 18.1.10 的源码：
  - `local` 后端的记忆目录是 `agentDir/memories/<encodeProjectPath(cwd)>`，其中 `cwd` 取 `session.sessionManager.getCwd()`。
  - Phi 传给 SessionManager 的 `cwd`：本地项目是项目目录；远程项目是 `ensureRemoteProjectAnchor(projectId)`，每个项目一个锚点；普通会话是 `~/.phi/workspace`。
  - 因此不改 SDK，记忆也已经按项目隔离，并且远程项目的记忆天然以 `projectId` 为键。
  - 总结阶段（phase1/phase2）在**本机**用模型读取历史会话，生成 `memory_summary.md`；注入阶段只是把摘要放进系统提示。这两步都不需要在服务器上执行任何东西。
  - 注意：SDK 的**注入**读取的是 `settings.getCwd()` 对应的目录，而远程会话的 settings cwd 是 `agentDir`（避免把锚点当成项目根）。所以远程项目由 Phi 在会话创建时自己读取锚点目录下的总结和经验，追加到远程系统提示里；本地项目继续使用 SDK 的注入。
  - SDK 的 `clearMemoryData` 会清空所有项目的数据库记录，不能用于单个项目。

## 2. 方案

### 2.1 后端选择

| 后端        | 结论     | 原因                                                                       |
| ----------- | -------- | -------------------------------------------------------------------------- |
| `local`     | **采用** | SDK 内置，无额外依赖；数据只在 `~/.phi`                                    |
| `mnemopi`   | 不采用   | 依赖 `onnxruntime-node` 原生模块和嵌入模型下载，与安装包瘦身和离线目标冲突 |
| `hindsight` | 不采用   | 需要外部服务，数据离开本机                                                 |

### 2.2 开关与范围

- **按项目开启，默认关闭。** 后台总结会读取完整对话并消耗模型 token，与权限模式一样属于项目策略。
- 保存位置：Phi 自己的项目登记（`~/.phi/projects.json`）新增 `memory: 'off' | 'local'`，不写进项目目录。
- 普通会话：内测不提供。
- 远程项目：**和本地项目一样提供**。注入与总结都在本机完成，不向服务器发送任何新命令；记忆键是 `projectId`，删除项目时一并删除其记忆目录。
- `learn`（agent 主动记录经验）：**作为项目设置“允许 agent 记录经验”提供，默认关闭**，只有开启项目记忆后才能打开。
  - 不使用 SDK 的 `autolearn.enabled`：它会同时注册 `manage_skill`，并在全局 `managed-skills` 目录写 SKILL.md，影响所有项目。
  - Phi 注册自己的 `learn` 工具，只接受 `memory`/`context`，通过 SDK 的 `saveLearnedLesson` 写入该项目记忆目录下的 `learned.md`（复用 SDK 的脱敏和去重）。
  - 远程守卫只放行描述完全一致的 Phi `learn` 注册；远程子 agent 不提供。
  - 每条经验都可以在设置页查看和删除。

### 2.3 实现要点

1. `projects.json` 的项目记录新增 `memory: { enabled, learn }`；缺省即全部关闭，`learn` 只在 `enabled` 时生效。
2. 主进程在创建会话时把项目的 `memory` 策略放进发给 worker 的会话记录；设置对新会话生效，不中断正在运行的会话。
3. worker 在开启时 `settings.override('memory.backend', 'local')`；开启 `learn` 时注册 Phi 的 `learn` 工具；远程会话额外把记忆块追加到系统提示。
4. 总结用的模型：SDK 先用 `default` 角色，没有时退回会话模型。设置页说明"用当前会话的模型总结"。
5. 远程守卫：`local` 后端不注册 `retain`/`recall`/`reflect`/`memory_edit`；`learn` 按上面的规则放行。
6. 查看、删除单条经验、清空都由 worker 完成（`memory.read`/`memory.deleteLesson`/`memory.clear`），因为记忆路径和 SQLite 状态由 SDK 解析。
7. 清空只删除该项目的总结、经验和阶段一输出，保留已完成的阶段一任务记录，所以旧对话不会被重新总结；之后继续或新建的对话才会形成新记忆。删除项目时同样清空。

### 2.4 界面（`features/memory/`）

- 设置 → 记忆：每个项目两个开关（项目记忆、允许 agent 记录经验），以及"会读取本项目对话并在后台调用模型、只保存在本机"的说明。
- 每个项目可展开查看：`memory_summary.md` 的内容和更新时间、agent 记录的经验列表（可逐条删除）、"清空记忆"（需确认）。不提供应用内编辑。
- 后续：本轮注入了记忆时，在时间线标注"已使用项目记忆"（未实现）。

## 3. 测试

- `tests/project-memory.test.ts`：设置默认值与归一化、项目登记持久化、经验读取和按内容确认的删除、远程记忆块（含转义）、`learn` 工具、远程守卫对 `learn` 的放行规则。
- `tests/remote-agent-loop.test.ts`：真实 agent 循环里，远程项目开启记忆后调用 `learn`，经验写入本机锚点对应的记忆目录，没有新的服务器请求；清空后经验为空。
- `tests/settings-dialog.test.ts`：记忆设置页的开关状态。

## 4. 插件在远程项目里的范围（同时确认）

Phi 插件只包含 **skills** 和 **agents** 两类组件：

- 插件 skills：已经在远程 skill 列表里（`insidePlugin`、`pluginId`、`toolPrefix` 会一并传递），和全局 skill 一样在服务器的受管环境里运行。
- 插件 agents：按远程工具交集运行（R5）。
- 外部配置的 Pi 扩展（hooks/extension）：远程会话里继续关闭（`disableExtensionDiscovery`），因为它们在本机进程里执行，无法保证不接触本机项目锚点。

## 5. 决定记录

1. 记忆默认关闭、按项目开启：已确认。
2. 远程项目和本地项目同时提供：已确认。
3. `learn`：放到设置里让用户选择，默认关闭（见 2.2）。
