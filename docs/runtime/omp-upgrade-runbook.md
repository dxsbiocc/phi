# OMP 升级操作手册

更新日期：2026-10-15。适用于 Phi 桌面 SDK、原生模块及远程 OMP 运行时的同步升级。

本手册对应 [OMP 计划的 T17／阶段 5](../roadmap/omp-decoupling-upgrade-plan.md)。升级应保持 [internal beta 的本地会话可靠性、审批和可恢复历史](../roadmap/internal-beta-implementation.md)，不附带新 UI、公共分发或无关迁移。远程工作沿用户已确认的独立计划推进，真实服务器连接仍需 R8 授权。

本轮限定状态（2026-10-15）：原 T11 history 三场景通过，补五项断言后只复验 vendor/KV 一例；辅助 opaque 仍需上游公共修复，完整 T11 未关闭。原 T16 终端修复已 main `10f979bc`，原压力五阶段和 15 项纯测试、primary build/types/lint/asar 通过；GPU 官方 18.10.3 安装/隔离版本及原 `d670` bundle 的无 provider RPC foundation 通过；最终 `f964` foundation 另记。Cursor 子任务恢复与取消已完成本轮限定验收：最终 f964 包的实时停止、排队恢复前停止和后台控制 3/3 通过；旧 d670 四类恢复及 later-Main negative 证据按原版保留。node2/node3/yzhang 组按用户要求暂缓（deferred）、不作功能失败。

源码 `19da6594` 已合入 `db09181f`。该整合候选的生产类型、构建、lint、asar 均退出 0（68.75 秒）；2704 个跟踪文件、HEAD、tree 及共享资源引用前后稳定。未重跑该整合候选的全库测试。以上结果仅指本轮限定范围，不代表当前全库或双主机 R8。历史步骤和证据保留，最新升级合同见文末。

## 1. 固定起点与目标

1. 记录当前提交、工作区状态、SDK／原生模块版本、捆绑 Bun 版本及已有检查结果。保留并行任务的分支和未提交改动；不要把其差异归入 SDK 升级。
2. 从确认的起点建立 `codex/omp-<version>` 分支，使用独立依赖目录。升级分支不能借用仍运行旧版本的主工作区 `node_modules`。
3. 按开始升级当天核实的稳定版本冻结目标；过程中新发版本留给下一个升级周期。`package.json` 中 `@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-natives` 必须是相同的精确版本，不能使用范围或 `latest`。
4. 阅读旧版本至目标版本的官方 changelog，摘出 Breaking Changes、Removed，以及 tool、session、settings、auth、MCP、extension、subagent、RPC 相关变化。将适配方式、行为差异和验证证据写入审查说明。

本次起点为阶段 1 已合入 main 的 `6d9d9ef3`，SDK 18.1.10；目标冻结为 18.10.3。T8 提交 `cf2303ce` 保存在 `codex/omp-upgrade-18-10-3`。用户此前要求暂留分支；2026-10-14 另行授权开始合并，已整合为本地 main `631671e6`。此前阶段 1 的授权不作为此次依据，远程默认启用和真实服务器验收也不随代码合并完成。

## 2. 核实官方来源与完整闭包

核对目标版本的官方 npm 精确版本元数据，例如本次的 [coding-agent](https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/18.10.3) 与 [natives](https://registry.npmjs.org/@oh-my-pi%2Fpi-natives/18.10.3)，以及对应的 [GitHub release](https://github.com/can1357/oh-my-pi/releases/tag/v18.10.3)。记录查询日期、非 draft／非 prerelease 状态、tarball 地址、`dist.integrity`、运行时要求与许可证。

- 检查 `bun.lock` 中完整 `@oh-my-pi/*` 闭包，包含 `pi-ai`、`pi-catalog`、`pi-tui`、`pi-utils`、`pi-agent-core`、`pi-wire` 及各平台 natives。只核对两个直接依赖不足以证明版本一致。
- 将下载 tarball 的 SHA-512 与官方 `dist.integrity` 比对；新增上游传递依赖也要核对。镜像 URL 的内容必须有相同的官方完整性证据，不能仅凭文件名信任。
- 独立安装后核对实际安装版本与锁文件，保存冻结安装结果。不要手改 `node_modules` 作为最终兼容修复。
- 核对目标包的 `engines.bun` 与 [捆绑运行时清单](../../resources/runtime/manifest.json)。本次要求 Bun `>=1.3.14`，捆绑及验证使用 1.3.14。
- 记录新增传递依赖对磁盘加载、原生模块、打包体积的影响；新增直接依赖需要单独授权。

本次闭包共有 18 个 OMP 包，包含六个平台 natives，全部精确为 18.10.3。七份官方源码 tarball 的 SHA-512 通过核对；18 个 OMP 包和新增 `axe-core@4.13.0` 的锁条目完整性与官方元数据一致。当前 OMP 条目使用官方 registry URL；axe-core 锁条目仍使用镜像 URL，其完整性已经核对，不能描述为所有 URL 均已改为官方地址。

### 远程二进制清单

同时更新 [远程运行时 manifest](../../src/main/agent/engine/rpc/runtime-deployment/manifest.ts)。桌面 SDK、manifest 版本、RPC 协议适配必须对应同一目标版本。地址固定到 release tag，并将 SHA256 与官方 [SHA256SUMS.txt](https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/SHA256SUMS.txt) 和 release asset digest 比对。

| 平台               | 本次固定资产                                                                                      | SHA256                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Linux x64／glibc   | [omp-linux-x64](https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-x64)     | `366ffcda80db57b825921b6ff4b0e5e623bc62cf18478f2828cd8a322fc72ff9` |
| Linux arm64／glibc | [omp-linux-arm64](https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-arm64) | `7f580e1fe06ebffe16ae46cc6881051aca4980db7f654702feefed5651555862` |

清单存在不等于资产已在服务器运行。部署必须先验证下载哈希，再验证上传后的哈希、执行权限和精确版本，最后原子激活。保留已验证的旧版本；平台、glibc、权限、空间或校验不满足时给出原因，不回退到用户的 `~/.omp`。复用已有 WorkspaceHost 传输、进度、取消及恢复机制。

## 3. 在引擎边界内适配

以 `src/main/agent/engine/` 为 SDK 兼容边界，保持 Phi 自有公共接口。不要把上游类型、内部 API 或版本判断扩散到 renderer、会话管理等调用方。引擎外确有必要修改时，审查中说明原因、范围及为何不能在边界内解决。

| 检查面          | 18.10.3 的实际处理及后续升级必须保留的行为                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth            | `in-process/auth.ts` 接 `credentials/keys/oauth` 命名空间；API key 替换／删除保留其他 OAuth 凭据，隔离 provider／MCP URL，保留来源优先级、登录回调与取消。状态查询不能触发真实 OAuth 刷新。                                                                 |
| Settings        | `in-process/settings.ts` 接注册设置对象；持久写入与临时 override 分开。搜索使用官方 web role／fallback chain，并保留 Phi 元数据；测试别名、间接 role 修改、项目／全局边界和空 Basic 凭据。                                                                  |
| 内部函数        | 在 `omp-internals.ts` 等现有边界适配 catalog、thinking、schema token 估算。已失效 provider globals 调用删除，避免仅为估算或解析加载 TUI。不要假定路线图中的旧导出名仍正确。                                                                                 |
| 事件            | Phi 自有 discriminated union、运行时校验和摘要分别适配。新增 SDK 事件要审查字段与穷尽检查；未知 wire 字段仍须保留，不能用宽泛强转掩盖缺口。                                                                                                                 |
| 不可用模型恢复  | 只处理明确的已保存模型恢复错误。阻止相似 ID、前缀／glob 模糊匹配导致静默换模型；保留历史并要求显式选择有效模型后继续发送。初始化兼容视图不能污染后续真实 registry。                                                                                         |
| 专家环境与 Bash | 保留原始审批输入、安全引用、主机变量隐藏、环境撤销／重绑、跨调用用户 export、每次 cwd 重置、退出码、输出和取消语义。每个专家使用非持久 child settings overlay 关闭自动后台化，避免普通 Bash 被新版异步管理器转为一次性任务。主会话及显式 async 不随之改动。 |
| MCP stdio       | `mcp/owned-stdio-transports.ts` 的精确 `SDK_VERSION` 是安全兼容门槛。先对照官方 spawn／connect／close／所有权实现并通过生命周期测试，再更新版本；保留完整性检查及取消／释放逻辑。                                                                           |
| 打包            | 检查 Bun worker 的磁盘依赖闭包和 natives 平台文件。Bun 无法从 `app.asar` 内加载这些资源；本次新传递依赖 axe-core 需要完整包进入 `asarUnpack`。                                                                                                              |

**已知 Bash 差异必须保留在审查记录中**：环境包装使用函数作用域后，顶层 `return`／`local` 获得函数内语义；旧 native 直接执行将其视为无效顶层命令。普通命令的环境、export、cwd、输出、退出及取消已对照旧／新真实 worker 验证，不能据此宣称所有 shell 语法完全等价。

### RPC 启动与恢复的升级检查

- 私有 `startup-policy.json` 固定禁用 `native`、`claude`、`codex`、`omp-plugins`、`claude-plugins` 五个 capability provider。升级时确认官方发现流程仍读取该设置，根会话与子会话均不自动导入项目工具。这里也会过滤同名模型 provider，必须保留明确冲突报错。
- 项目 `.omp/plugins` 的工具发现不经过上述 provider 过滤。启动前的只读预检必须与目标 SDK 的 lockfile、overrides、manifest、feature-tools 及符号链接语义对齐，并在 `openStdio` 前拒绝可加载工具模块。普通 `.claude`／`.codex` 配置目录应继续可用。
- 保留真实 CLI sentinel 回归，确认项目工具在 Phi 守卫前没有被导入；配置字段存在或 shell 预检通过本身不等于这一行为通过。检查完成到启动之间的同 UID 文件替换竞态仍是已记录残余风险，不宣称已消除。
- Cursor 的原生断流恢复会随 SDK 变化。本地 18.10.3 已验证纯文本错误分类可能使原生重试与 Phi 续答叠加；RPC 路径必须单独验证纯文本截断、已完成工具后的截断、完整答案后断连和主动停止，不能仅因为扩展随包上传就假定已加载或行为相同。

对应回归为 `engine-rpc-ssh-stdio-factory.test.ts`、`engine-rpc-task-admission-native.test.ts`、`cursor-stream-recovery.test.ts` 与 `engine-rpc-cursor-stream-recovery.test.ts`。PM-3 已保存为 `044bac9b`：模型网关只为可信 Cursor API 保留精确的固定截断分类，RPC 恢复绑定实际 session registry；专项 23 项、独立真实 RPC 5 项及错误隐私 2 项通过。Cursor 子任务、真实 SSH/provider 仍待验证，不能从此限定结果推定。

更新 [引擎白名单](../../scripts/engine-boundary-allowlist.json) 时，对新增内部路径说明用途和保留／删除计划。终端 natives、测试辅助及评测脚本仍有既定例外；检查通过不代表这些过渡条目已经消除。不要为了消除检查报错直接扩充白名单而不修边界。

## 4. 自动化验证顺序

以下命令均从候选分支仓库根目录运行。脚本和路径已核对；本次升级的执行结果见第 8 节。本手册编写没有重复运行完整 QA。

先按受影响行为运行定向回归，再完成生产类型检查、构建、打包闭包、lint 与全量测试。构建完成后复查 asar，才能同时覆盖实际产物：

```sh
bun run typecheck
node_modules/.bin/tsc --noEmit -p tests/engine-contract/tsconfig.json
bun run check:engine-boundary
bun run build
bun run check:asar-unpack
bun run lint
bun run test
```

`typecheck` 仅包含 node、web、scripts，不包含全部测试类型。新测试还须通过对应的窄范围类型检查；若使用 `bun run typecheck:tests`，将已有诊断与新增诊断分开记录，不用生产检查代替测试类型验证，也不顺手修复无关历史债务。

当前真实进程内引擎契约与 R1 部署测试可单独运行：

```sh
node --import ./scripts/test-loader.mjs --test --test-timeout=90000 tests/engine-contract.test.ts
node --import ./scripts/test-loader.mjs --test --test-timeout=30000 tests/engine-remote-omp-deployment.test.ts
```

限定测试直接使用上述 Node runner，不向 `bun run test` 附加文件名，以免基础脚本的通配符仍然展开全套。全量脚本当前使用并发 4、300000ms 文件超时及 `--test-force-exit`；保留这些条件以及已有跳过条件，修复实际失败后重新确认。

### 契约证据要求

- 使用真正的 PhiEngine → bridge → Bun SDK worker，假 provider 只负责生成可控响应。隔离 HOME、agentDir、缓存、凭据和历史，只允许 loopback 请求，使用合成凭据，保证失败后也清理进程与临时目录。
- 观察真实文本增量、工具事件、历史、审批副作用、取消后下一轮、两会话／专家环境隔离；不能仅检查 mock 调用次数。
- 保留旧版本创建的真实会话，在新版本恢复并继续，验证旧消息进入 provider history。
- 保留 API key／合成 OAuth 存储测试、Settings live reload、未知事件字段、原生工具、stdio 取消与释放等受影响回归。
- 原生模块升级后运行适合当前机器的终端 smoke；实际脚本包括 `smoke:terminal-host`、`smoke:terminal-manager`、`smoke:terminal-stress`。`smoke:terminal-packaged` 需要仓库外的真实 `.app` 路径，开发态 smoke 不能代替它。
- RpcEngine 基础实现验收后，应让两种引擎运行共同的基础会话契约，并单独覆盖协议协商、请求关联、分块边界、退出、取消与重连。T10a 基础契约已通过，T10b bootstrap 的独立与核心集成验证见下方记录；未交付的模型代理、宿主工具、审批和恢复契约仍须逐项补齐，也不能删除本地完整契约来缩小验收。

## 5. 对失败先取证再归因

保存命令、提交／差异标识、环境版本、退出码、总数、失败／取消／跳过数、耗时及原始日志。稳定复现的 SDK 错误与全机停顿分别调查；定向重放成功只能证明该次重放通过，不能替代冻结代码的最终全量结果。

如果怀疑 macOS 睡眠，使用 `pmset -g log` 的具体 sleep／wake 时间与失败窗口对照，不能仅凭耗时很长就归因。确认供电与机器清醒后，可用临时 `caffeinate -is -- bun run test` 重跑；该命令在本次已执行通过。核实临时进程断言生效，并在进程结束后释放，不永久修改系统电源设置。

后续 T10a 的首轮全量有 50 个 `listen EPERM 127.0.0.1` 失败，均为沙箱禁止本地监听；在允许隔离回环服务的环境重跑同一冻结代码，4862 项全量零失败。测试监听权限与代码正确性分别取证，不放宽业务断言、超时或跳过条件。

本次两次未通过运行的停顿窗口与系统 Idle／Maintenance Sleep 记录吻合。此前仅使用 `-i` 没有覆盖维护睡眠；最终 `-is` 冻结代码运行才取得完整通过结果。早先失败日志保留，未放宽断言、超时或跳过条件。后续故障仍须重新取证，不能套用这个原因。

## 6. 人工清单与远程启用门槛

逐项记录目标提交、机器／系统、操作、结果和证据。没有执行的项目写“待验证”，不要用自动化结果推定通过。真实凭据只经现有产品登录流程使用，不写入测试、日志、命令或服务器部署包。

### 当前受控应用入口

原 T12 全部宿主工具已合入本地 main `fb0d054`，固定候选标准全量 6083 项零失败，合并后主工作区类型/构建、asar 和四项终端宿主检查通过。全量之后仅独立压力脚本 PID 就绪修复，产品与全量测试源不变。附加 supervisor 压力阶段的既有状态竞争按 T16 待修；`smoke:terminal-packaged` 必须提供实际 `.app` 路径，未执行不得记为通过。详细首轮失败、修复及版本边界见 [冻结整合验收](omp-remote-acceptance.md#冻结整合验收)。

原 T13 模型/思考级别实际控制及默认策略修正已合入 `365b2db`，复用 T12 审批、资源和 journal 恢复。升级回归应核对：空闲时从 main 可信目录选模型，模型切换新代只授权原模型与目标模型（去重后最多 2）；超过 256 的主目录不应导致启动失败，也不扩大 gateway256 预算。运行中/待批远程控制在写入前拒绝；每次 await 后重查原 session/generation/project/host/ref，迟到 UI 回复不能改动另一个会话。读取 SDK 实际可用思考级别并确认 effective state，不能把原始 `set_thinking_level` 的静默降级当成功。SDK/checkpoint/adoption 确认后才保存和发布 Phi 策略；不确定结果要求显式恢复同 journal，禁止隐式重放 prompt/工具。

模型切换后的原资源调用、子任务、上下文查询和改名仍须可用；子配置在父模型/思考确认后建立。缺失 task wrapper 只可经可信空闲 attestation 的完整身份/资源/发布检查安装，被替换 wrapper 或错误父模型必须拒绝。本批官方 CLI 合同独立 5/5、UI 25/25、相关组 369/369、独立实际 4/4 与 main/权限 8/8，候选生产类型/lint/build/asar 和合并后主工作区 build/asar 通过。首轮相关组的 1 次原超时、隔离和最终同组通过记录均保留，未改期限；未重复全库，T12 6083 项仍只对应其旧冻结 tree。详细版本和限制见 [T13 增量验收](omp-remote-acceptance.md#t13-模型与思考级别实际应用增量2026-10-15)。最终 `365b2db` 主工作区类型/build/asar/完整 lint 再次通过（36.31 秒，2529 跟踪文件哈希前后未变）。最终默认策略补丁 `81b48731` 另以 7 单元、原模型/思考及新真实 fallback 3 项、独立 fallback 1 项验收；自动 high/最高常规，无常规 off，保存/显式 xhigh/max 不变。369 项证据属于补丁前 `1064cd63`，不混用版本。压缩随后已由 `eea33bd3` 的独立增量完成，persona/memory/context 后续已随 `9f723379` 完成交付，默认开关不变。

原 T13 压缩控制已合入 `eea33bd3`，最终候选 `9b1425aa`（相关组 `88cde2d8` 之后仅修单元测试类型来源）。升级须验证手动压缩的私有回调与真实 checkpoint，不把 command ACK 当成功；停止必须可达并等待原 CLI 终态/退役。接受 A 压缩后切到 B，A 应继续并只向 A 发布；原 owner/host/journal 被替换必须拒绝。自动 70/80/90/继承须确认实际加载四字段后才保存，模型切换和恢复继续保留策略；原生 -1 reserve sentinel 合法，启用非空 per-model 阈值 map 无法被当前协议忠实表达时须在旧代退役/保存前明确拒绝。合法 summary 多请求不等于原工具重放，取消允许官方 session_exit，旧 journal entries 须保持。真实 CLI 6/6、独立实际 4/4、相关 610/610 及候选/主工作区生产类型/lint/build/asar 通过；并行输入编辑器 WIP 保留且未提交。原失败、精确版本与结构例外见 [压缩增量验收](omp-remote-acceptance.md#t13-压缩实际应用增量2026-10-15)。

原 T13 Phi 应用功能已全部合入 `9f723379`（完整源码 `cadb8823`）。升级须同时核对默认 Phi/persona 恰好一次、可信远程三文件与真实路径、模型/压缩轮换和恢复后的固定配置；不得全局关闭 discovery providers 来隐藏模型。记忆必须证明真实本机 SDK 总结→canonical UI root→新会话 prompt，learn/删除/清空同源，旧 child 确认结束且 peer 不受影响；canonical 角色/预算、ENV auth/proxy/CA 行为保留，环境只用于同一受信本机 tool-less SDK child。记忆设置先退役旧写入者再保存；本代 prompt 不热替换，不中断已接受的聊天。原 T13 全矩阵、700/700 和真实场景证据见 [完整验收](omp-remote-acceptance.md#t13-全部-phi-应用功能交付2026-10-15)。原 T14/T15 本轮实现和限定证据已接续下文；最终候选验收不得用 T13 旧结果代替，真实外部验收仍属 T16。

实际主进程入口仍为显式 opt-in：`PHI_REMOTE_OMP_RPC=1` 才走 RPC，`PHI_REMOTE_OMP_AGENTS=Checker,...` 从 Main 可信目录选择完整具名定义。默认不开；renderer 不能提交替代定义或扩大权限。本轮 T14 已接独立模型/思考、原生 edit/搜索、可信 skills/环境/服务、Task 并行/后台四路与原 `agent_status/agent_wait/agent_steer/agent_stop`。当前整合提交 `03da779e`、合入 `a70d403b`；功能冻结候选 `d9b5d776` 标准全量 `6449 项：6424 通过、0 失败、0 取消、24 既有跳过、1 todo`、1542.28 秒，仅证明该候选，组合未重跑全库。版本与限定交叉检查见 [本轮验收](omp-remote-acceptance.md#t14t15-专家与显式恢复2026-10-15)。

T12 实际入口开放原生主工具、Notebook 七工具、Wrapper 六工具、Library 六动作、搜索、browser、`ask_user_question`、`render_blocks`、`palette`、`present_files`、下载、`skill_run`/可信声明脚本、`env_request` 和选定 MCP 工具，复用原服务及审批。主进程可信快照决定资源和执行位置；远程资源缺失不得回退到本机同名文件。persona/context/memory 现按主进程可信快照接入，未经授权或未知配置仍明确报错；专家资源/环境、Task 并行后台及四个控制工具按本轮 T14 的 Main 可信目录和所属子实例接入，最终证据绑定本轮固定候选。恢复沿 Phi 的远程引用读取同一 journal，不隐式重放 prompt。这是受控 opt-in 的自动化交付，真实 SSH/provider/OAuth/Finder 及默认开启仍按 T16 门槛。

Notebook 升级回归须观察真实 draft 与磁盘：update 被批准后仅改 draft，save 被批准才落盘；拒绝 save 或待批停止不执行保存，已批准的 draft 保留。异步后端查找中停止或重绑定 SSH 项目必须在 dispatch 前拒绝；已经开始的磁盘 I/O 不承诺回滚。桌面 AbortSignal 只留在服务 context，不进入工具参数、wire 或公共事件。用新代显式恢复同 journal 后，先确认没有隐式请求/工具重放，再显式读取原 Notebook；核对另一项目的 cwd/draft/disk 独立。本次实际应用 5/5、独立关键 3/3、main/adapter 相关定向检查通过，详见 [Notebook 增量验收记录](omp-remote-acceptance.md#t12-notebook-实际应用增量2026-10-14)。

Wrapper 升级回归须区分准入、等待和作业取消：环境/目标异步检查后，取消或改绑不得接受 job；被接受后 job 独立于聊天停止，保持原 target。停止 wait 只结束等待，明确 cancel 才终止作业；直接运行和 sbatch 写脚本后的实际提交前仍须检查原 job Control。status/list/wait/cancel 仅允许该 RPC Phi 会话/项目及对应 host/profile/root，列表先过滤归属再限数量，不得通过外会话查询阻止完成唤醒。T15 接受时持久保存可信 origin，冷查询每次复核当前 Phi/project/profile/root 与配置；新代只查询/监控原 job，不重复 launch。未知旧 origin 或不同连接/主机/目录仍明确拒绝。交付物须在远端验证后、发布前复核取消/原 run/项目绑定，结果保持远端 URI，不能打开本机同名文件。本轮实际场景和独立复验已证明同 Phi 新代恢复不重复启动，以及完成后只继续所属会话一次；使用隔离 SSH/Nextflow fixture，真实服务器与 Slurm/Nextflow 环境仍待 T16。完整结果见 [Wrapper 与交付物增量验收](omp-remote-acceptance.md#t12-wrapper-与交付物实际应用增量2026-10-14)。

T12 完整回归还须检查：Notebook 停止必须等真实 kernel ACK 和对应执行终态，未确认时隔离 kernel，facade 关闭不得提前释放原服务；旧取消不能影响新 run、peer kernel 或新下载续传。技能/环境在最终 SSH dispatch 前复核取消和可信声明，缺远程快照不得读本机路径。browser 的 typeText 只进入私有 vault 与实际宿主，公开事件、SDK journal 和下一轮模型请求不得含原文；对 rawBlock/providerMetadata/thoughtSignature 及 `name`/`toolName` replay 别名同样检查，旧不安全历史须在 adoption 前拒绝。MCP 401/403 只发送一次，下一次用户明确调用才再次执行；私有认证不能借 object key 或碰撞字段泄漏。大进度先完成有序 receipt hydration 才返回最终结果，取消中上传仍由原 controller 清理。实际 app、官方 CLI 和故障复审证据见 [T12 完整交付](omp-remote-acceptance.md#t12-完整宿主工具交付2026-10-14)。

### T14/T15 后续升级必须保持的合同

- 专家实际 model/thinking、完整工具集合、受信 skills/ready 环境/服务与发布哈希必须与 Main 选择的完整 profile 一致；SDK before_spawn 的每次子 factory 执行均要重证同一 Task/Main-attested owner。started 观察缓存只能作候选，不能单凭延迟事件或空 local profile 授权。
- Task 批量/后台沿真实 SDK manager，活跃与预留名额合计最多 4，超额拒绝。当前代活着时父 prompt 可以先返回、后台继续；冷重启不得把磁盘 transcript 或 metadata 变成 live job/handle，也不新增 daemon/setsid 自动续跑。
- 原四 agent 控制工具只在父 Main 的真实 host 名册启用，不自动给专家递归使用。native/private ID 只在当前 owned live 列表内解析并归一 canonical private ID；stop/steer/wait 传准确调用信号。先等子任务物理/持久 finished delivery，再发原 reported ack，不能把较新 Main 当成旧子权限或重复唤醒。
- 子模型调用必须按同一 live actor 与准确模型路由；父 prompt 结束不回落 Main，子 HTTP 取消不伤 peer。子 browser typeText 明确 unsupported，不能在升级中借主会话 vault 隐式开放；父 typing 原已验收路径仍保留。
- 恢复先严格证明旧 journal/model/blob/shake，显式替换模型时先确认目标 SDK 状态，再保存 Phi。Main lookup 后目标消失须 typed MODEL_UNAVAILABLE、Phi/ref 不变；factory 返回后旧准备控制结束不得阻止下一条明确用户 prompt。
- 物理 transcript 与 SDK provider context 分开核对。默认恢复可去掉 aborted/error assistant 的不安全 replay，但旧 journal entry ID 与完整 canonical 内容仍须保留；对已知 stopped partial 精确投影/比较，不能泛过滤断言来掩盖丢失，也不强迫 SDK 重放死 partial。
- D5 只在用户明确确认后另建新 Phi/new journal，原会话/ref 保留；有界本地时间线摘要只进入可信私有 context，不自动 prompt/tool/job。单 seed 的 newPhi/project/provenance/body hash、16 KiB 边界和回读校验保留；旧来源删除不破坏已接受的新快照，损坏新 seed 必须拒绝。
- Wrapper 冷 origin 是 provenance，不是 live capability；每次复核当前 Phi/project/profile/root/配置，只有可证明的原 controller/job 才恢复查询与监控。未知来源拒绝，不打开远端路径的本机同名文件。
- 分清证据范围：官方 SDK + 本机回环 provider、local shell 远端 fixture、ready marker/命令 fixture 不证明真实 SSH/provider/OAuth/Slurm/Nextflow/conda solve。冷 SDK 子记录仅在旧活动且无终态证明时标 interrupted，已保存 completed/failed/aborted 终态 metadata 保留，全部 `canControl=false/historyAvailable=false`；SDK 500,000 字符字段持久化截断等原边界继续保留。

本轮首全 `b7720a84` 在代码不变的固定副本为 **6441 项：6403 通过、13 失败、0 取消、24 skip、1 todo，1562.75 秒**。原日志不覆写；修正固定源码 `3dc66eab` 的生产类型/build/asar/lint 已通过（70.36 秒、2645 跟踪哈希/HEAD 稳定、共享 binaries 未变）；功能候选 `d9b5d776` 的修后标准全量单独记录为 `6449 项：6424 通过、0 失败、0 取消、24 既有跳过、1 todo`、1542.28 秒，2645 跟踪哈希稳定；不以分组绿色代替，也不扩展为组合全量。Main 测试类型基线仍 **90→90、新增 0**，不宣称全体测试类型零债务。首轮 13 项按 10 项旧 fixture/合同、同一真实名称同步缺口的 2 个失败场景、1 项 Bun 原期限超时分类；另有独审跨父 Main negative 生产缺口修复。原 `-b7720a8` 日志保留，无后缀 standard-full 路径记录修后全量。`3dc66eab` 的 15 文件修正 scope APPROVE、后续 5 文件增量独审与合入 `a70d403b` 分别记录。下一步仍是原 T11 兼容收尾、T16 实机/人工，稳定后 T18。

中间 `3dc66eab` 标准全量另保留为 **6446 项：6419 通过、2 失败、0 取消、24 skip、1 todo，1545.63 秒**，2645 跟踪哈希/HEAD 前后稳定，日志为 `.omx/T14-T15-standard-full-test-3dc66ea.json/.log`。repeat-child/resources 两红同源于同步前台预检键（label 或 toolCallId:index）与 allocator 分配的实际 native ID 不同；升级须复用真实 `TaskTool.execute` ALS 与 registry 的已登记 actual ref/profile、已计数名额，不按 nearest/label 猜。始终追踪真实 FG，receipt 与并行/BG 授权仍独立按原 flag，后台 exact-job 不变。`d9b5d776` 的 5 文件增量 pure 26/26、actual 5/5（129.559 秒）、独立 scope APPROVE；fresh bundle 和全部 360 依赖哈希绑定详见本轮验收。原断言不变，限定通过不代替最终标准全量。

组合版本须另行核对：主线 57 路径已提交 `8b9c545b`，整合为 `03da779eee81a606f887aa8ec154d10be91e1a79`、tree `06ff470204e8e4e419443a76a3469add89c19e77`，2669 跟踪文件、138 功能差异；49 个对方非共享路径及 130 个本功能非共享路径分别与 `8b9c545b`、`d9b5d776` 完全一致。8 个共享路径只在 `jobLabels` 冲突处保留历史只读与 agent `canControl=false` 双守卫。限定轻组 `458/458，0 失败`、绑定 `fb63a68b` 的 actual `22/22（17 个实际 SDK 场景、5 项轻量），0 失败`、生产 gates `238.2` 秒与主工作区后检查分别保存；未重跑组合全库。原 279 项属于对方 `8b9c545b` 提交证据，不是本轮重跑；合并时的 Notebook 36 路径 WIP 完整保留，不夹带重做 UI。

升级时增加 `app-remote-session-routing.test.ts`、`engine-facade-selected-cleanup.test.ts` 与 `engine-facade-child-composition.test.ts` 的相关回归。关闭失败仍须释放本阶段持有的连接，保留原始失败；不能因为清理错误跳过释放，也不能以关闭成功替代原生取消确认。

| 项目                 | 必须观察的结果                                                                                            | 本次状态                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 本地真实 provider    | 一轮对话、read／edit／bash 等工具、中断、旧会话恢复                                                       | 待人工验证；隔离 loopback 契约已通过                          |
| API key／OAuth       | 实际登录、浏览器／device 交换、刷新、注销和重新发送                                                       | 待验证；合成存储与回调通过不等于真实交换通过                  |
| 自动压缩             | 实际触发压缩后继续对话，历史和设置符合预期                                                                | 隔离真实 CLI/应用已通过；外部 provider 与人工 UI 仍待 T16                                |
| MCP                  | 一个真实 HTTPS OAuth 连接器及一个本地 stdio 连接器                                                        | 外部 HTTPS OAuth 待验证；自动化 stdio 生命周期已通过          |
| 子智能体 | 并行/后台四路、status/wait/steer/stop、模型/资源、审批、停止及完成消费/正确 Phi 唤醒 | 本轮隔离 SDK/CLI 与本机服务有定向证据；真实 SSH/provider/PTY 与人工使用仍待 T16 |
| 打包版               | asar 解包、Finder 启动、worker／代理启动、终端与退出                                                      | Finder／真实打包启动待验证；构建／闭包及本机 PTY smoke 已通过 |
| 旧远程路径           | 一轮 read／edit／bash 对话，未启用新 RPC 时行为稳定                                                       | 真实服务器待授权验证                                          |
| 新远程运行时 | 真正下载／运行官方资产，glibc／挂载 noexec／权限检查，SSH 上传中断恢复 | GPU 官方 18.10.3 安装/隔离版本及无 provider RPC foundation 通过；上传中断恢复及完整 R8 未覆盖，cluster deferred |
| R8 node3 与 GPU 单机 | 搜索 → 阅读 → 修改 → 运行；审批批准／拒绝；宿主工具；子智能体；断线重连恢复；记录启动、工具往返与部署耗时 | GPU 目前仅 foundation 通过，完整 R8 尚未通过；node2/node3/yzhang 按用户要求 deferred，不当作 failed/pass |

只有 SDK／二进制 manifest 版本一致、RPC 协议兼容、模型代理与隧道、宿主工具、主／子会话审批、存储恢复及 R8 实机清单均验收后，才讨论远程默认切换。R1 27 项测试或本地 RPC 基础测试不能代替这些门槛。旧远程实现的删除属于稳定一个升级周期后的 R9。

## 7. 审查、保存与安全回退

审查者检查实际差异、官方变更和可复现行为证据，作者负责修复。审查结论应给出具体位置、触发条件、影响及验证方法；不同意见按反例和测试裁决。区分明确缺陷、已接受行为差异、人工验证缺口和原计划延后项。

交付记录至少包含：

- 精确目标、完整闭包／完整性／Bun 核对、重要上游变化及白名单新增路径理由。
- 改动文件、删除或复用的实现、引擎外必要改动、已知 Bash 差异及剩余风险。
- 独立审查结论、冻结提交／差异标识、各检查退出码、全量统计与人工清单状态。
- 以 Lore 格式提交，记录选择原因和未验证边界。先保存可审查分支；合入 main 需要当前任务适用的明确授权。

合入前重新检查 main 的最新提交和未提交改动。保留并行主题、启动等工作；有分歧时在整合分支合并并验证，不能覆盖主分支文件来制造快进条件。合入后再核实依赖版本与运行产物，更新路线图的已验证版本和真实状态。

回退优先保留完整升级分支及日志，然后在干净的独立工作区检出已验证旧提交、按它的锁文件恢复独立依赖并重新构建。不要让旧源码配新 `node_modules`，也不要未经验证让旧引擎写入新版本存储。先备份需保留的历史和配置，再判断旧版本是否可安全恢复。

若升级已合入共享分支，使用经过审查的反向提交撤销本次升级相关改动，保留其他并行提交；不要建议 `reset --hard` 或 `clean`。远程回退使用保留的已验证旧资产，并确保桌面 SDK、manifest 与协议适配成套回退；不可在版本不匹配时继续启用。人工验证发现阻塞时保留旧可用版本，记录问题及恢复条件。

## 8. 本次按流程完成的记录

本手册根据本次升级的实际记录整理，已走过版本冻结、完整性核对、适配、独立审查和本地自动化验收；人工及远程启用步骤仍未完成。

2026-10-14 后续阶段已保存：`044bac9b`（PM-3 RPC 恢复）、`3423a650`（PM-5 后续实际应用接线）和 `2016f286`（旧离线标题测试契约校正，生产代码不变）。实际应用阶段的生产类型、lint、构建和 asar 检查通过。固定 `3423a650` 的标准全量首轮 5864 项有 8 项失败：7 项旧改名预期在校正后两文件独立 59/59 通过，1 项历史容量计时失败同文件独立 19/19 通过。原全量及计时失败日志保留，未重跑全库、未放宽期限；该次失败记录保留；随后将最新 main `acbbb6b8` 整合后的候选另行标准全量 5864 项，5839 通过、0 失败/取消、24 既有跳过、1 todo，879.08 秒，2478 跟踪文件和 tree 未变，已合入 main `631671e6`。主工作区 frozen 依赖同步、生产类型、lint、构建、asar 与真实终端 4 项 smoke 均通过；真实 SSH/provider/OAuth/Finder 及远程默认开启仍待验收。详细结果和版本边界见 [远程验收记录](omp-remote-acceptance.md)。

| 步骤           | 实际结果                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 1 基线    | `6d9d9ef3` 已经用户授权合入 main；此状态与 T8 分支验收分别记录                                                                                        |
| T8 版本／闭包  | 18.1.10 → 精确 18.10.3；18 个 OMP 包一致；官方完整性、独立冻结安装及 Bun 1.3.14 核对通过                                                              |
| 引擎适配／审查 | Auth、Settings、事件、不可用模型、专家环境、stdio 与打包适配完成；独立审查无未解决代码问题；明确保留 Bash 作用域差异                                  |
| 生产检查       | node／web／scripts 类型检查、lint、构建、asar 闭包通过；lint 保留两项未改文件的既有格式警告                                                           |
| 真实进程内契约 | 18／18；真实 stdio 回归 52／52；旧 18.1.10 会话恢复继续通过；本机 PTY 四项通过                                                                        |
| 冻结代码全量   | 4789 项：4764 通过，0 失败，0 取消，24 既有跳过，1 既有 todo；退出码 0，308.84 秒                                                                     |
| 全量代码稳定性 | 运行前后差异 SHA256 均为 `0343b3162bb661377aed2ba780322eea478b8ece4e4f0a04dfd11b173839b363`；此前失败日志保留                                         |
| 分支保存       | T8 `cf2303ce`；用户要求暂留分支；没有由此宣称 T8 已合入 main                                                                                          |
| 后续 R1        | T9 独立审查 APPROVE，提交 `3e8462a8`；T10 候选分支整合提交 `46df9dc8`，在 18.10.3 依赖下复跑部署测试 27／27；真实资产／Linux／SSH／RPC 启用未据此验收 |

T10a 基础 RPC 后续记录：`053c3f88` 双路独立审查通过；协议 26 项、新增会话回归 20 项（19 真实引擎、1 wire metadata）、原丰富契约 18 项通过。完整候选分支 4862 项：4837 通过、0 失败/取消、24 既有跳过、1 todo，296.71 秒；生产 typecheck/lint/build/asar 通过。T10b 后续三路独立 APPROVE；合并核心 159/159 自然退出，生产 typecheck/lint/build/asar 通过，完整串行回归 4930 项、0 失败/取消。实际 CLI 用 `--trusted-extension` 加载默认入口，nonce 身份与守卫确认后才就绪；项目启动命令被私有策略阻断。完整扩展单份打包、逐文件校验、原子部署，预装 `flock` 的内核锁断线释放。审批桥接前仅开放已有普通文本读取，尚不代表完整 PhiEngine、R3–R7 或真实服务器验收。

### 历史应用入口限制（3423a650 当时范围）

以下原文保留旧批次当时的前台能力限制；本轮当前范围以上述 T14/T15 合同为准：

`3423a650` 在实际主进程安装 RPC 路由。启动应用前显式设置 `PHI_REMOTE_OMP_RPC=1` 才选择新远程路径；不设置时本地和旧远程行为不变。`PHI_REMOTE_OMP_AGENTS=Checker,...` 从主进程可信目录选择具名专家，未设置时不启用前台专家；缺失、重复或不支持的完整定义明确报错，不能由 renderer 提交定义替代。只有无环境/skills/警告且工具限于 read/write/bash 的专家进入本阶段。

本地证据归档位于恢复工作区，属于执行记录，不是随仓库交付的产品资源：T8 副本的 `.omx/t8-upgrade-report.md`、`.omx/t8-full-test-awake.log`／`.exit`、`.omx/t8-contract-final.log`、`.omx/t8-mcp-stdio-regression.log`、`.omx/t8-cross-version-history.log`、`.omx/t8-native-terminal-smoke.log`；T9 副本的 `.omx/t9-deployment-report.md` 与缓存修复前后日志。审查或合入时应把必要结论写入可持久追踪的提交／审查说明，不能只依赖本地临时文件。

公开发布物离线补证：18.10.3 Linux x64 资产 276,170,720 字节，完整 SHA256 与清单、官方 API 和官方摘要一致；主 ELF 最高版本需求为 GLIBC_2.17，384 个 GLIBC 未定义动态符号与系统 LLVM 逐项相符。Bun 内嵌原生模块闭包尚未完整证明，未执行该二进制；不能据此认定目标服务器可运行或 R8 已通过。

T10b 最终自动化补证（`e4447c5d`）：全套串行 4930 项，4905 通过、0 失败/取消、24 既有跳过、1 todo，1096.00 秒；23 个冻结源码/测试/打包文件哈希及前后 HEAD 未变。标准并发 4 两轮分别出现 3 项与 2 项不同的既有限时/探测失败，5 个用例按原断言和期限单独复现均通过，相关文件与 main 一致。标准测试脚本、全部断言/期限/跳过条件不变；串行通过不等于标准并发稳定性已解决。日志分别保留 full-first、full-second、两组 reproduction 和 full-serial；真实 SSH/provider/Finder 仍未验收。

## 9. T11/T16 本轮升级合同（2026-10-15）

- History/KV 验收按源码版本记录：初版三实际场景通过，审查新增五项断言后只复验 vendor/KV 1/1，另外两例沿用已证未变的测试体。以 `.omx/T11-history-parity-assertion-freeze.json` 为准，不写成新 runner 三例重跑、外部 vendor KV 命中或持久 KV 导出/导入。冷 CLI 重启与桌面网关重启必须区分。
- 18.10.3 的辅助 opaque 完整性边界仍在；官方 18.11.0 源码核验也未提供相应公共修复，不据此升级依赖或标完整 T11 通过。网关稀疏增量补齐不替代 opaque 全通道无损；不得改真实 model/API、全局 patch 或关闭默认维护来掩盖缺口。
- 终端 failed 状态须在 worker 清理 exit 后保持，正常退出仍为 exited。修复已 main `10f979bc`；三行 guard 的原 15 项纯测试和原压力五阶段通过，68.318 秒、独立 APPROVE、自有两路径与压力所列源码哈希稳定。primary build/types/lint/asar 各退出 0，同期两处其他 UI 变化不允许宣称全树冻结；压力脚本、原期限与所有 PID/进程/内存/延迟断言未改。升级后保留这条终态合同与历史失败证据。
- GPU 在只读预检后已实际安装官方 18.10.3 并隔离 HOME 确认版本（40.824 秒、测试 cleanup=true）；真实无 provider RPC foundation 已通过（64.557 秒、attestation/get_state/stdio close、agentInvocations=0、测试 cleanup=true）。安装/RPC receipt、实际 session 和 bundle 哈希见本轮验收。后续仍须单独证明完整 R8 读写/Bash、Notebook/Wrapper、Phi adoption、外部 provider/OAuth/Finder；foundation 不替代它们，也不证明所有原生模块或科学包完整可用。
- Cursor 子任务最终实际结果：最终生产 bundle `f964cf799034b298411610e7dd6e4aabc20e94ee4520089b086b3bfd8e25af7a` 的实时停止、排队恢复前停止、后台控制 3/3 自然退出通过（18.561/18.701/26.847 秒），29 个组合文件与当时 HEAD `c136ec4a` 前后稳定。排队场景另用只读出队观察包 `af34ad32`，真实 SDK child verified/aborted，原 EOF/partial 日志如实保留、恢复消息未投递、下一明确 Main 无旧恢复请求；实时停止仍要求实际 journal aborted。依据 `.omx/T11-cursor-final3-receipt.json` 及独立最终审查。旧 d670 范围的 text/repeat/tool/parallel 与 later-Main negative 保留其版本绑定，没有把这些结果迁成 f964 全八例重跑。升级须分清执行撤权与已在途模型传输清理：立即封执行及新模型请求，原在途请求按真实 terminal/取消尝试结算清理；停止成功仍收齐原生 ACK/aborted。先 cancel 已知子实例、按精确父 ledger 承接迟到启动，再等派发封闭，原 10 秒不变。公开 `Agent.followUp` 继续进入原 child 队列，纯测试通过不能代替最终实际停止和排队停止。
- node2/node3/yzhang 组按用户要求暂缓（deferred），本轮未覆盖、不作功能失败、不继续连接、不阻塞 GPU；单 GPU 进展不能表述为完整双主机 R8 通过。T12–T15 不重做，RPC 仍默认关闭；真实外部服务/人工 UI/Finder 及稳定后的 T18 沿原门槛执行。

本轮独立打包运行结果：同一整合候选的目录打包及独立打包终端检查均退出 0（54.58 秒）；在仓库外临时应用和隔离 HOME 中验证包内运行时、真实 native 加载、输入回显及 113 列×37 行缩放，资源引用和 2704 个跟踪文件前后稳定。依据 `.omx/T11-T16-package-smoke.json`；未执行 Electron/Finder 交互启动验收。，仅覆盖 standalone packaged worker/native/捆绑 runtime/resize；Electron/Finder 启动及人工 UI 仍须另行实证。

公开 queued 取消升级合同必须重新核验：official cancel 明确 false 后，只有仍 verified/active/owned 的 queued Cursor 可走原 signed control `cancel_queued`，原 11 字段/预算不变。捕获的真实 ref/session/private queue nonce 在每次 await 前后重证，公开 lifecycle release 与 abort 都 settled、原 ref 真实 aborted/session=null 才 ACK；Node 仍须实际 SDK aborted，不能恢复已撤销执行/模型权限。必须验证唯一新增公开子模块的两处精确文件引用，以及 compiled CLI 的同实例 registry、canonical USER_INTERRUPT_LABEL、park CAS/tombstone 和真实 queued stop；新增两项精确文件后 allowlist 总计 47，不扩大为 wildcard。SDK 即使小升级，也不能据 exports 存在就假定这些同实例/代次语义安全。队列 followUp 不等于已执行，停止成功及历史必须符合真实 SDK journal 终态，不能用文本、控制 ACK 或合成消息替代 journal truth。

最终产品 bundle `f964cf799034b298411610e7dd6e4aabc20e94ee4520089b086b3bfd8e25af7a`（66 文件）的 stream stop 18.561 秒、queued stop 18.701 秒有真实通过证据，queued 透明 observer 单独记录；旧 `d670` 四正常及 later-Main negative 等仍按旧范围保留，不记成最终 bundle 全八例重跑。GPU compiled 公共模块探针（诊断 bundle `baac72ac…`，64.366 秒、0 普通模型、cleanup=true）只证明 sameRegistry/release/label，不是最终产品/R8；最终 `f964` foundation：最终生产扩展 `f964cf79` 另在 GPU 完成真实 attestation/get_state/物理关闭与清理，61.202 秒、agentInvocations=0、无用户 Phi adoption。receipt：`.omx/T16-gpu-rpc-smoke.t16-rpc-1ea1d722-9f51-40e3-bceb-2dbfb313563b.json`；29 个冻结文件与当时 HEAD 稳定。该结果仅为无 provider 的最终扩展/RPC 基础验证，完整 R8 仍未覆盖。
