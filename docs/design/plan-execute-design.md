# 自动 Plan-execute 设计

状态：2026-10-23 确认底层取舍，按阶段实施。

## 目标

用户开启"规划并执行"后，主智能体只读调研并产出**结构化步骤计划**。用户在评审卡片上批准计划后，由主进程里的确定性执行器按依赖图自动调度：每一步拉起一个子智能体执行，结果作为下游步骤的输入。全部完成后，主智能体做汇总与核验。

已确认的取舍：

| 问题 | 决定 |
| --- | --- |
| 执行器位置 | Electron 主进程确定性编排；状态落盘，重启可恢复；不由模型驱动循环 |
| 并行 | 按依赖图自动并行：有依赖的严格串行，无依赖的并行（例如只读调研）。写工作区的步骤只有在双方都声明了写入范围且互不重叠时才并行，否则排队 |
| 人工关卡 | 计划评审是唯一必经关卡；某步失败先自动重试 1 次，仍失败就暂停整个运行，由用户选择重试 / 跳过 / 重新规划剩余步骤 / 停止；运行中可随时手动暂停 |
| 远程项目 | 先只做本地；远程（RPC facade）放最后一期 |

已有可复用的部分：计划态工具限制（`src/main/agent/plan/plan-review-mode.ts`）、评审卡片、子智能体 run 注册表（`src/main/agent/agents/registry.ts`，含并发上限、steer/stop）、结构化报告 `<phi_agent_result>`（`agents/report.ts`）、后台审批（`agents/background-approval.ts`）、续跑唤醒主智能体（`agents/run-continue.ts`）。

## 分层（由内而外）

### L0 计划模型（纯数据，无 I/O）

`src/shared/planRunTypes.ts`：主进程、preload、渲染端共用的类型。

```ts
type PlanStepAccess = 'read' | 'write'
interface PlanStep {
  id: string            // [a-z0-9-]{1,40}，计划内唯一
  title: string         // ≤ 80 字符
  instructions: string  // ≤ 4000 字符，交给子智能体的任务
  acceptance: string    // ≤ 1000 字符，完成标准
  dependsOn: string[]   // 上游步骤 id
  access: PlanStepAccess
  writes?: string[]     // access=write 时可选：相对工作区的路径前缀，用于判断能否并行
  agent?: string        // 指定子智能体；缺省用通用执行智能体
}
interface PlanSpec { version: 1; goal: string; steps: PlanStep[] }  // 1–20 步
```

`src/main/agent/plan/model/plan-spec.ts`：`validatePlanSpec(unknown) → { ok, spec } | { ok: false, errors[] }`。校验内容包括：长度上限、id 唯一、依赖存在、无环、`writes` 不含 `..` 和绝对路径。错误信息要可读，会原样回传给规划模型让它自行修正。

### L1 运行状态机（纯函数，不可变）

`src/main/agent/plan/model/plan-run-state.ts`

- `PlanRunState`：`id`、`sessionId`、`spec`、`status`、`steps`、`pause?`、`replans`、`createdAt`、`updatedAt`。
  - `status` 取值：`running | paused | completed | stopped`。
  - `steps` 是 `Record<stepId, StepState>`。
  - `pause?` 记录暂停原因：`user | step_failed | interrupted | needs_input`，以及相关步骤 id。
- `StepState`：`status`、`attempts`、`agentRunId?`、`report?`、`error?`、`startedAt?`、`finishedAt?`。
  - `status` 取值：`pending | running | done | failed | skipped | cancelled | interrupted`。
  - `report?` 是结构化报告的状态、正文摘要（≤ 8 KB）和 `missingInputs`。
- `reducePlanRun(state, event) → state`。永远返回新对象；非法转换抛 `PlanRunTransitionError`。事件：
  - `step_launched`、`step_succeeded`、`step_failed`、`step_needs_input`
  - `pause`、`resume`、`retry_step`、`skip_step`、`stop`
  - `replace_remaining_steps`：重新规划，只能替换尚未开始的步骤；保留在新计划里的 `failed / interrupted` 步骤转为 `skipped`
  - `recover_after_restart`：所有 running 步骤转为 interrupted，运行进入 paused
- 失败策略（`model/failure-policy.ts`）：`attempts < 2` 时回到 pending 自动重试，否则运行暂停（`step_failed`）。报告状态为 `partial / blocked / failed / not_found` 都视为失败；有 `missingInputs` 时暂停原因记为 `needs_input`，不自动重试。
- 跳过的步骤视为已满足依赖，因为跳过是用户的显式决定。
- 全部步骤为 `done / skipped` 时，状态转为 `completed`。

### L2 调度（纯函数）

`src/main/agent/plan/model/plan-scheduler.ts`：`selectLaunchableSteps(state, { maxConcurrent }) → stepId[]`

- 只在 `status === 'running'` 时返回结果。
- 候选是 `pending` 且所有依赖均为 `done / skipped` 的步骤，按计划顺序排列。
- 并发上限默认 3，小于子智能体注册表上限 4，给主会话自身的委派留出余量。
- 写冲突：write 步骤要并行运行，前提是它和所有已在运行或本轮已选的 write 步骤都声明了 `writes` 且前缀互不重叠；任何一方没声明就视为冲突，排队等待。read 步骤不受这条限制。

### L3 执行器（端口化，可注入）

`src/main/agent/plan/execution/`

- `step-runner.ts`：端口
  `StepRunner.start({ sessionId, agent, task, signal }) → { runId, done: Promise<StepOutcome> }`；
  `StepRunner.stop(sessionId, runId)`。
  `StepOutcome` = 子智能体最终文本经 `parseAgentReport` 解析的结果，或错误。
- `step-prompt.ts`：纯函数，生成每一步的任务文本，内容依次为：
  1. 总目标；
  2. 计划概览（所有步骤标题和状态）；
  3. 本步说明与完成标准；
  4. 上游步骤的报告摘要，每个 ≤ 4 KB，超出时截断并注明；
  5. `AGENT_REPORT_PROTOCOL`。
  不传完整对话记录。
- `plan-executor.ts`：`createPlanExecutor({ runner, store, events, clock, ids })`，负责驱动循环：
  `reduce → persist → emit → selectLaunchableSteps → launch`。
  - 每个运行串行处理事件（队列），避免并发 `done` 回调相互覆盖。
  - `stop` 会停掉所有在跑的子 run。
  - 运行完成后通过 `events` 通知上层，由上层唤醒主智能体做汇总。

### L4 持久化

`src/main/agent/plan/persistence/plan-run-store.ts`

- 每个会话一个目录：`<agentDir>/sessions/<sessionId>/plan-runs/<runId>.json`。
- 写入方式与 `jobs/background-job-history-store.ts` 一致：临时文件加 rename 原子写、`O_NOFOLLOW` 读、大小上限（256 KB）、权限 0600。
- 读取时用 `validatePlanRunState` 校验，损坏的文件直接忽略。
- 启动时列出未结束的运行，对每个运行应用 `recover_after_restart`。

### L5 引擎能力：主进程拉起子智能体

在 `PhiEngine.agentRuns` 新增 `start({ sessionId, agent, task }) → { runId }`，结束通知复用现有 `agentRun.finished` 宿主事件（需要带回最终文本）。in-process 实现：worker 里该会话的 registry 以 `background: true` 调用 `launch`，runner 和工具解析复用委派工具的同一套代码（`agents/tool.ts` 与 `in-process/subagents.ts`）。远程 facade 的同名能力放到 E5。

### L6 规划产出

计划态新增工具 `propose_plan_steps`（phi-extension，只在"规划并执行"模式下挂载），参数就是 `PlanSpec`。工具在 runtime 内先调用 `validatePlanSpec`，失败就把错误返回给模型；成功则经 `planReview.request` 发到主进程，宿主请求里附带结构化步骤。评审结果为 approve 时，主进程创建计划运行并启动执行器，主智能体本轮随即结束。原有"仅评审"模式（`xd://propose` 写 markdown）保持不变。

### L7 主进程服务与 IPC

- `src/main/agent/plan/plan-run-service.ts`：组合根，负责创建、查询、暂停、继续、停止、重试步骤、跳过步骤、重新规划；运行完成后通过已有续跑机制唤醒主智能体汇总。
- `src/main/ipc/plan-run-ipc.ts`：注册 IPC；通道常量加到 `src/shared/ipcChannels.ts`。
- `src/preload/plan-run-api.ts`：在 `preload/index.ts` 里展开。
- 时间线事件：`plan_run_started / plan_step_updated / plan_run_paused / plan_run_finished`，写入会话时间线，切换会话或重启后仍可见。
- `src/main/index.ts` 只加一行注册调用。

### L8 渲染端 `features/plan/`

- `PlanRunPanel.tsx`：嵌入聊天区的执行面板，展示步骤列表和状态；点击步骤定位到对应子智能体卡片（复用 `data-agent-card-id` 的定位机制）。
- `components/`：`PlanStepRow`、`PlanRunControls`（暂停、继续、停止）、`PlanFailureActions`（重试、跳过、重新规划、停止）、`PlanReviewCard`（从 chat 迁移，增加步骤列表和依赖展示）。
- `hooks/`：`usePlanRun`（订阅 IPC 事件）、`usePlanModeToggle`（替代 `App.tsx` 的 `planReviewByDraft`，变成三态：关闭 / 仅评审 / 规划并执行）。
- `lib/`：`planRunView.ts`（纯派生）、`planCopy.en.ts` / `planCopy.zh-CN.ts`。
- `App.tsx` 只调用 hook 并挂载组件。

### L9 统一模式选择器与「自动」

2026-10-23 确认：输入框里**只有一个模式选择器**，参考 Claude Code 的做法，不分组，所有选项都当作「一种模式」平铺。按会话保持，新会话默认「自动」。

| 模式 | 工作方式 | 工具审批（内部 permissionMode） |
| --- | --- | --- |
| 自动（默认） | 主智能体自己判断：直接做 / 先计划评审 / 规划并自动执行 | `auto`（允许的工具替我批准） |
| 询问 | 直接执行 | `ask` |
| 计划 | 只读调研 → 计划评审 → 批准后执行 | 计划阶段只读；批准后 `auto` |
| 规划并执行 | 只读调研 → 结构化步骤 → 评审 → 执行器调度子智能体 | 同上；子智能体 `auto` |
| 完全访问 | 直接执行 | `full`（危险，红色标注） |

内部仍保存两个正交字段：`workMode: 'auto' | 'direct' | 'plan' | 'plan_execute'` 和既有的 `permissionMode`。模式只是这两个字段的预设组合，所以审批链路（`tool-approval.ts`）不用改。

迁移：现有会话和项目的 `permissionMode` 一一对应 —— `ask` → 询问，`auto` → 自动，`full` → 完全访问，`workMode` 补默认值。原来"计划评审"的一次性开关（`planReviewByDraft`）删除。

远程项目在 E5 之前隐藏「计划」和「规划并执行」两项；「自动」在远程项目下只会直接执行。

「自动」的行为：
- 只在「自动」模式下给主智能体挂一个工具 `enter_plan_mode({ execute: boolean, reason })`。调用后会话在本轮内切到计划态（只读工具），后续流程与手动选「计划」/「规划并执行」完全相同。
- **计划仍必须经用户评审批准**；智能体只能决定「要不要规划」，不能跳过评审。
- 判断标准写进主系统提示：问答和小改动直接做；需求不清、影响面大或有风险的先计划评审；能拆成多个相对独立的子任务的走规划并执行。
- 时间线显示一条「智能体选择了：规划并执行 — 原因」，让用户看得见这次选择。

代码位置：
- 共享：`src/shared/sessionMode.ts`，放 `SessionMode`、预设表、`modeFromFields` / `fieldsFromMode`。
- 主进程：`src/main/agent/plan/work-mode-control.ts` 负责校验和持久化，复用 `permission-mode-control.ts` 的会话目标校验。
- runtime：`phi-extension/extensions/auto-work-mode.ts` 提供 `enter_plan_mode` 工具。
- 渲染端：`features/plan/components/SessionModeSelector.tsx` 替换 `ChatComposerControls` 里的权限选择器，配套 `features/plan/hooks/useSessionMode.ts`；首页输入框同样使用这个选择器。

## 实施阶段

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| E1 | L0–L4：类型、校验、状态机、失败策略、调度、步骤提示、执行器（假 runner）、存储；全部单测 | 无 |
| E2 | L5：引擎 `agentRuns.start`（in-process），以及能产出 `StepOutcome` 的真实 StepRunner 适配器 | E1 |
| E3 | L6–L8 最小闭环：规划工具、评审卡片带步骤、服务与 IPC、执行面板；从 `App.tsx` / `index.ts` 迁出计划相关接线 | E1、E2 |
| E3b | L9：统一模式选择器、`workMode` 字段与迁移、「自动」的 `enter_plan_mode` 工具 | E3 |
| E4 | 失败交互、重新规划、重启恢复 UI、完成后汇总、实机验证 | E3b |
| E5 | 远程项目：先修 `planReview.request` 多会话串话隐患，再给 facade 加 start 和计划模式 | E4 |
