# Phi 事件驱动助手与 Comma / Super-agent 的对照研究

调研日期：2026-11-07。本文区分官方工程合同、已阅读的源码、产品声明与尚未核实的能力。未部署或运行 Comma，未执行其测试；结论不等于生产验收。初始 Comma 引用为官方仓库 `main` 页面，网页抓取时间可能不同；不得把不同页面当作同一提交的完整快照。

## Comma 的可核对能力

### 1. 单入口与多 Worker：与 Phi 提议方向相同，但任务身份更独立

官方产品模型将 Assistant Chat、Task、Conversation、Agent 和 Runtime Session 分开。一个已配置 Router 有一个 canonical runtime session，Worker 可以有多个任务执行会话；“Single Session”不代表整个系统只有一个执行上下文。普通 Task 有负责的 Worker，Worker 返回消息，Router 管理任务状态。任务保留自己的历史、来源权限与身份，能继续接收后续要求。

来源：[产品模型与 Single Session 定义](https://github.com/AFK-surf/Comma/blob/main/docs/architecture/PRODUCT_MODEL.md)、[任务生命周期合同](https://github.com/AFK-surf/Comma/blob/main/docs/salix/tasks-background-execution.md)。

对 Phi 的启示：长期身份应落在 Task 上；聊天气泡、模型调用与临时 subagent 都不能成为任务身份。用户看到一个入口，并不要求底层共享一份不断膨胀的 transcript。

### 2. Loop 把“持续值守”和“大模型推理”拆开

Comma 的 Loop 是独立的、Agent 拥有的程序，由计时器、外部事件和受限宿主能力驱动；需要处理时才通知 Session。源码 `SalixAgent.Loops` 定义程序哈希检查、持久记录、运行代次校验、通知预算、重启预算及暂停/恢复；`Loops.Host` 负责子进程通信、截止时间、容量约束与过期结果丢弃。

来源：[Loops 源码](https://github.com/AFK-surf/Comma/blob/main/systems/apps/salix_agent/lib/salix_agent/loops.ex)、[Host 源码](https://github.com/AFK-surf/Comma/blob/main/systems/apps/salix_agent/lib/salix_agent/loops/host.ex)。

工程合同进一步定义外部事件先入持久存储，再返回接收确认；消费者在安静结束或完成持久下游交接后 ACK。事件投递、Session 接收、可见回复和外部交付是不同事实，不能互相替代。详情见[后台执行合同](https://github.com/AFK-surf/Comma/blob/main/docs/salix/tasks-background-execution.md)。

对 Phi 的启示：先实现受控的事件源与订阅规则，即可获得低成本主动性。允许 Agent 编写任意长期程序是另一个实施层级，需要能力约束、生命周期、预算、来源权限、版本和故障处理，不能仅增加一个定时器。

### 3. 持久执行包括状态所有权与副作用恢复

运行时合同使用版本 CAS 确认当前 Session 状态；输入确认必须等待持久化；工具副作用开始前先记录执行意图。模型、工具和压缩有界等待，迟到结果不得复活取消的执行。重启恢复优先核对已保存结果，不自动重做中断的变更动作。

来源：[Agent runtime](https://github.com/AFK-surf/Comma/blob/main/docs/agent-runtime.md)。

这比“保存任务列表、崩溃后重启进程”要求更高。Phi 应把接收、开始执行、执行结果、结果汇报分别建模，并将不确定的外部副作用保留为待核对状态。桌面关闭后仍在线，还要求一个继续运行、持有合法凭据和所需资源的宿主；持久日志本身不能提供 24 小时计算环境。

### 4. 上下文外的状态与检索有工程基础，不能等同于训练模型

官方存储合同将 Conversation 元数据和 Message 保存为持久事实，并将 Task 搜索等作为可重建投影。Session 保留已接收输入的完整身份和负载，压缩、模型上下文和公开历史只读取各自允许的投影。运行时另有 Condensed Workspace，将工作概况供 Router/Worker 按版本更新。

来源：[Storage and search](https://github.com/AFK-surf/Comma/blob/main/docs/storage-search.md)、[Agent runtime：Condensed Workspace](https://github.com/AFK-surf/Comma/blob/main/docs/agent-runtime.md#condensed-workspace)。

对 Phi 的启示：先区分任务事实、项目知识、用户偏好、临时工作上下文。事实需要版本与来源，检索需要权限与新鲜度；不能把压缩摘要当作所有任务的权威状态。摘要与经验记录属于记忆管理，并不改变模型权重。

### 5. 跨渠道的主要难点是权限、路由与交付

BFT 的官方合同将产品范围与 Salix 执行范围分开；外部消息要经过来源验证、安装关系和目标访问检查，已有任务的后续输入也保留新请求的来源权限与受众。Triage 会记录 Worker 的决策、静默原因和跟进义务。一个模型回复、预览或任务状态并不能证明问题已解决或外部消息已送达。

来源：[Bridge For Teams](https://github.com/AFK-surf/Comma/blob/main/docs/bridge-for-teams/design.md)、[Tasks：Continuation and containment](https://github.com/AFK-surf/Comma/blob/main/docs/salix/tasks-background-execution.md#continuation-and-containment)。

对 Phi 的启示：MCP/连接器能提供调用能力，但跨渠道收件、事件去重、任务关联、来源权限、结果回投与交付回执仍需产品层实现。不能把微信或 Linear 的所有输入直接注入一个具有全局权限的主上下文。

## 文章中需要保留证据边界的说法

### 持续学习与专属小模型的实现证据

这次阅读覆盖 README、产品模型、运行时、后台执行、存储检索、BFT/Triage 与形式化验证文档，以及 Loop/Host 的源码页面。可以核对外部 `decide` 判别能力、任务/来源/评估记录、工作状态摘要和 Triage 的反馈/跟进合同。**这些证据不足以确认文章描述的通用自动训练流水线。**

尤其不能把外部小模型决策调用、用户记忆、Triage 的人工纠正或业务决策记录，直接解释成“训练了新的专属模型”。核实完整链路还需要看到数据集版本、标签来源、训练作业、独立评测集、晋升门槛、部署切换与回滚。当前结论是“该具体链路尚未核实”，不是“仓库不存在任何训练代码”。

来源：[决策能力合同](https://github.com/AFK-surf/Comma/blob/main/docs/salix/tasks-background-execution.md#decision-capability-design)、[BFT Triage 合同](https://github.com/AFK-surf/Comma/blob/main/docs/bridge-for-teams/design.md#triage-collaboration)。

### 形式化验证的范围

官方说明限制了证明范围：部分 Session/AgentLoop/信息流性质在给定假设下得到证明；宿主、存储提交、编解码和外部服务等仍依赖假设与测试。证明不保证模型判断、用户任务成功、外部副作用恰好一次或无条件进展。IFC 的部分结论还依赖数据来源声明真实完整。

来源：[验证范围与限制](https://github.com/AFK-surf/Comma/blob/main/docs/verification.md)、[TLA+ system-core policy](https://github.com/AFK-surf/Comma/blob/main/tla/README.md)。

对 Phi 的启示：优先明确输入不丢失、旧执行者不能提交、取消不被迟到结果撤销、副作用不盲重试等不变量，用状态机和故障测试证明。形式化验证可以后续用于关键状态转换；不能作为功能正确性测试的替代。

## 直接复用 Comma 的现实约束

- **技术栈**：核心是 Elixir/OTP，关键部分使用 Lean，连接器包含 Go；自部署还涉及 PostgreSQL、Redis、对象存储和 ClickHouse。这是一个完整运行平台。把它作为 Phi 桌面 TypeScript/Bun 内核的零散依赖，适配成本可能高于按其合同独立实现。
- **许可**：官方 README 标注原始代码为 **AGPL-3.0-only**，第三方组件保留各自许可；贡献另有 CLA。不能将其源码或翻译后的派生实现当作 MIT 代码直接并入 Phi。若计划复制或组合分发，应先明确相应许可义务；设计思想与独立实现是不同的复用路线。
- **部署证据**：README 说明部分 Meeting/VMM 宿主运行时不在仓库内，不能把“仓库可自部署”解释为每个产品演示能力都无需额外基础设施。

来源：[README：技术栈、自部署和许可证](https://github.com/AFK-surf/Comma/blob/main/README.md)、[LICENSE](https://github.com/AFK-surf/Comma/blob/main/LICENSE)。

建议将 Comma 作为任务领域模型、持久输入、Loop 生命周期、权限来源和故障语义的参考。若希望整体采用 Salix，则把它当作独立后端架构选择评估，而非本轮事件驱动改造中的小依赖。

## 与上一版 Phi 提议的差别

上一版是设计建议，不能当成已经实现的功能。它覆盖持续收件、Event/Task/Run 分离、独立任务并行、依赖与资源约束、结果事件回流、取消版本保护和统一状态展示。文章强调的长期自治还需要以下补充。

| 维度       | 上一版设计的不足                     | 建议补充                                                                                          |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 长期任务   | 仍主要围绕一个聊天的运行与消息       | 项目/工作空间内持久任务总账；任务可跨运行、压缩和界面继续，保留目标、来源、验收、依赖、产物和版本 |
| 上下文     | 未明确 Router 的上下文装配与检索     | 任务事实是权威；Router 只加载活跃任务摘要、相关事件、决策和按需证据；Worker 保留自己的日志        |
| 主动性     | 主要响应用户和已有任务的事件         | 受控事件源、持久订阅、定时触发、条件过滤、去重、冷却、预算；先做固定能力，再考虑可编程 Loop       |
| 持久在线   | 明确只覆盖当前桌面生命周期           | 另设常驻宿主、独立监督、模型/凭据/工具可用性合同；客户端离线时明确哪些工作能继续                  |
| 人的注意力 | 后台面板与计数仍要求用户自行巡视     | 需要回答/批准/查看失败的事项独立汇总；普通进度静默，成果批量呈现；保留用户跟进容量                |
| 完成标准   | 完成事件与报告尚不足以证明目标达到   | 区分执行结束、成果已校验、交付已确认；可自动验证的任务自动收口，需要业务判断时才请求人工验收      |
| 学习       | 未规定反馈数据、评测或晋升           | 先记录纠正与验收、建立独立评测集、改进规则/提示/经验；参数训练另立项目                            |
| 资源和费用 | 有并发限制，但任务级总预算未完整定义 | 合并父子任务费用、工具/算力上限、重试额度、期限与公平调度，不以无限并行作为目标                   |

这些是对 Phi 的设计建议，不是声称 Comma 已通过上述所有生产验收。

## Phi 当前可以复用的实现

- [消息队列](../../src/renderer/src/features/chat/hooks/usePromptQueue.ts)与[排空逻辑](../../src/renderer/src/features/chat/hooks/useQueuedPromptDrain.ts)：当前在 Renderer 内存保存队列并等空闲发送，不能作为持久调度的权威。
- [自动续接策略](../../src/main/agent/agents/run-continue.ts)和[主进程唤醒](../../src/main/index.ts)：已有子任务、Wrapper、计划与 Shell 完成事件回流，待处理事件及部分去重状态在内存。应收敛到持久任务处理，而非再添加平行回调系统。
- [子任务注册表](../../src/main/agent/agents/registry.ts)、[内核回执](../../src/kernel/agent-runs/receipt-store.ts)和[计划调度](../../src/main/agent/plan/model/plan-scheduler.ts)：已有并发、队列、启动回执、依赖与声明的写路径冲突检查。工具执行中的动态资源约束仍需设计，不能将声明的写路径视为完全隔离。
- [项目记忆](../../src/main/agent/memory/project-memory-worker.ts)、[经验工具](../../src/main/agent/memory/learn-tool.ts)和[记忆设计](../design/phi-memory-design.md)：按项目开启，复用 OMP local 后端；摘要和经验可以保留。应增加来源、版本、新鲜度及任务相关检索，不默认混合所有项目记忆。
- [任务判断](../../src/main/agent/decisions/tool.ts)与[判断模型说明](../architecture/decision-model.md)：现有 `phi_decide` 提供证据审查和恢复建议。消息路由需要独立的判断合同；该文档 D0–D6 仍是提案。
- [计划任务合同](../../src/shared/planRunTypes.ts)与[步骤提示](../../src/main/agent/plan/execution/step-prompt.ts)：已有 acceptance 字段与报告要求，但模型自报 completed 不能替代文件存在性、数据完整性和领域结果检查。
- [后台任务状态](../../src/renderer/src/features/jobs/hooks/useBackgroundJobsData.ts)和[右上角入口](../../src/renderer/src/components/app-shell/TopRightControls.tsx)：直接扩展统一视图；减少单独轮询/计数逻辑。
- 当前锁定 OMP `18.10.3`，安装包声明 MIT；Phi 的[根许可证](../../LICENSE)也是 MIT。继续复用现有执行器、工具与模型适配，避免同时更换 Harness。

MCP 连接器的现有合同主要描述工具服务的安装、鉴权与调用，不等于已经具备外部渠道消息的持久接收、用户映射、任务归属和结果回投。参见[Connector 合同](../contracts/connector.md)。

## 其他开源项目的具体复用位置

DeepSeek 原型核对提交：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。原型 [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md)明确说明研究性质、公开版与内部版不同，部分文章方向未实现。未运行这些项目的测试；以下是源码阅读后的适配建议。

| 来源与模块                                                                                                                                                                                                                                                                                            | 可复用内容                                                                     | Phi 仍需承担的部分                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| DSH [effects.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/effects.ts)及[测试](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/tests/effects.spec.ts)                       | 持久待执行项、按 key 合并、类型限流、退避、seq/generation 防止旧结果清除新工作 | 接入 Phi 状态存储与任务身份；明确哪类副作用可重试，测试崩溃窗口            |
| DSH [outbox.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/outbox.ts)                                                                                                                                                              | 回执和待发送项共同入库、交付失败后保留和核对                                   | Phi 的聊天投影、外部渠道适配、目标权限；不把本地去重当作外部副作用恰好一次 |
| DSH [stage.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/stage.ts)及[面板合同](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/005-panel.md)                          | 优先呈现需回答、需审阅、交付失败和受阻事项                                     | Phi 的状态字典、任务面板、角标和中英文文案                                 |
| DSH [admission-context.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/admission-context.ts)                                                                                                                                    | 有界消息读取、事件邻域、遗漏和分页标记                                         | 项目知识、任务摘要、工具证据和隐私范围的上下文装配                         |
| Rakazo [background-helpers.ts](https://github.com/elie222/rakazo/blob/344c0904d99b4a20e72180962c408094097d9579/packages/adapters/src/background-helpers.ts)、[thread-steering.ts](https://github.com/elie222/rakazo/blob/344c0904d99b4a20e72180962c408094097d9579/packages/db/src/thread-steering.ts) | 派发立即返回、独立 helper、结果回流去重、补充消息持久领取与安全边界合入        | 替换其 Prisma/任务实体和权限假设，沿用 Phi 的内核与子任务注册表            |
| OpenMuse [worker.ts](https://github.com/CopilotKit/openmuse/blob/a4944f4c471d3dc93b8bfc060b5da309b5216ab2/apps/server/src/engine/worker.ts)                                                                                                                                                           | 执行租约、续约、CAS/checkpoint、失效执行者保护                                 | Phi 的任务状态、存储与恢复政策；超时不能直接等价于可安全重执行             |

DSH 的 `src/core` 按[架构合同](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)约束为无 I/O 领域逻辑，较易改编；运行时、Session、Executor 和界面依赖 Cordis/DSH。其[依赖表](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json)含约二十个 DSH peer dependencies，整包不是 Phi 可直接替换的通用调度库。

另外两项边界需要保留：DSH 的 Eval 判断是否接纳工作，不等于训练评测或科学成果验证；其 Watchdog 是[部署文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md)里的独立 profile 定时检查和管理脚本，不是一套可直接嵌入的自治修复服务。OpenMuse 的[聊天队列](https://github.com/CopilotKit/openmuse/blob/a4944f4c471d3dc93b8bfc060b5da309b5216ab2/apps/mobile/src/conversation-queue.ts)仍然串行，不能用来替代目标中的任务并行调度。

许可核对：[DSH MIT](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/LICENSE)、[OpenMuse MIT](https://github.com/CopilotKit/openmuse/blob/a4944f4c471d3dc93b8bfc060b5da309b5216ab2/LICENSE)、[Rakazo Apache-2.0](https://github.com/elie222/rakazo/blob/main/LICENSE)。复制或改编仍须保留适用的版权、许可与 NOTICE 等要求，并核对被复制模块的第三方依赖；本次没有引入任何外部源码。

## Phi 必须拥有的产品语义与集成

“自己实现”指 Phi 对规则和集成负责，不要求重写已有 SDK、协议库、数据库或模型传输。

1. **任务事实与意图归属**：新建/补充/取消/依赖任务的语义、项目范围、版本变化、跨运行身份和可恢复状态。
2. **执行与资源权威**：本地、SSH/HPC、Notebook kernel、浏览器和项目文件的容量、互斥、权限、费用和取消规则；模型只能建议，宿主决定能否执行。
3. **成果校验与交付**：产物、引用、参数、数据/软件版本、验收证据和交付回执；根据任务类型自动校验或交给人判断。
4. **注意力分配**：哪些事件需要立即处理、哪些进入摘要、哪些静默；跟进请求不被后台工作耗尽容量；输出可追溯到任务。
5. **外部入口与常驻策略**：外部身份与项目映射、来源鉴权、回投目标、离线能力、凭据所有者、人工停止和监督进程。
6. **经验晋升**：反馈何时成为可信经验、如何失效/删除、如何评测和回滚；通用开源训练工具不能替 Phi 决定哪些科研结果算正确。

## 实施建议与验收

1. **当前增量**：持久收件/回流、任务身份和版本、非阻塞输入、统一任务状态；复用既有运行时与回执。验收连续提交、切换聊天、重复事件、取消竞态、重启核对。
2. **随后补齐**：有界 Router 上下文、需要用户处理的收件箱、任务验收、按资源的并行和任务预算。验收旧结果不能覆盖新要求、产物检查失败不能显示已验收、同资源不冲突、普通进度不刷屏。
3. **再扩展**：固定的定时/文件/作业事件源，先在桌面活跃期间运行；外部渠道按需加入，检验去重、来源权限、交付失败和循环触发控制。
4. **另立范围**：24 小时独立宿主、跨端跨渠道与完整 Watchdog；检查模型访问、凭据和宿主工具是否仍依赖桌面，不把当前重连宽限期当作无人值守。
5. **最后评估学习**：先收集经授权的纠正与验收案例，使用独立留出集衡量路由错误、误打断、失败恢复、交付正确率与费用；先改规则/提示/经验，训练小模型等数据与收益明确后再决定。

范围依据：[内测路线图](../roadmap/internal-beta-implementation.md)、[内核路线图](../roadmap/phi-kernel-implementation.md)明确将常驻无人值守等排除在当前内核工作之外；[能力自主扩展决策](../decisions/capability-autonomy-safety.md)将学习草稿与执行/批准分开，并列为 beta 后工作。本研究不改动这些已确认范围，也不把其中的设计草案标为已交付。

本轮仅新增此研究文档，未改应用代码、未安装依赖、未复制外部源码。源码核对与设计推导不是运行验收，外部产品完整的训练闭环和实际生产可靠性仍未验证。
