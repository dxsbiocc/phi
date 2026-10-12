# Phi 记忆功能设计（本地与远程项目共用）

状态：**设计稿，待确认后实施**
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
- `learn` 工具（autolearn）：内测不开启。它会写入 `learned.md`，并在远程守卫里属于 C 类；等记忆查看页能展示和删除单条内容后再考虑。

### 2.3 实现要点

1. 主进程在创建会话时，把项目的 `memory` 策略放进发给 worker 的会话记录。
2. worker 在 `Settings.init` 之后，对该会话 `settings.override('memory.backend', policy)`。`off` 时保持现状。
3. 总结用的模型：SDK 先用 `default` 角色，没有时退回会话模型。Phi 不另设角色，在设置页说明"记忆总结使用当前会话的模型"。
4. 远程守卫不需要改：`local` 后端不注册 `retain`/`recall`/`reflect`/`memory_edit`，`learn` 保持关闭。
5. 清空：项目设置里提供"清空记忆"，调用 SDK 的 `clearMemoryData(agentDir, cwd)`；删除项目时同样调用。

### 2.4 界面（`features/memory/`）

- 项目设置：记忆开关，以及"会读取本项目对话并在后台调用模型"的说明。
- 只读的记忆查看页：显示 `memory_summary.md` 的内容、最近一次总结时间和"清空记忆"按钮。不提供应用内编辑，与"资源只读可见"的原则一致。
- 本轮注入了记忆时，在时间线的系统提示信息里标注"已使用项目记忆"。

## 3. 测试

- worker：策略为 `local` 时设置被覆盖，为 `off` 时不变；远程会话的记忆目录键是锚点而不是服务器路径。
- 远程：沿用 `tests/remote-agent-loop.test.ts` 的真实 agent 循环，确认开启记忆后远程工具调用不变，也没有新的服务器请求。
- 清空和删除项目会移除对应记忆目录，并且不影响其他项目。

## 4. 插件在远程项目里的范围（同时确认）

Phi 插件只包含 **skills** 和 **agents** 两类组件：

- 插件 skills：已经在远程 skill 列表里（`insidePlugin`、`pluginId`、`toolPrefix` 会一并传递），和全局 skill 一样在服务器的受管环境里运行。
- 插件 agents：按远程工具交集运行（R5）。
- 外部配置的 Pi 扩展（hooks/extension）：远程会话里继续关闭（`disableExtensionDiscovery`），因为它们在本机进程里执行，无法保证不接触本机项目锚点。

## 5. 待确认

1. 记忆默认关闭、按项目开启：是否同意？
2. 远程项目和本地项目同时提供：是否同意？
3. `learn`（agent 主动记录经验）内测不开：是否同意？
