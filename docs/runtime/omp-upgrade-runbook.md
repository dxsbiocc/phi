# OMP 升级操作手册

更新日期：2026-10-14。适用于 Phi 桌面 SDK、原生模块及远程 OMP 运行时的同步升级。

本手册对应 [OMP 计划的 T17／阶段 5](../roadmap/omp-decoupling-upgrade-plan.md)。升级应保持 [internal beta 的本地会话可靠性、审批和可恢复历史](../roadmap/internal-beta-implementation.md)，不附带新 UI、公共分发或无关迁移。远程工作沿用户已确认的独立计划推进，真实服务器连接仍需 R8 授权。

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

`3423a650` 在实际主进程安装 RPC 路由。启动应用前显式设置 `PHI_REMOTE_OMP_RPC=1` 才选择新远程路径；不设置时本地和旧远程行为不变。`PHI_REMOTE_OMP_AGENTS=Checker,...` 从主进程可信目录选择具名专家，未设置时不启用前台专家；缺失、重复或不支持的完整定义明确报错，不能由 renderer 提交定义替代。只有无环境/skills/警告且工具限于 read/write/bash 的专家进入本阶段。

本阶段开放原生主工具和 6 个 Notebook 编写工具（`list/read/insert_cell/update_cell/delete_cell/save`），复用既有 adapter 和远程 Notebook 服务。`notebook.run_cell` 尚无实际 kernel 中断所有权，暂不登记。persona/context/memory/MCP/skills/compaction 等未接入配置仍明确报错，不能静默丢弃或回退本机。已有原生审批界面处理批准、拒绝和停止；恢复沿 Phi 的远程引用读取同一 journal，不隐式重放 prompt。具名专家、停止及恢复经过实际应用安装器/runtime-adapter/CLI 回归，但不是线上 SSH/provider 或默认开放验收。

Notebook 升级回归须观察真实 draft 与磁盘：update 被批准后仅改 draft，save 被批准才落盘；拒绝 save 或待批停止不执行保存，已批准的 draft 保留。异步后端查找中停止或重绑定 SSH 项目必须在 dispatch 前拒绝；已经开始的磁盘 I/O 不承诺回滚。桌面 AbortSignal 只留在服务 context，不进入工具参数、wire 或公共事件。用新代显式恢复同 journal 后，先确认没有隐式请求/工具重放，再显式读取原 Notebook；核对另一项目的 cwd/draft/disk 独立。本次实际应用 5/5、独立关键 3/3、main/adapter 相关定向检查通过，详见 [Notebook 增量验收记录](omp-remote-acceptance.md#t12-notebook-实际应用增量2026-10-14)。

升级时增加 `app-remote-session-routing.test.ts`、`engine-facade-selected-cleanup.test.ts` 与 `engine-facade-child-composition.test.ts` 的相关回归。关闭失败仍须释放本阶段持有的连接，保留原始失败；不能因为清理错误跳过释放，也不能以关闭成功替代原生取消确认。

| 项目                 | 必须观察的结果                                                                                            | 本次状态                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 本地真实 provider    | 一轮对话、read／edit／bash 等工具、中断、旧会话恢复                                                       | 待人工验证；隔离 loopback 契约已通过                          |
| API key／OAuth       | 实际登录、浏览器／device 交换、刷新、注销和重新发送                                                       | 待验证；合成存储与回调通过不等于真实交换通过                  |
| 自动压缩             | 实际触发压缩后继续对话，历史和设置符合预期                                                                | 待验证；设置读写不等于压缩执行                                |
| MCP                  | 一个真实 HTTPS OAuth 连接器及一个本地 stdio 连接器                                                        | 外部 HTTPS OAuth 待验证；自动化 stdio 生命周期已通过          |
| 子智能体             | 并行、后台、steer、显式 async／PTY、审批与停止                                                            | 人工清单待验证；普通专家原生 Bash 契约已通过                  |
| 打包版               | asar 解包、Finder 启动、worker／代理启动、终端与退出                                                      | Finder／真实打包启动待验证；构建／闭包及本机 PTY smoke 已通过 |
| 旧远程路径           | 一轮 read／edit／bash 对话，未启用新 RPC 时行为稳定                                                       | 真实服务器待授权验证                                          |
| 新远程运行时         | 真正下载／运行官方资产，glibc／挂载 noexec／权限检查，SSH 上传中断恢复                                    | 待验证；本地部署夹具不证明 Linux 二进制可运行                 |
| R8 node3 与 GPU 单机 | 搜索 → 阅读 → 修改 → 运行；审批批准／拒绝；宿主工具；子智能体；断线重连恢复；记录启动、工具往返与部署耗时 | T11–T15 就绪且获用户授权后执行，尚未通过                      |

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

本地证据归档位于恢复工作区，属于执行记录，不是随仓库交付的产品资源：T8 副本的 `.omx/t8-upgrade-report.md`、`.omx/t8-full-test-awake.log`／`.exit`、`.omx/t8-contract-final.log`、`.omx/t8-mcp-stdio-regression.log`、`.omx/t8-cross-version-history.log`、`.omx/t8-native-terminal-smoke.log`；T9 副本的 `.omx/t9-deployment-report.md` 与缓存修复前后日志。审查或合入时应把必要结论写入可持久追踪的提交／审查说明，不能只依赖本地临时文件。

公开发布物离线补证：18.10.3 Linux x64 资产 276,170,720 字节，完整 SHA256 与清单、官方 API 和官方摘要一致；主 ELF 最高版本需求为 GLIBC_2.17，384 个 GLIBC 未定义动态符号与系统 LLVM 逐项相符。Bun 内嵌原生模块闭包尚未完整证明，未执行该二进制；不能据此认定目标服务器可运行或 R8 已通过。

T10b 最终自动化补证（`e4447c5d`）：全套串行 4930 项，4905 通过、0 失败/取消、24 既有跳过、1 todo，1096.00 秒；23 个冻结源码/测试/打包文件哈希及前后 HEAD 未变。标准并发 4 两轮分别出现 3 项与 2 项不同的既有限时/探测失败，5 个用例按原断言和期限单独复现均通过，相关文件与 main 一致。标准测试脚本、全部断言/期限/跳过条件不变；串行通过不等于标准并发稳定性已解决。日志分别保留 full-first、full-second、两组 reproduction 和 full-serial；真实 SSH/provider/Finder 仍未验收。
