# OMP 远程运行时验收记录

## 当前远程 RPC 候选（2026-10-23）

最终源码候选 `7336b393` 的完整测试 **7772 项，7746 通过、0 失败、25 跳过、1 todo**；
主代码类型检查、构建与结构检查通过。接管提示修复前的 RPC 基线 `98a8508d` 在 node3
和 GPU 的 R8 三场景均通过；后续提交仅改渲染器、测试与验收文档，未改变 RPC 运行路径。
两台主机各自 3/3 反向隧道关闭，RPC、SSH 子进程与本次自有远端目录清理确认。回执：

- node3：`.phi-acceptance/receipts/2026-10-23T07-18-07-411Z-yzhang-node3-r8-5c3890e1-a56c-442c-a7fc-1dc35af30367.json`
- GPU：`.phi-acceptance/receipts/2026-10-23T07-21-01-732Z-GPU-r8-3b05dfe6-d9ab-4985-ae65-a40d828fa48e.json`

同步后的源码版 Phi 在 node3 用真实 DeepSeek V4.1 Flash 重新调用 `read validation.txt`，
run `0e9c4ab2-6349-48ef-802c-ab6acc6026b3` 得到 `ok\n`、`isError=false`；重启后
`smoke.ipynb` 的代码及 `node3 notebook ok` 输出仍可读，并在 16:04:39 再次执行、
16:04:53 自动保存，随后关闭 Jupyter server。首次复验曾因模型附带可选 `i`
字段被 bootstrap 守卫拒绝，修复后 RPC bootstrap 安全套件 13/13 通过。

同一源码版 Phi 的一次性 node3 会话 `8d5d3b52-...` 在删除前断开两条新 SSH master，
界面警告且本地/远端历史保留；在线重试后只删除该会话，原有两条会话保留。回执：
`.phi-acceptance/receipts/2026-10-23-node3-offline-delete-8d5d3b52.json`。

node3 保留会话 `50758880-...` 的真实 OMP 18.10.3 存活接管已在源码版 Phi 验证：
旧 PID 46070 持原 run 锁，恢复后退出，新 PID 74269 持锁；时间线提示持久化且界面
切换后仍显示一次。修复了无前台 run 时已持久化提示被聊天缓存跳过的问题。回执：
`.phi-acceptance/receipts/2026-10-23-node3-real-omp-survivor-50758880.json`。
持锁旧进程使用隔离测试 journal，未验证运行中的长 Bash 同时保持存活。

完整回归首轮因恢复测试夹具未注入新增回调依赖而有 1 项失败；修正后该组 11/11 通过。
第二轮并发下 Notebook Markdown 编辑器工具栏测试在 UI 提交前断言而失败；按动画帧有界
等待后，真实 Electron 测试连续 3 次通过，并在最终全量中通过。两次首红均保留在
`.phi-acceptance/receipts/2026-10-23-remote-rpc-candidate-7336b393.json` 的记录中。

全局默认开关仍未切换：[验证清单](remote-default-on-validation.md)保留
无缓存目标桌面预置与静态警告预算。`npm run lint` 为 0 错误、1451 警告，
超过 1396 阈值；测试类型检查 479 错误，未修改主分支基线为 480。

## main 同步前最终检查（2026-10-19）

当前代码在正常唤醒条件下完成标准全量，`attempt-3`：**7296 项，7270 通过、0 失败、
0 取消、25 跳过、1 todo**，退出码 0，约 19 分钟。没有跳过新增用例或放宽原有超时/并发设置。
通过 `caffeinate -dimsu` 在交流电下维持检查期间的显示/系统唤醒；墙钟 1142.112 秒、
单调计时 1142.100 秒，未再出现维护睡眠引起的计时跳变。

- 2772 个已冻结源码/配置文件前后哈希一致；没有隔离 guard 报告，真实 Phi 日志未变化。
- 生产类型、完整 lint、构建通过；Go helper 单元测试和 `go vet` 通过。
- macOS arm64 验收包的内置 micromamba/OMP worker，以及 SIGTERM/正常退出检查通过。
- 设计草稿与研究依据已审查并分开提交；明确保留未实施/内测后范围。研究执行参数中的个人路径
  使用有说明的占位符，科学参数、版本、结果和哈希保持不变；JSON、相对链接与格式检查通过。
- 清理前已保存旧工作区的补丁、未提交文件、验收回执和会话证据，并逐文件校验备份。
  清理限定于旧生成包、干净且已合入的校验副本与旧工作区，含独有实验的副本继续保留。

最终自动化回执：`.phi-acceptance/receipts/claude-resume-20261018/attempt-3/`；
其他检查见同目录上级的 `checks.json`、`final-helper-check.json`；
清理范围、备份和同步结果见 `.phi-acceptance/cleanup-20261019/`。
真实模型/SSH/Notebook 的当前候选人工验收、终端输入法等清单仍保留，RPC 默认开关没有改变。

## 当前候选解封预检（2026-10-21）

- GPU R8：`baae03c8` 上三场景通过（27.3s；prepare 10.8s / 21 条命令；回执
  `.phi-acceptance/receipts/2026-10-21T09-17-16-926Z-GPU-r8-a78cf840-0cea-4948-8fd6-9e43ebf40441.json`）。
  这次同时修复了 R8 私有 ssh-config 写到 `<run>/ssh-config`、导致 `getRemoteHostProfile`
  发现不到 `ssh-config:` 档案的问题；修复前所有实机 R8 都会报“SSH 服务器档案不存在”。
- 该预检不等于解封门槛：真实模型对话、当前代码 Notebook/Wrapper、人工界面与 SSH-01/04
  第 2–4 项仍按 [验证清单](remote-default-on-validation.md) 执行。
- 2026-10-21 人工验证进展：GPU 上用 `cursor / cursor-grok-4.6-fast` 完成一次真实模型远程对话
  （会话 `63201ad3-...`，run `c43070a9-...`，10 次远程工具调用）；随后在同一远程项目执行
  `quicksort.ipynb` 并保存，输出 `all cases passed`；项目切到 `ask` 后 bash/write/bash
  三次审批成对通过，远端 `.phi-validation.txt` 权限 600、内容 `ok`。断线恢复与
  SSH-01/04 #3/#4 仍待做。

## Claude 记录接续与 Beta 收尾（2026-10-18–19）

本轮导入 Claude 会话 `73c5aed9-09d9-438b-ac7a-70a6d077129b` 的最后记录，
从 main `b99705f4` 接续。已快进合入 `7c051a3d` 的连接器提示持久化，保留其他未提交设计文档。
本轮修复分别保存为 `7469985b`（提示省略数量）与 `43f714af`（MCP 调用 ID 与真实形态回归），仅本地提交。

- 修复提示去重遗漏：显示列表上限为 20 个，省略数量现在参与当前及历史提示的比较；
  20→21→22 个连接器及重启后去重的回归先失败、修复后通过，相关测试 8/8。
- 修复桌面 MCP 适配层仍用应用内部 ID 规则校验模型工具调用 ID 的遗漏；
  与 worker 共用 `rpcToolCallId`，保留非空、1024 字符上限及 Unicode 校验，应用身份校验不变。
- 完成旧分支未提交的真实形态回归：`ssh-config:` 身份、中文/空格路径、带换行且较长的调用 ID、
  超过 128 KiB / 深度 40 的 41 工具 MCP 目录、Bash heredoc 的 `//`、Notebook 文件读写、
  `xd://` 连接器调用、直接 Notebook 调用和项目会话列表。重型输入由显式选项启用。
  新回归 2/2；既有同名技能、后台消息历史与 SSH-config 定位回归 4/4。
- R8 应用脚本改为使用匹配的私有 SSH config 与 `ssh-config:` profile ID。
  本轮没有连接真实 SSH 主机；该脚本改动尚待实机复验。
- 旧全量两次在约 626 / 671 秒结束，0 断言失败、约 659 项取消。
  Node 24 的 `test:interrupted` 来源是 SIGINT/SIGTERM 的终止处理器；
  旧记录没有提供信号发送方，不能将中断直接归因于 `6804ed8e` 的测试隔离。
  本轮原中断位置的恢复/MCP 组合 24/24 通过，标准全量也通过了这六种 Cursor 恢复场景。

生产类型检查、lint、构建和两轮独立差异审查已通过。还生成了 macOS arm64 未签名验收包：
包内 micromamba 2.9.0 与 OMP worker 启动/响应通过；隔离用户目录下的 SIGTERM 和正常退出各 203 ms。
包位于 `.phi-acceptance/package-claude-resume/mac-arm64/Phi.app`。

**前两次全量未通过（历史记录，不作为绿色验收证据）：**

- `attempt-1` 跑到末尾：7296 项，7267 通过、2 失败、1 取消、25 跳过、1 todo。
  没有整体 `Interrupted`、隔离 guard 报告或真实日志变化，2772 个源码文件前后哈希一致。
  失败/取消集中于两个 Wrapper 文件。墙钟 2111.266 秒、单调计时 1186.213 秒；
  系统日志确认 23:31:03 开始的维护睡眠长 927 秒。两个文件保持原样定向复验 39/39，通过、无取消。
- `attempt-2` 在同一源码上使用 `caffeinate -i`；已确认防空闲休眠断言生效。
  系统仍于 23:54:41 记录 `Dark Wake Thermal Emergency`，23:55:53 进入另一轮 927 秒维护睡眠，
  一个原本正常的集成用例因此出现约 965 秒耗时/超时。主代理主动终止了这次已受影响的运行；
  最终汇总为 1326 通过、751 取消，不作为验收通过。主动停止原因和首个超时日志均保留。
  源码哈希仍一致，真实日志仍未变化。此轮的 `Interrupted` 来自主代理的显式停止。

第三轮在正常唤醒条件下完整通过，见本文顶部；没有放宽测试超时、跳过失败用例或回退测试数据隔离。
早期 Claude 两次整体中断的信号发送方仍未确认，不能与本轮维护睡眠混为同一原因。
本地回执：`.phi-acceptance/receipts/claude-resume-20261018/`，两次原始结果分别位于 `attempt-1/`、
`attempt-2/`；其他检查见 `checks.json`。

### 接续后的收尾顺序

| 顺序 | 工作 | 完成证据 |
|---|---|---|
| 1 | 固定候选标准全量、静态和构建检查（已通过） | attempt-3 零失败、零取消、源码哈希稳定；真实日志无测试污染 |
| 2 | 当前候选的一次真实模型远程对话与 Notebook/Wrapper 闭环 | 记录模型通道、构建/提交、审批、执行/保存/恢复结果；不含凭据，T11 辅助模型通道的既有限制单独保留 |
| 3 | 人工远程界面与 SSH-01/04 检查 | 当前默认切换门槛中的未勾选项及上锁、旧进程回收、占用拒绝均有回执 |
| 4 | 本地终端与交付包人工检查 | 中文 IME、草稿/解释、复制粘贴、拖动尺寸及 Finder 启动，沿已有清单记录 |
| 5 | 默认切换与稳定周期 | 上述门槛满足后再讨论默认开启；稳定一个升级周期后执行 T18 |

第 2–3 项的逐步操作、检查表与回执模板见 [远程默认开启验证清单](remote-default-on-validation.md)。

Claude 最后记录描述了一次真实 Grok/Cursor 对话及远程 Jupyter 执行两个单元格成功；
这发生在后续工具常驻等修改之前，且未绑定本轮候选，因此仍保留当前候选的实机门槛。
终端清单见 [terminal-v1-manual-checklist.md](../design/terminal-v1-manual-checklist.md)。
能力自主扩展与大范围整洁度改造不进入本轮收尾。

## 当前状态（2026-10-18，分支 `fix/t16-local` @ `81807221`）

每个 R 项一行。下方旧记录原样保留，作为历史证据；以本表为准。实机验收用 `node --import ./scripts/test-loader.mjs scripts/remote-r8.ts --host <别名> --execute`（见 [remote-r8.md](remote-r8.md)），回执在 `.phi-acceptance/receipts/`。

| 项 | 状态 | 证据 / 说明 |
|---|---|---|
| R1 分发与部署 | GPU 通过 | 启动事务发现缺失项才安装；安装时完整校验并写就绪标记。GPU 首次修复 21–132 s。node3 新路径通过（234 s） |
| R2 启动与连接 | GPU 通过 | 已安装主机正常启动 4 条远程命令（含 OMP 通道）、约 12 s（`a7d0008c`）；改前 537–615 条 |
| R3 模型代理与隧道 | GPU 通过（合成模型） | 真实模型账号未测 |
| R4 宿主工具 | 部分 | Notebook 在旧版本 GPU 上通过（db18）；当前代码未在实机重测 Notebook/Wrapper |
| R5 主会话审批 | GPU 通过 | R8 场景 ①：编辑、命令各一次批准，持久记录一次 |
| R6 子智能体 | GPU 通过 | R8 场景 ②：只读子任务完成并验证；派发时核对 OMP 实际解析的定义 |
| R7 会话存储与恢复 | GPU 通过 | R8 场景 ③：杀 SSH 主连接 → 旧会话失败且不重放 → 显式恢复同一会话记录 |
| R8 实机验证 | GPU、node3 均通过 | GPU 三场景通过（回执 `2026-10-17T15-31-59-020Z-GPU-…`）。node3 三场景通过（`29e57d61`，389 s；准备 234 s/26 条命令，新建启动 43 s、恢复启动 36 s，各 4 条命令；回执 `2026-10-18T06-50-48-708Z-yzhang-node3-r8-1fe3fe74-…`） |
| R9 清理旧实现 | 未开始 | 默认切换并稳定一个升级周期后再做 |

SSH-01/SSH-04 实机检查(2026-10-18 新增)。2026-10-18 node3 结果:第 1 项通过(pid = pgid);第 5 项部分通过(启动走同一条 master,每次 4 条命令;取消/超时未专门测);第 2–4 项需在运行中的会话里操作,并入人工界面检查:

1. 服务器有 `flock`、`ps`、`/proc`;无 pty 时 sshd 让登录 shell 成为进程组长(否则启动报 `PHI_LAUNCH:NOT_GROUP_LEADER`)。
2. 持久会话启动后 `run.record` 权限 600、pid = pgid、`ps -o pgid,args` 的 argv0 为部署的 OMP;OMP 存活时 `flock -n run.lock` 失败。
3. 长 bash 运行中只断 SSH:OMP 仍存活;恢复后旧进程组收到 TERM(10s 后 KILL)、新 OMP 启动、时间线出现"已停止上一次未结束的远端运行"、journal 只有一个写者。
4. 篡改 `run.record` 的 pgid 或让无关进程持锁:不杀进程,报"该会话仍被另一个进程占用"。
5. 远程项目前台命令、取消与超时在真实 sshd 上行为正确;`ssh -O check` 能识别已断的 master;打开项目到首个命令只建立 1 条 master。

已知问题：本地加载 agent 列表约 2.9 s；OMP 发布包下载不支持断点续传（慢网络中断后需从头下载 276 MB）。OMP 下载已改走系统代理（`desktopFetch`）。


最新原 T16 限定状态（2026-10-16）：三项已审修复已本地 fast-forward 合入 main `db18ec7c`，保留其他工作、未推送；该固定候选 GPU Notebook 原强场景 3/3 与生产 gates 已绿。原 child-enabled R8、node3 extension、services 环境拒绝结果和标准全量仍有下述缺口。T16 仍 partial，原任务编号与默认开关不变。

上一批原 T16 限定增量（2026-10-16）：真实 App routing/runtime-adapter/SessionRunner → SSH → 官方 OMP 18.10.3 的 GPU 受控闭环 4/4 通过，覆盖读写/Bash、审批拒绝与待批停止、同 journal 新代显式恢复。模型仅为合成 loopback provider，不代表完整 R8 或真实厂商验收。源码 `e62d22cc` 补齐 App 工作区未探测平台而导致资产选择失败的接点；相关 19/19（包含 workspace 6 项）及独立审查通过，固定候选生产类型/构建/lint/asar 均退出 0（70.73 秒），2704 个跟踪文件、HEAD、tree 与共享资源引用前后稳定。

更新：2026-10-16。此记录区分已验收的基础代码、集成验证与尚未完成的产品能力。

阶段 1 原已合入 main `6d9d9ef3`；T8 及后续成果曾按用户要求暂留分支。用户于 2026-10-14 另行要求开始合并，已将验收过的阶段成果及 main 最新聊天布局整合为本地 main `631671e6`。OMP 为 18.10.3，远程 RPC 及前台专家默认仍关闭；没有推送、发布、连接真实服务器或读取真实提供商凭据。

原 T12 全部宿主工具现已合入本地 main `fb0d054`；独立审查、最终全量及合并后的主工作区检查通过，最新 UI 保留。首轮失败及附加终端压力检查的既有限制均保留在下文，未推送或改变默认开关。

原 T13 模型与思考级别实际应用增量已合入本地 main `365b2db`（包括初次合并 `43718e2` 与默认策略修正）；相关组 369/369、实际 CLI/应用与独立审查、生产类型/lint/build/asar 通过。压缩控制随后已合入 `eea33bd3`，见下文独立增量；T13 整体随后已由 `9f723379` 完成，见下文完整交付；没有重做 T12、推送或默认启用 RPC。

本轮原 T14/T15 的实现与限定验证已补齐，当前整合提交 `03da779e`、合入 `a70d403b`，功能候选 `d9b5d776` 的零失败标准全量与组合限定检查分别见下文；首轮 `b7720a84` 的 13 项失败完整保留。RPC/专家仍是 main-owned 显式 opt-in，真实环境与默认开放保留 T16 门槛。

上一批限定进展（2026-10-15）：T11 history 三个实际场景已通过，新增五项断言后仅 vendor/KV 一例复验；完整 T11 因辅助 opaque 上游接缝仍未关闭。T16 终端修复已 main `10f979bc`，原 15 项纯测试、原压力五阶段及 primary build/types/lint/asar 通过；GPU 官方 18.10.3 安装/隔离版本和原 `d670` bundle 的无 provider RPC foundation 已通过；最终 `f964` foundation 另记。Cursor 子任务恢复与取消已完成本轮限定验收：最终 f964 包的实时停止、排队恢复前停止和后台控制 3/3 通过；旧 d670 四类恢复及 later-Main negative 证据按原版保留。node2/node3/yzhang 组按用户要求暂缓（deferred），本轮未覆盖，不记功能失败。

源码 `19da6594` 已合入 `db09181f`。该整合候选的生产类型、构建、lint、asar 均退出 0（68.75 秒）；2704 个跟踪文件、HEAD、tree 及共享资源引用前后稳定。未重跑该整合候选的全库测试。以上结果只绑定本轮范围；不宣称当前全库或完整双主机 R8 通过，RPC 默认关闭。旧验收原样保留，最新证据与限制见文末。

## 已保存的基础成果

下列测试数来自独立审查员对冻结代码的限定测试；范围有交集，不相加作为全套测试数。每次审查均核对实际源码、锁定版本的 SDK 合同及运行前后文件哈希。

| 范围                              | 提交                        | 独立限定验证                               | 验收边界                                                                 |
| --------------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| T8 升级                           | `cf2303ce`                  | 全套 4789 项，0 失败/取消                  | 18.10.3 自动化通过；人工 OAuth、压缩及 Finder 清单待验证                 |
| T9 官方运行时部署                 | `3e8462a8`                  | 27 项与 9 项缓存回归                       | 官方资产、缓存、私有部署与断线锁；尚无真实 Linux/SSH 执行                |
| T10a RPC 协议与窄 session backend | `053c3f88`                  | 全套 4862 项，0 失败/取消                  | 真实 CLI 基础契约；没有伪造完整 PhiEngine                                |
| T10b 扩展启动                     | `e4447c5d`，记录 `0e52a8d2` | 核心 159 项；串行全套 4930 项，0 失败/取消 | 标准并行回归曾出现不同的既有探测超时，限制保留                           |
| T11 nullable model selection      | `e9a1b77e`                  | 26 项                                      | 私有安全模型元数据与公开模型选择命令，保留未知 limits                    |
| T11 网关、隧道与生命周期          | `eaabd7b9`                  | 网关 28、隧道 44、生命周期 99 项           | 基础 APPROVE；提供商矩阵与完整 R3 分开验收                               |
| T12 宿主桥与控制帧                | `16e9a23f`                  | 64 项                                      | 主运行权限、schema、取消、实际小结果 CLI；实际服务与大结果未包含         |
| RPC 错误分类                      | `18e13c4b`                  | 75 项                                      | 精确字节上限及官方响应 code；未放宽协议预算                              |
| T15 Phi 清单与离线历史            | `ee2cb6e7`                  | 76 项                                      | 严格 remote locator、原子 adoption、离线访问；远端路径不作为桌面文件权限 |
| T15 服务端持久存储                | `5e5fc292`                  | 32 项                                      | 私有路径、连接持有的 writer lease、真实 SDK title/header、串行发布       |
| T15 显式恢复与历史分页            | `8801a1ca`                  | 46 项                                      | 实际 CLI 跨进程恢复与图片 blob；生产严格 verifier/路由尚待接入           |
| T13 主审批桥                      | `c237d2b6`                  | 38 项                                      | 实际 native write/edit/bash 批准、拒绝、取消；产品入口尚未开放           |
| T15 持久化启动                    | `adcf60f0`                  | 70 项                                      | 私有临时 HOME、持久 journal/data 与实际进程权限检查                      |
| T14 原生智能体定义编译            | `106a7428`                  | 18 项                                      | 实际 SDK 发现、模型和工具声明；尚不授予子会话执行权限                    |
| SDK 模块边界合同                  | `3777d60f`                  | 18 项                                      | 区分实际运行时模块与已擦除类型引用，独立扫描器同步验证                   |
| T12 完整最终结果                  | `250be9f4`                  | 66 项                                      | 私有 receipt、图片与大结果 hydration；失败结果不泄漏内部凭证             |
| T11 原生 stream 兼容适配          | `bbdd9ff0`                  | 29 项，另含 46 个内部场景                  | 修复已复现 opaque/sparse 丢失；side/advisor 通道未纳入                   |
| T13 运行权限                      | `86c771fe`                  | 32 项                                      | 主运行身份、签名来源与取消终态；完整子运行权限另行实现                   |
| T15 严格保存状态验证              | `86555985`                  | 48 项                                      | 真实 SDK、全分支与已知资产验证、显式 adoption 后提交基线                 |
| T14 真实子任务接缝探针            | `a9b3fb2f`                  | 16 项                                      | 注册、激活、停止与后台合同；不授予生产子会话权限                         |
| T11 完整工具请求 DTO              | `77ecfd10`                  | 35 项及 18 项闭包检查                      | 保留 24 工具、800 schema 字段和本地推测执行，不放宽网关预算              |
| T12 真实桌面服务                  | `5b3d4c16`                  | 114 项                                     | 共享注册表与实际服务；完整资源、library 和产品入口另行验收               |
| T15 默认 shake 资产补充           | `49ad5591`                  | 58 项                                      | 真实默认机器标记、归档 region 与恢复基线，保留首次验证前的历史限制       |
| 精确子运输宿主模块                | `36a3310a`                  | 18 项；官方 macOS 单文件正例 1 项          | 精确静态模块与真实根 router；不代表完整子权限或 Linux 实机验收           |
| 生产主会话组合                    | `72e9eedd`                  | 原组合 14 项及修复后故障 2 项独立验证      | 主审批、真实结果、持久检查点及 adopter 边界；完整应用路由另行接入        |
| 远程 Library 六动作 | `d94f10cd` | 149 项，32.554 秒自然退出 | 实际选定 workspace、并发 CAS、恢复与审批；不代表完整 R4 |
| Worker 运行时闭包 | `35ac4c49` | 独立 12 项及实际 Bun 编译语义核对 | 正确擦除类型边，保留原单入口；搜索 worker 另行验收 |
| 真实应用路由增量 | `8ffb187d` | 独立 27 项；隔离组合 30 项 | 真实 proxy、Phi adopter 与公共事件；默认旧入口、剩余控制方法未完成 |
| 原生子权限基础与关联主审批 | `2837875b` | 独立 81 项；server 17 项及 bundle 18 项 | 29 文件、实际取消确认与写入提交；真实 task 入口另行接线 |
| 上下文与名称控制 | `356b3583` | 独立 19 项，151.182 秒自然退出 | 真实 Phi-only 名称入口、SDK/Phi 恢复一致；冷改名及其他控制未纳入 |
| 桌面原生搜索基础 | `a29e0ce2` | 前版独立 76 项；最终隐私增量独立 40 项，89.461 秒自然退出 | 实时完整结果、标准错误脱敏；命令型配置与旧发现缓存拒绝，冷恢复沿用 SDK 截断 |
| macOS 会话目录身份 | `edd9d988` | 最终独立副本 12 项，25.916 秒自然退出；构建及 lint 通过 | 精确 SDK alias、同远端主机目录身份与原字节证明；不代表真实 SSH/Linux |
| Task 准入与控制底座 | `39678516` | Node、server、主否决及启动策略分别独立复审；组合构建/lint 通过 | 28 文件及 SDK 边界；应用组合另审，完整启动门及默认开放未验收 |
| 真实前台 task 应用组合 | `f148a977` | 停止修复版本独立 4 项真实场景、17 项新单测及 4 项关联回归；最终单文件修正另验 1 项真实停止 | 24 文件；最终隔离构建/lint 通过；完整启动门、能力默认开放及实机验收未通过 |
| 主分支同步与本地 Cursor 恢复兼容（PM-1） | `4ea5002f` | 审查者复跑 Cursor 恢复与真实 worker 契约 49 项通过 | main 同步进入迁移分支；不代表远程 RPC 已加载或验证恢复扩展 |
| 启动工具发现限制（PM-4） | `514e32ad` | 审查者复跑 factory/native admission 25 项通过；生产类型与 lint 通过 | 五个 capability provider 禁用、项目插件工具启动前预检；保留同 UID 检查后替换竞态，未做真实 SSH |
| Cursor RPC 断流恢复（T11 / PM-3） | `044bac9b` | 专项 23 项、既有引擎契约 20 项通过；独立真实 RPC 5 项及隐私 2 项通过；定向类型/lint 通过 | 精确错误分类、单次续答、完整结果/工具不重放与主动停止；未覆盖 Cursor 子任务或真实 SSH/provider |
| 实际应用接线（T13/T14/T15，PM-5 后续） | `3423a650` | 相关 257 项；实际应用/CLI 4 项和权限审批 7 项独立通过；清理修复另经独立 1 项复验；生产类型/构建/asar/lint 通过 | 主进程显式 opt-in、可信具名专家、原生审批及同 journal 显式恢复；默认关闭，资源和后台等限制见下文 |

审查中发现并闭环的问题包括：网关取消导致 worker 未处理拒绝、流背压误判、私有配置发布队列越序、模型选择清理覆盖原始错误、授权输入 TOCTOU、重复 Ajv schema ID、SDK title slot 误解析、远端清单并发改绑、损坏 remote ref 触发桌面文件操作，以及审批终态重入、容量耗尽悬挂、跨运行 tool-call ID 误去重。相关原码失败断言和修复后的独立验证均保留。

子会话运输另补精确静态宿主模块 `@oh-my-pi/pi-coding-agent/internal-urls`，部署扫描器和独立 AST 合同均拒绝邻接路径、别名、后缀及动态加载。独立 18 项验证通过。官方 18.10.3 macOS arm64 单文件发布物已按 GitHub digest 和官方 SHA256SUMS 校验：217142304 字节，SHA-256 `985c70cbcd264f6c6313de45ee81df6734664ec8ed8e72fa39fc644df625f0ce`。实际发布物在 `/private/tmp` 的独立扩展副本中完成 1 项真实原生子任务、同一根 RPC router 与原生写入验证，2.434 秒自然退出；所有 SDK importer 的祖先均无 `node_modules`，没有使用 npm CLI 替代发布物。前两次仍可见仓库祖先依赖的初步结果已排除。该证据仅证明此模块与子任务接缝，不代表 Linux、完整子权限或 R8 通过。

## T12 Notebook 实际应用增量（2026-10-14）

基于已合入 main 的 `eaf33f7e` 继续原 T12，仅改 5 个生产文件和 7 个测试/fixture 文件。复用既有 `NOTEBOOK_TOOL_NAMES`、desktop adapter、HostServiceRegistry、NotebookToolHostRouter、RemoteAnalysisNotebookBackend 和 AnalysisNotebookToolExecutor，实际 RPC 应用入口登记 6 个 Notebook 编写工具：`list/read/insert_cell/update_cell/delete_cell/save`。审批及持久 writer 沿原实现，未新增 schema、后端、依赖或开关，RPC 默认仍关闭。

原失败回归证明：等待异步后端查找时取消，旧 router 仍会进入 dispatch。修复在桌面宿主 context 中传递私有 AbortSignal，在查找后复核取消、原始 runtime/Phi 会话及当前 SSH 绑定；信号不进入工具参数、wire 或公开事件。旧 worker 提供 origin 而没有 signal 的请求保持兼容，远程失败不回落到本机。

执行者最终冻结验证：实际应用安装器＋runtime-adapter＋真实官方 CLI 的 5/5 场景自然退出，91.38 秒；main Notebook 32/32；selector/router/executor 18/18；既有 desktop 接点 13/13。真实场景使用隔离的 SshHost workspace 与实际 Notebook backend/executor，核对 draft 和磁盘：批准 update 后仅改 draft，批准 save 后落盘；拒绝 save、待批停止及 lookup 中停止/重绑定不执行目标保存；另一项目的 cwd/draft/disk 独立。同 journal 新代恢复无隐式模型请求或工具重放，随后显式 read 进入同一后端。独立差异审查 APPROVE：真实应用关键 3/3（52.49 秒，编写保存/恢复、lookup 停止、重绑定）；main 入口、旧 worker 兼容和 router/roster 5/5（1.48 秒），12 文件 lint、定向类型通过，无确认缺陷。上述范围有交集，不相加作为全库数量。

生产 node/web/scripts 类型、构建、asar、完整 lint 通过，保留两条未改文件的既有格式警告。新 helper 与定向测试类型诊断为零；含旧 main VM harness 的定向类型对照为基线 90、当前 90、新增 0，不宣称全体测试类型无债。构建时仅临时复制 clone 的 runtime 符号链接，结束后恢复；共享目标哈希未变。按当前规划的小批节奏未重复 5864 项全库，之前 main 全量证据仍只对应其固定 tree。

范围边界：本批只开放 Notebook 编写。`run_cell` 现有链路尚未拥有实际 kernel 中断，因此不登记；取消保证覆盖待审批及异步查找到 dispatch 前，已经开始的磁盘 I/O 不承诺回滚，已批准的 draft 修改不因后续 save 被拒绝而撤销。真实 SSH/provider/OAuth/Finder 未执行，T12 其他工具族及完整 R4 继续实施。既有万行 main 入口本轮只改原服务注册接缝，作为已有架构债保留；新 Notebook 场景放入独立 412 行 helper，未机械拆分旧 fixture。

## T12 Wrapper 与交付物实际应用增量（2026-10-14）

在 Notebook 增量 `719dada3` 上继续原 T12。复用 Wrapper 的 6 个 builder、host client/handler、JobManager、持久 job origin、remote job Control 与既有远端 presenter，实际 RPC 应用名单增加 `wrapper_search/inspect/run/status/wait/cancel` 和 `present_files`。未新增后端、registry、schema、依赖或开关，Notebook 原 6 个编写工具保留，RPC 默认仍关闭。

可信 main context 决定 origin；远程 job 的 origin 经现有应用生命周期内的 resolver 关联到稳定 Phi 会话，再匹配 project、host/profile/root。状态/等待/取消先验归属再进入 manager，避免外会话读取污染完成回报状态；列表在归属过滤后应用 limit，不被 peer 的较新记录遮蔽。无法证明旧 origin 的 job 不接管，跨应用重启的完整冷恢复仍属 T15。既有本地 worker/UI 路径维持原范围。

启动分界明确：target/环境异步检查后，最后同步复核取消与当前绑定，再持久创建并接受后台 job；成功返回后，聊天停止、空闲或关闭该代不会取消已接受的后台 job。随后物理准备/launch 只受原 job Control 和已选 target 控制。停止 `wrapper_wait` 只结束等待；明确 `wrapper_cancel` 走既有审批与取消确认。原红证明 manager 会在异步检查取消/改绑后接受 job（2 项），直接 login 和 sbatch 写脚本后也有迟到执行/取消态缺口（2 项）；补现有准入和最终执行前守卫后均通过，未重写 controller 或 SSH 协议。

交付物沿原远端路径验证，校验 runtime/tool-call/context，并在异步检查后、发布前再次验证 signal、原 run 与项目绑定。远端结果保留 host/project/path 及 URI，不授予本机同名文件读取权限。首条真实应用安装器→runtime-adapter→官方 CLI→真实 JobManager 流程通过，30.69 秒自然退出：查找/检查、远端启动、状态/等待、实际远端路径验证与展示；新代显式恢复同 journal 后查同一 job/产物，无隐式重复启动。SSH 传输与 tiny Nextflow 使用隔离的本机 fixture，不代表真实服务器或 Nextflow/Slurm 实机验收。

最终冻结为 9 个生产文件和 12 个测试/fixture 文件。执行者实际应用场景按独立日志全部通过：首流程 1/1（30.69 秒）、拒绝/待批停止/准入停止/改绑 4/4（63.72 秒）、已接受作业与 peer/停止等待/明确取消 1/1（34.70 秒）、恢复后的完成继续 1/1（25.52 秒）；均自然退出。最后 peer 场景严格核对 2 个 job/2 次实际 launch、主/peer PID 持续、停止等待不取消、仅明确取消本会话 job；之前的 HTTP 计数红日志保留，原计数跨越 native abort 在途请求而超出承诺，最终测试验证真实作业副作用，未容忍额外 job 或放宽时限。main/selector 6/6（1.75 秒）、改动相关组 108/108（89.82 秒）、原 Notebook 编写与恢复 1/1（28.64 秒）通过。测试修正只涉及 5 文件，9 个生产文件与共享 wrapperSandbox 均未再改。

独立差异审查 APPROVE，无确认缺陷：最终实际 app/CLI 3/3（流程 30.32 秒、peer/停止 34.58 秒、完成继续 27.86 秒）；main 权限/异步交付物停止与改绑/实际完成回调一次继续/名册 5/5（1.89 秒）；关键边界 8/8（2.64 秒）以及收养作业 await 后取消/改绑的 2 项故障注入通过，后者均为 0 physical cancel。新增测试修正保留会话隔离、peer 回报状态、真实 job/launch/PID、同 Phi 新代和无重复启动断言。21 文件定向 lint 通过；main 旧测试类型诊断 90→90，3 个旧 Wrapper 测试合计 28→28，其余定向文件为零，合计新增诊断 0；没有清理无关类型债。各组有交集，不相加作为全库数量。

主代理既有相关组：63 个未改 Wrapper/present 测试文件，563 项，562 通过、0 失败/取消、1 既有网络集成跳过，31.74 秒；9 个生产文件、共享 wrapperSandbox 及所选测试哈希前后不变。生产全部类型、构建、asar 通过，共享 runtime 目标字节未改且符号链接已恢复。完整 lint 首轮发现新测试缺返回类型，修正后的完整 lint 通过，保留两条既有格式警告；最终 5 测试修正另经定向 lint/typecheck。没有重复全库，先前 main 全量证据仍只对应原固定 tree。

本轮 main 大入口仅修改原服务注册/发布接缝，作为既有架构债保留。JobManager 为 919 行，保留现有接受、持久化、进度和结束的同一所有者，避免在取消修复中机械拆分；host scope 和 remote controller 已分离。新实际流程与边界场景 helper 分别 349/372 行。真实 SSH/provider/OAuth、Slurm/Nextflow 环境和跨应用冷 origin 恢复尚未验证，沿 T16/T15 继续；默认 RPC 和 `run_cell` 门槛未变。

## T12 完整宿主工具交付（2026-10-14）

用户要求完成原 T12 全部功能后合并。本轮沿 `719dada3`/`5977c2dc` 复用已验收的 Notebook 编写、Wrapper 与交付物，补齐原 R4 工具清单；没有更换任务编号、重建服务、增加依赖或默认启用 RPC。全部模块和中央装配已分别定向验证及独立 APPROVE，最终标准全量及生产检查通过，已合入本地 main `fb0d054`；精确 tree、统计及验证边界见下文冻结整合记录。

| 原 T12 能力 | 实现及实际应用证据 | 状态与边界 |
|---|---|---|
| Notebook 七工具 | 六个编写工具沿 `719dada3`；`dd2b7b25` 复用真实 Jupyter HTTP/WebSocket，补执行取消、interrupt ACK/对应终态、旧 owner token、内核隔离和显式 retire；真实应用调用、保存、同 journal 新代无重放、拒绝与停止通过。 | 模块独立 APPROVE；取消未确认不释放 kernel，已开始磁盘写入不承诺回滚。 |
| Wrapper 六工具、`present_files` | `5977c2dc` 已验收的真实 JobManager/CLI 与远端产物路径继续复用，接受后后台作业独立于聊天停止。 | 模块独立 APPROVE；跨应用重启后无法证明 origin 的旧作业拒绝接管，完整冷恢复属 T15。 |
| `skill_run`、声明脚本、`env_request` | main 可信资源快照、远程 SkillService/环境/controller 与实际 SSH dispatch 守卫；声明撤销、禁用、源变更和取消后不提交；实际成功、拒绝及待批停止场景通过。 | 主进程决定执行位置；远程快照缺失明确拒绝，不读取本机同名脚本。 |
| Library 六动作、搜索 | 复用 `d94f10cd`/`a29e0ce2` 的真实服务；实际 app 六动作、审批、同 journal 恢复和异步查找期间停止/改绑通过，搜索实际流程与停止通过。 | 来源和权限由 main 选定，结果仍遵守既有 SDK 冷恢复字段上限。 |
| `ask_user_question`、`render_blocks`、`palette` | 实际应用/CLI 调用原交互服务与工具，批准/停止/peer 场景及公开消息中的 block、palette 内容通过。 | 原请求身份和公共结果路径，未增加界面占位实现。 |
| 下载 | `18f33bec` 复用下载 data plane、原 SSH 句柄、保留/发布流程；实际 app、取消/改绑、迟到清理及新代续传验证通过。 | 独立 APPROVE；旧取消不能停新传输。已发出的原子发布记录真实产物，不承诺回滚。 |
| HTTPS MCP 及既有 stdio 策略 | `89ab6fd8` 复用实际 OmpBridge 资源 worker、MCPManager、AuthStorage 和只读设置；真实 HTTPS、存储 OAuth、stdio、schema/撤销、取消、图片和完整大结构结果通过。 | 独立 APPROVE；401/403 不自动重放工具调用，私有认证同时从字段名和值隔离。真实外部 OAuth 仍属 T16。 |
| browser（含 typeText） | 同一 vault 及真实 HostCoordinator/IPC/WorkspaceRegistry；服务端 SDK 产生公共事件、签名、journal 前安全投影，原文仅由私有 vault 送实际宿主。实际批准/拒绝/停止通过。 | 不安全 replay 元数据、rawBlock 和 Cursor tool-call 别名必须投影或在历史 adoption 前拒绝；`ff960e71` 独立 APPROVE：原两项 P1 修后 CLI 2/2、单测 19/19；最后四组合别名回归及原遮盖 probe 通过，14 文件哈希无漂移。 |
| 大 `host_tool_update` | 复用既有私有结果文件、receipt、顺序队列与 hydration，真实注册 SDK 工具在公开 update 前消费完整结果；终态等待进度完成，取消中上传保留原 controller。 | 保留 1 MiB 输入帧、既有私有文件及逻辑结果预算；没有以扩大协议上限规避限制。 |

Notebook 物理执行模块的首次复审发现：interrupt 失败/没有终态时 finally 仍释放 kernel，迟到旧 interrupt 可能影响新执行。修复复用 owner token，不新增 kernel registry；失败确认保持隔离直到显式 retire，成功 ACK 缺终态等待对应终态，旧清理不能释放新 owner。执行者真实 HTTP/WebSocket 及故障回归通过，独立真实 5 项、原 WebSocket 7 项、取消/超时/旧 owner 7 项和原两故障负例通过，8 文件冻结后保存为 `dd2b7b25`。各组有交集，不相加作为全库数量。

下载复审复现：原 transfer 完成但 SSH close 仍挂起时保留旧 handle，迟到取消会误停复用 transferId 的新续传。修复在原 handle 的 completion settle 时按引用清空，原 SSH 清理继续执行。独立关键 11 项、held-close 新回归及原故障 probe 通过，新会话继续完成 8193 字节。6 文件冻结后保存为 `18f33bec`；实际 app 使用同一 manager/control 接缝。

MCP 原首次大结果 fixture 以默认 32K context 触发了真实 SDK 自动压缩和额外模型请求，原日志保留；最终仅让测试模型声明真实 1M context，未禁用维护/压缩、未提高生产预算。70,000 组中文/emoji 的完整结构、图片字节及下一轮模型历史核对通过。复审复现 SDK 的 `onAuthError` 会在 401/403 后自动重发工具，以及认证可由 object key 泄漏；修复仅在工具执行前永久关闭该拥有连接的自动 auth retry，并递归安全处理字段名碰撞。独立原 probe 证明每调用只发送一次、并发 401/403 各一次、后续明确新调用成功；6 个结构值全保留，事件/历史/模型请求/worker stdout 无合成凭据。最终模块 14/14、独立精确 4/4 和原两故障 probe 通过，15 文件冻结保存为 `89ab6fd8`。

中央入口沿原13个生产接缝，工具资源由 main loader 选定并随该代关闭；只为可信 `notebook.run_cell` 追踪原服务 promise，facade 的 prompt-finally/abort/dispose 等真实执行结算后再释放选定依赖。普通工具校验失败继续交模型处理，物理取消未确认保留错误及内核隔离；不能以 host bridge 提前终态代替实际内核停止。执行者 28 个实际 app 模式各取得自然退出的通过日志，最后 scope 22/22、main 238/238、旧 Notebook/Wrapper 流程 2/2、UI 五模式最终 5/5，生产类型及 29 文件 lint 通过；范围有交集，不将分组日志称作单次全量。中央冻结保存为 `8449d073`，独立 APPROVE：实际 app/CLI 6/6（100.64 秒）、真实 Notebook drain 2/2、dispatch/资源快照 10/10、部分 loader 失败/abort 清理 probe 2/2；29 文件 lint 通过，生产 13 与测试/helper 16 的哈希前后一致。定向测试类型中旧 main harness 90→90，其余中央路径零诊断。

结构判断：保留现有 Notebook execution 的单一协议/所有权实现（985 行）、数据平面的同一传输生命周期（627 行）、OmpBridge 的 worker/event/idle 生命周期（691 行）、宿主调用/进度队列（616 行）、远程代次生命周期（799 行）及 facade 的代次清理（715 行）；分别已有 router、会话、MCP adapter 和 helper 边界，不在安全修复中机械拆分。main 大入口是既有架构债，本轮只修改原服务接缝。完整 T11 provider/history 矩阵、T13 剩余主控制、T14 专家资源/后台/steer、T15 跨应用资源/作业冷恢复、T16 两台真实主机/provider/OAuth/UI/Finder 和稳定后的 T18 仍按原依赖执行。

## T13 模型与思考级别实际应用增量（2026-10-15）

用户要求“继续完善下一步，确认功能没问题的话先提交合并一版”。基于 T12 完成后的 main `6b14e6ac`，沿原 T13 实现一批可独立验收的模型/思考控制，复用既有 SDK 选择命令、可信 registry、审批、journal/adoption 和资源服务。保存为 SDK 合同 `46597f1e`、UI `8beeaf60`、实际应用 `1064cd63`，本地合并 `43718e2`；合并 tree 与冻结候选完全一致：`5ff8a2e6122f749b639a24d5a93183b66b3b8b6d`。

模型切换只从主进程最新可信目录取得原模型和目标模型，按同 journal 构建新代，授权去重后最多两个模型；普通启动仍只授权一个，网关 256-model 上限未改，大于 256 的主目录不截断用户选项。思考级别同时校验可信元数据与 SDK 实际支持列表，读回实际值后才确认；原始 SDK 会在运行中接受控制、对部分值静默降级，Phi 不能把命令成功直接当作选择成功。运行中/待批远程会话在变更前拒绝；本地原有“保存下次运行策略”契约保留。

主入口在第一次 await 前固定实际 Phi 目标，查找和 dispatch 后继续核对代次、项目、host/profile、远程引用及取消。SDK 状态和 checkpoint/adoption 确认后才发布 Phi 保存策略；命令可能已执行却丢失 ACK、旧代关闭失败等不确定情形隔离原代，要求显式恢复同 journal，不宣称回滚或自动重放 prompt/工具。显式恢复先协调已保存思考策略，避免迟到 ACK 覆盖用户保存的 high。UI 按实际应用的会话 key 与已确认成功顺序接收响应，旧会话/旧请求不能覆盖新选择；读回失败时保留最新已确认值，非推理模型不会把非法 undefined 写入必填界面状态。

资源及原有受控前台子任务沿旧实现复用。新代启动先恢复 journal 和确认目标模型/思考，再创建子运行配置；只有可信、空闲、精确身份的 attestation 在完整模型/路由/资源/发布检查通过后，才允许安装尚未安装的 task wrapper，不能修复已被替换的 wrapper。权限、协议预算和子模型 max 限制均未扩大，旧 EOF/清理不能关闭新代。

收尾按内部 beta Model Scope 再查默认策略，独立复现了一个 P2：合法 low/xhigh 模型或 high:null 的配置会自动选到 xhigh/max。补丁 `81b48731` 只筛选自动 fallback 的常规等级，优先 high，否则最高常规；没有常规级别时为 off，已保存/显式支持的 xhigh/max 和原校验保留。仅 1 个生产文件和 4 个测试/helper，单元原 3 失败/4 通过、修后 7/7；合法真实 catalog 原红 22.85 秒（实际 xhigh、应 low），修后原模型/思考加新 fallback 共 3/3，85.18 秒。独立新单元 7/7、实际 fallback 1/1（24.75 秒），5 文件类型零诊断、lint/diff 与哈希检查通过，P2 关闭。该修正已合入本地 main `365b2db`，最终 tree 与冻结修正候选一致：`644ceebcaf8ba0182f07a8abe1372d1e6f1fe610`。原 369 项组只对应先前 `1064cd63`；最终修正用上述定向回归验收，没有重新声称全组或全库运行。红/绿与最终审查记录保存在 `T13-fallback-*` 和 `T13-Selection-default-*`。

| 验证 | 冻结结果与边界 |
|---|---|
| 官方 CLI/真实网关公共合同 | 主代理独立 5/5，10.596 秒；模型/思考持久化、流中原始行为、无重放及 registry authority。部分 setup 失败加 cleanup 故障保留原错误，释放 worker/listener/私有目录。 |
| 实际应用与兼容性 | 执行者模型/思考/恢复、busy/approval、取消/改绑、晚 ACK、资源与子任务均通过；最终实际模型/上下文/名称 43.06 秒，资源/子任务 38.18 秒，原批准子任务 27.16 秒；main 6/6。 |
| 独立差异审查 | backend 17、UI 3、SDK 2 文件 APPROVE。独立实际 4/4（102.21 秒）：无效级别/大目录、查找中止、晚 ACK 恢复、资源/子任务与 peer 隔离；main/dispatch/子权限 8/8。 |
| UI 与相关回归 | UI 执行者 25/25，修复增量和原 fallback/身份用例独立复验通过。主代理同 15 文件相关组标准并发 4：369/369、0 失败/取消/跳过/todo，87.25 秒，2528 跟踪文件哈希与 HEAD 未变。 |
| 生产检查与合并 | 候选完整 build（含生产类型）、asar、lint 通过（0 error，2 条既有格式 warning），架构及引擎边界通过；初次合并后主工作区 build/asar 28.18 秒通过；最终 `365b2db` 再验主工作区生产类型/build/asar/完整 lint 全通过，36.31 秒，2529 跟踪文件前后哈希未变（仅预期三份状态文档待提交）。锁文件及七个 OMP 包仍为 18.10.3。 |

各组范围有交集，不相加为全库总数。本批没有重跑全库，T12 的 6083 项证据仍属于 `fa6c181c`。首轮相关组 369 项中 368 通过、0 失败、1 取消（140.46 秒），原 selected-cleanup 测试超过 60 秒；当时另有实际应用验证并行。原测试单独运行 19.79 秒通过；之后在无其他验证任务并行时，同组/同并发/同期限 369/369 通过，未修改源码、断言或跳过。仅单测通过未被当作整组通过，也未仅凭负载推断首轮原因。两轮组日志、隔离记录及哈希保留在 `.omx/omp-recovery/pm/reports/T13-Selection-*`，应用原始记录在候选 `.omx/T13-selection-*`。

结构判断：facade 917 行、remote runtime 866 行保留同代生命周期协调，选择事务已在既有 helper 内隔离，不机械拆分 journal/adoption/关闭所有权；main/runtime-adapter 与 App 大入口仅修改原控制接缝，继续作为既有架构债记录。UI 测试 631 行保留一个受控异步 harness 与相关案例。未增加依赖或 SDK 内部 import 白名单。

该模型批次结束时待接续原 T13 的 compaction/persona/memory/context 配置；压缩后续交付见下一节，已有上下文查询和名称接口继续复用。T11 完整 provider 矩阵、T14 扩展专家、T15 冷资源/后台恢复、T16 真实 SSH/provider/OAuth/人工 UI/Finder 及既有终端压力状态竞争均未在本批宣称通过。RPC 与前台专家默认关闭，未推送、发布或读取真实凭据。

## T13 压缩实际应用增量（2026-10-15）

用户要求继续下一步功能完善，沿原 T13 从 `285ebf72` 接续，复用已交付 T12 和模型/思考控制。UI `d599000a`、官方 SDK 合同 `ca07dae0`、核心与 main 原子提交 `88cde2d8`，本地合并 `eea33bd3`；合并 tree 与冻结候选一致：`f77875217f87513e546848ff1aac37930a6048f0`。并行输入编辑器的跟踪及未跟踪改动已备份并完整保留，未混入本批提交，主工作区因此仍有其他工作改动。

相关组之后完整 lint 发现新测试直接 OMP type import 违反现有边界。`9b1425aa` 仅从既有生产签名推导两项 fixture 类型，删除直接引用；11 单元、独立精准类型/边界/lint 审查及完整 lint 通过，未扩白名单。最终合并候选为 `9b1425aa`；全部生产及相关 610 项测试源与 `88cde2d8` 相同，只有不在相关组内的上述单元文件改了擦除类型来源，没有重复 CLI/610 组或声称它们重跑于新提交。

手动压缩使用私有扩展的短命令调度 `ctx.compact`，以关联回调、真实终态和 checkpoint/adoption 确认成功。原始 SDK `compact` 串行占用控制队列，不能用于需要可达停止的应用控制；`prompt_result completed` 也会出现在取消/错误时，不能等同压缩成功。策略读取与调度分两步，异步查找后复核原身份；停止等原生 abort ACK 和实际关闭/终态，不确定时退役原通道，显式恢复同 journal，不隐式重发 prompt/工具。已接受的 A 压缩在导航到 B 后继续；换 owner、host、journal 或原生命周期仍须拒绝，B 不受迟到结果或旧停止影响。

自动设置复用空闲同 journal 代次重建，确认实际加载的 enabled/thresholdPercent/thresholdTokens/methodOrder 四字段后才保存 Phi；同一只读桌面 Settings 快照提供默认与有效策略。默认 `thresholdPercent=-1` 是 SDK 合法 reserve sentinel，必须精确保留；70/80/90、固定 token、空方法与继承均有实际证据。若 SDK 启用非空 per-model 阈值 map，四字段协议不能忠实表示，RPC 启动/控制在旧代退役或保存前明确拒绝，即使自动开关关闭也不能绕过；不声称任意 SDK 调优均已接入。UI 复用已有压缩菜单、设置和停止入口，按目标/epoch 隔离迟到读取、保存和错误。

| 检查 | 冻结范围及结果 |
|---|---|
| 作者实际应用 | 19 个不同场景，分必要定向运行累计 507.15 秒；含手动/自动、70/80/90、继承/默认/固定 token、取消/丢结果恢复、忙/待批、查找后取消/改绑及 per-model 拒绝；不是一次全套运行 |
| 独立实际应用 | 手动、自动、取消、原生默认策略 4/4，131.06 秒自然退出；原 lost-notify 关闭故障探针另绿 |
| 官方 CLI 合同 | root 独立 6/6，21.87 秒自然退出，37 个改动文件哈希未变 |
| 主进程与 UI | main 39/39、独立后台接受/清理故障探针及 owner/stop 7 项；UI 独立 deferred 18/18 与 SSR 1/1；作者相关 99/99，范围有交集 |
| 核心定向 | 作者 27 lifecycle/readback + 1 真实 Settings；独立 19 核心 + 1 Settings，类型/lint 零新增问题 |
| 最终相关组 | `88cde2d8` 标准并发 4、原期限，30 个文件 610/610，无失败/取消/跳过/todo，110.79 秒；2543 跟踪文件和 HEAD/tree 前后未变 |
| 生产与整合 | 候选 node/web/scripts 类型、完整 lint、build、asar 均通过；本地合并后含并行 WIP 的主工作区再次通过同项检查，36.92 秒，2553 个工作文件及 HEAD 未变；组合后的手动压缩停止 SSR 另以原断言 1/1 通过 |

真实手动场景将 82,547/1M 上下文压缩后继续显式对话，原工具 marker 的内容与 mtime 不变，恢复无隐式请求。SDK 可发多个有明确 summary 用途的请求，不能把合法 summary fanout 误报成原 prompt 重放。取消退役时 SDK 允许追加官方 `custom/session_exit`；旧 journal entries 的 canonical SHA 一致，无新增 message/tool/compaction，不声称整个文件字节不变。默认异步维护保留，没有关闭维护以换通过。

原失败记录保留：原合同队列中取消等待者会堵住后继；微小历史真实返回 Nothing to compact 暴露 self-close 等待；丢 private outcome 的关闭等待原本悬挂；main bootstrap abort 失败原本跳过 dispose；默认 -1 原本误拒绝、自动关闭时 map 原本可能静默丢失。各项最小修复均经原探针或真实场景确认。正向 summary 分类替换测试 FIFO 争用，不提高期限/预算或放松重放断言。原 native DTO 的 local-only `codexCompaction` 只按官方边界丢弃；已知 `compactionSummary` 仅公开安全显示字段，未知角色和私有载荷仍拒绝/隔离。

结构判断：新协议 83 行、扩展 225 行、宿主控制 155 行独立。facade 1072、remote runtime 1052、runtime-adapter 1224 行作为本轮临时 legacy 例外保留，集中管理同一 owner/代次/adoption/停止时序；以后拆分须先锁住这些边界。main 11474、App 5260 及既有 VM/SSR 测试 13617/2089 行也作为临时 legacy 例外保留，只改控制接缝，避免夹带入口迁移。ChatView 995 行只增加原停止条件，settings 测试 720 行保持同一设置契约；本批不机械拆分。既有测试类型 main 90→90、ChatView scoped 基线均无新增，不能写成全测试类型零诊断。

原始与最终日志/冻结哈希在 `.omx/omp-recovery/pm/reports/T13-Compaction-*`，作者场景在候选 `.omx/T13-compaction-*`。各验证组范围有交集，不相加为全库总数；T12 6083 和前一模型批次 369 项仍只属于原冻结版本。该压缩批次之后的 persona/memory/context 已由下文完整交付完成；T11/T14/T15/T16/T18 的未完成项及真实 SSH/provider/OAuth/Finder/终端压力竞争保留，默认 RPC 关闭，未推送。

## T13 全部 Phi 应用功能交付（2026-10-15）

用户要求“T13所有功能一步到位，或者分配可以异步执行的，没有冲突的任务”。沿原 T13 分成 core、项目记忆、Main、既有 UI、SDK 合同和独立审查六条原生并行任务；root 集中处理共享接口、打包、整合、提交。已有 T12、模型/思考与压缩直接复用。最新 main `e02f7990` 的 24 条界面路径与本批 44 路径无重叠，同步后逐字保持；本批一次完整保存为 `cadb8823`，本地合并 `9f723379`，tree `fc6ab2767120318ad04ed2e0600cf0453a9cb644` 与冻结候选一致。29 条并行文件管理改动备份并恢复，未进入本批提交，主工作区仍有 WIP。

| 原 T13 产品范围 | 完成行为 |
|---|---|
| 主审批、模型/思考、压缩、用量/名称 | 复用此前交付；公开改名补 main-owned control 跨 await 复核并只确认一次；已有 RPC 引用离线仍须显式恢复，未创建会话可保存未来名 |
| Phi 身份与 persona | 默认 Phi 身份，用户 persona 恰好一次；复用原 builder，搬入扩展打包闭包后原 API re-export；忙/待批/手动压缩期间拒绝会中断当前 RPC 的 persona 保存，迟到 onboarding 不影响新会话 |
| 远程上下文 | 主进程真实读取 named 三文件、64 KiB 和 SSH canonical 边界；可信快照、私有发布哈希与本代证明绑定；公开 buildSystemPrompt 使用真实活动工具与显式 contextFiles、空 custom/append/skills、关闭自动树，不引入隐式服务器规则，也不全局禁模型 provider |
| 项目记忆 enabled | 已验证完整 checkpoint 的记忆副本只进入桌面项目私有 import/SDK DB；真实公开 SDK 两阶段总结后再校验 project epoch 并发布到既有 canonical memory root，现 UI 与新会话读取同源摘要；副本不冒充服务器恢复 journal |
| 项目记忆 learn/删除/清空 | 复用既有 SDK learn 清洗和长度边界；按 enabled/learn 开放真实工具；项目队列/epoch、持久检查点标记、所属 child 退出确认防止迟到写回、旧记录重提及误伤 peer；目录已移动也能按旧 namespace 清理 |
| 配置与生命周期 | 同项目并发设置明确 busy，旧写入者关闭后再复核并保存；记忆变更不撤销浏览器/Notebook 等通用工具或中断已接受聊天；本代记忆块固定，下一新会话/显式恢复取新快照；可选记忆故障只作安全诊断，不把已完成聊天改失败 |
| 既有 UI | persona、记忆开关/摘要/学习列表/删除/清空及上下文显示直接复用；仅修记忆卡片重复操作与读写交错，无新占位页面 |

本地 SDK 辅助会话是真实 public SessionManager/AgentSession，tool-less，不调用原 prompt/工具。SDK 总结请求不转发取消信号，因此使用项目所属 Bun child，取消等所属退出及真实 TCP 断开；不终止共享 worker 或另一项目。child 保留原桌面 SDK 的受信环境/任意 canonical ENV、代理/CA/broker 行为，继承只限本机 SDK 处理，不进入 server、host tools、DTO、cache 或日志；禁止调试请求日志。canonical readonly Settings 保留用户 smol/default 和 memories 预算，主模型只作 fallback，不强迫用昂贵主模型。

| 检查 | 版本及结果 |
|---|---|
| 新官方 SDK 提示词合同 | 3/3，9.276 秒自然退出；公开 builder、真实 provider-visible 精确一次、reload/model/resume 无重放 |
| 新真实应用组合 | 作者 7/7，覆盖默认/组合轮换恢复/取消/改绑/迟到启动/不可信配置/真实应用记忆；独立 app-memory 1/1，31.667 秒 |
| 最终直接记忆 | 最终 9 生产 + 3 fixture 哈希绑定，Node provider 3/3，8.034 秒自然退出；两阶段摘要、同源 UI、新快照、学习/清理/冷重开、两次 TCP 断开和 peer 保留 |
| Main/UI/轻回归 | Main 65/65 + route7，独立关键13/13；UI 15相关/独立5；记忆轻回归13/13；核心 builder/策略11；各组有交集，不相加为全库总数 |
| 冻结整合 | `cadb8823` 标准并发4、原期限，41文件700/700，无失败/取消/跳过/todo，113.65 秒；2574 跟踪文件及 HEAD/tree 前后未变 |
| 生产与主工作区 | 冻结候选生产 node/web/scripts 类型、完整 lint/build/asar 通过，66.31 秒；合入后含并行 WIP 的主工作区同项再次通过，39.92 秒，检查期间工作文件和 HEAD 未变 |

审查发现并以原探针修复：缓存不再信任持久化任意路径，而由受控 UUID 派生；缺失 cwd 不再阻止 CRUD；同项目 fresh scope 初始化通过已有短锁预留唯一 child；用户角色/预算、环境凭据和代理兼容恢复。原红/绿均保留。测试最初误按 SYSTEM 内容判断 SDK 阶段，以及 Bun POST/SSE 的关闭事件不可靠；最终由真正 Node HTTP 服务观察原 TCP 断开与未完成响应，保留 25 秒、child join、peer 和全部断言，没有修改生产取消或提高期限。

结构判断：新策略 schema/reader/扩展/发布分别约127/70/81/83行，记忆 adapter/cache/env/coordinator/child 分别225/65/11/516/64行，均按数据边界内聚。facade1160、remote runtime1072、runtime-adapter、main/App及原大型 VM 测试继续作为临时 legacy 例外，保留同一 owner/代次/adoption/停止协调，不机械拆分。生产与新增测试定向类型无诊断；Main 旧测试90→90、engine旧测试1→1，无新增，不称全测试类型零诊断。

完整验收矩阵与文件清单在 `.omx/omp-recovery/pm/reports/T13-COMPLETE-COMPLETION.md`，实际与独立证据在 `T13-Complete-*` 和候选 `.omx/T13-*`。T12 6083、模型369及压缩610仍绑定各自旧版本，不冒称本轮重跑全库。原 T13 定义的 Phi 功能完成，不等于全部 OMP 原生配置：启用非空 per-model 阈值 map 仍明确拒绝；远程 plan mode 原产品入口禁用、tool-less auxiliary 仍本机。T11/T14/T15/T16/T18、真实 SSH/provider/OAuth/UI/Finder 和终端压力竞争保留原门槛，RPC 默认关闭，未推送。

## T14/T15 专家与显式恢复（2026-10-15）

本轮沿原 T14/R6 与 T15/R7 完成产品接线，没有重建 T12 服务、改任务编号、改 SDK 或扩大依赖/白名单/协议预算。功能冻结候选 `d9b5d776ce84845337b0d37d4f033f2e4320d71d`，tree `de03e7884d2c19c69e42da51f09a4af4917c66ed`，共 138 个功能路径、2645 个跟踪文件。该候选标准全量为 **6449 项：6424 通过、0 失败、0 取消、24 既有跳过、1 todo，1542.28 秒**，全部 2645 跟踪哈希前后稳定；它不是后续整合提交的全量结果。当前整合提交 `03da779eee81a606f887aa8ec154d10be91e1a79`，本地合入 `a70d403b`。

验证期间主线并行 57 路径已保存为 `8b9c545be8ba2cb74482f4846eae9ac72b5d9284`；整合提交以它为基线，tree `06ff470204e8e4e419443a76a3469add89c19e77`，2669 跟踪文件、138 个功能差异。49 个对方非共享路径与 `8b9c545b` 完全一致，130 个本功能非共享路径与 `d9b5d776` 完全一致；8 个共享路径整合，仅 `jobLabels` 冲突同时保留历史只读与 agent `canControl=false` 两个守卫。没有重做对方 UI；其原 279 项仅是该提交的验证记录，不声称本轮重跑。合并时的 Notebook 36 路径 WIP 完整保留。组合后的 21 文件轻组、前台实际五场景/T15 恢复/主线 RPC policy 交叉及生产 gates/主工作区后检查分别记录，未重跑组合后的全库，也不把以下分组相加成全量。

最新主分支悬停修正 `e764106c` 的五个界面/测试路径已保留；它们与本功能 138 路径无重叠，其余 2664 路径与 `fb63a68b` 逐字一致。431 项交叉组与 22 项 SDK/轻量组曾在 `fb63a68b` 通过；最终界面相关组和生产检查绑定 `03da779e`，实际 SDK 22 项仍明确绑定 `fb63a68b`，没有冒称在纯样式整合后重跑 SDK。共享 RendererApi 直接继承已有恢复接口，删除三个重复别名，运行时代码逐字不变，架构检查通过。

最终固定标准全量退出码 0，HEAD/tree 与 2645 个跟踪文件运行前后一致；保留原并发 4、300000ms 及全部跳过/todo。功能全量只绑定 d9b5d776；合并的提交 tree 与整合候选 03da779e 完全相同，整合验证使用另列的定向回归，没有宣称再次运行全库。合并后以独立类型提交 `9e1e5ae2` 将生成单元格类型移到已有 shared Notebook 文档模块，保留 renderer 旧别名，字段/可变性/生成 JavaScript 不变；Notebook 新增的两行接口留在未提交工作区。主工作区 production type/build、完整 lint 与 asar 再次通过（65.6 秒），2680 个跟踪及并行工作文件检查期间未变，全部并行 WIP 保留且未纳入功能提交。全量只对应固定提交；并行 WIP 没有冒充已跑过全库。

### 本轮实现

| 范围 | 实际行为及边界 |
|---|---|
| 可信专家配置 | Main 选择完整具名定义与资源快照；专家独立模型/思考与实际 SDK 模型、支持等级及签名路由一致。无推测 fallback，不把未支持的显式 effort 当成功；renderer 或工具参数不能自授模型/资源。 |
| 原生工具与资源 | 专家可用声明并获准的 read/write/edit、bash、glob/grep；skills/声明脚本、受管环境及服务代理复用 T12 的真实执行器、schema、动态审批与取消。资源由同一已证 Task/子实例 owner 选定，缺失/撤销/改绑在最终派发前拒绝，不读本机同名资源。 |
| 环境与安装边界 | ready 环境复用既有 alias、marker、包/通道约束摘要与受管命令接缝；权限和执行位置保持服务器所属。隔离 marker/命令 fixture 不等于真实 conda solve、安装或目标主机包可用性验证；这些仍须 T16。 |
| Task 并行与后台 | 沿官方 SDK Task/async manager 与现有持久父调用记录，主进程按已选定义授予并行/后台；活跃与预留名额合计最多 4，超额拒绝，不另造隐式排队平台。父 prompt 返回后已接受的后台子任务可在同一所属代继续。 |
| 四个专家控制工具 | 原 `agent_status/agent_wait/agent_steer/agent_stop` 的 schema、说明和执行逻辑复用为父 Main 的 host 工具。原生 task ID 和私有 run ID 仅在当前已证 live 列表内解析，控制、去重及 reported 一律归一私有 ID；不把该名册默认授给子专家递归使用。 |
| 审批、停止与回报 | 主/子运行、项目与主机绑定独立；stop/steer/wait 传原调用信号。物理取消/host drain 与对应终态确认后结算，失败不能跳过 peer 清理。完成先向原 Phi 持久交付，再确认 reported；消费抑制重复唤醒，较新的 Main 运行不能接走旧子任务权限。 |
| 子模型网关与浏览器 | 子模型按准确 inference actor/模型/会话授权，父 prompt 结束不把子调用降级成 Main；HTTP 取消保持 peer。子 browser `typeText` 明确 unsupported，待独立 actor 隐私闭环后再开放；父会话已验收的私有输入路径不受影响。 |
| 显式原会话恢复 | 复用严格 journal/transcript/blob/shake 验证、writer lease 与原子 adopter。原模型可用则保留；失效时由用户明确选择目标，先证明旧 journal 的模型，再确认新模型读回，最后保存 Phi。每个 await 复核原身份，创建控制只活到 factory 返回，不污染下一次明确 prompt。 |
| 恢复 UI 与 D5 | 断线、不可用模型、丢失/损坏 journal、缺资产、绑定变化有安全固定提示。本地时间线仍可读；用户明确确认有界摘要后创建新 Phi ID，原会话/ref 不覆盖。摘要只作私有 context，不自动 prompt/tool/job；单 seed 的 newPhi/project/provenance/body hash 及 16 KiB 边界严格校验，删除旧来源不破坏已接受的新快照。 |
| Wrapper 冷 origin | 接受时持久保存主进程可信来源，冷查询每次核对当前 Phi/project/profile/root 与运行时配置。既有 JobManager 只接管可证明归属的原 job/controller，不重做 launch；项目/主机档案/connection/root 不同或旧 origin 不可证明时拒绝。远端结果仍是远端定位符。 |
| 冷 SDK 子任务 | 真实同 journal 新进程不会重建旧 child registry/async job/live handle。只保留已验证的来源 metadata：旧活动且无终态证明的记录标 interrupted，已保存 completed/failed/aborted 终态保留，全部 `canControl=false/historyAvailable=false`；即使旧子文件仍在，也不冒充可用的官方冷 transcript 读取权限。 |

持续 SDK 后台执行要求当前 RPC/子实例所属代仍存活；本批没有新增 server daemon、setsid 自动续跑或跨重启隐式提交平台。Wrapper 沿用既有独立持久作业机制，与 SDK 子任务冷中断是不同生命周期。公开 child task 预览保持空值，不从不可信 payload 猜完整任务。

### 验证证据与最终门

下列分组来自各自冻结范围，不能相加为全量，也不能用早一版限定通过覆盖后续源码。官方 SDK/CLI、真实桌面 factory/服务与本机 shell 回环 fixture 均使用隔离 HOME/agentDir 和合成模型/凭据；不代表真实 SSH、外部 provider/OAuth、Slurm/Nextflow 或 conda solve 已通过。

| 证据 | 已保存结果与范围 |
|---|---|
| 官方子任务契约 | `T14-child-control-contract-freeze.json`：3/3、3.868 秒；并行/后台、准确 steer/cancel/wait 与同 root journal 冷重启，冷 registry 空、旧 steer/history 拒绝、0 provider 重放。 |
| 原生 edit/搜索与资源执行 | `T14-native-edit-search-first.log`：批准/拒绝/停止 3/3、3.535 秒。`T14-resource-actual-posix.log`：实际 App/CLI 1/1、32.197 秒，独立 model-b/off、SKILL 恰好一次、真实文件与 Bash、mamba fixture、MCP image/blob、同 journal 恢复 0 重放。mamba/ready-marker fixture 不等于真实 conda solve；compiler/owner 专项另行限定，不冒充外部环境验收。 |
| 后台生产控制 | 前版 `T14-lifecycle-final-freeze.json` 的限定 22/22 与实际组合 1/1、28.364 秒保留。`3dc66eab` 批次 default/later Main negative 实际 2/2、60.181 秒，fresh bundle `d363a…`；跨父 Main 否决与同一所属子实例控制分别核对。常规 SDK started 在 prompt 前；观察缓存只是候选，实际修正是 Subfactory 再次执行 local-empty 时保持同一 Main-attested owner，不是“SDK 总是晚发 started”。 |
| 原四控制工具 | `T14-agent-run-tools-freeze.json`：6 新例加原本地合同共 54/54；native/private ID、精确调用信号、completion-before-reported、并发去重和 peer failure 隔离。实际 Main 名册的最终覆盖绑定本轮固定源码。 |
| 既有真实应用及名称恢复 | 原 metadata 的 late-policy/send-failure 是同一名称同步缺口的两个真实失败场景，修后 2/2、52.358 秒；原 app 三个真实 App/CLI 场景加一个 nonreasoning 可信 compiler 提前拒绝轻量场景（0 CLI/provider），runner 汇总 4/4、56.040 秒。版本和分组有交集，不与其它限定组相加。 |
| T15 恢复与创建控制 | `T15-recovery-integration-final-freeze.json`：router4、观察边界1、真实恢复1（29.894秒）；真实目录先有 B 后消失时 typed MODEL_UNAVAILABLE 且 Phi A/ref 不变；saved A→同 journal attached B→Phi B；旧准备控制结束后首次明确 prompt 成功，provider 总数仅 seed A + 新 prompt B。 |
| D5、origin 与 UI | 后端 FIFO 修复后 10/10；私有提示词/preload/App 19/19；同 Phi 代次变化及恢复成功/界面刷新失败的独立 UI 回归见 Main freeze。Wrapper 既有冷接管 3/3 为本机 shell 远端 fixture；不扩展成真实集群验收。 |
| 路由与物理历史 | `3dc66eab` 批次 raw/projector 路由 actual 1/1、55.308 秒：thinking SDK 读回与 Phi 一致，原 journal 全部旧 entry ID/canonical hash 不变；原 aborted partial 连同 SDK 原始字段仍完整落盘，返回 context 只去已知那一条。原 DTO-vs-raw 诊断失败日志保留，不写成先前未持久化或丢历史。 |
| 类型与生产检查 | Main 旧测试类型 **90→90、新增 0**，新增/owned 测试类型单独记录；不能写成全体测试类型零债务。固定 `3dc66eab` 生产类型/build/asar/完整 lint 均退出 0，70.36 秒，2645 跟踪文件及 HEAD 前后稳定，共享 binaries 未变。`3dc66eab` 的 15 文件修正 scope APPROVE；后续 5 文件增量另行独审，标准全量另行绑定下行，不混用。 |
| 前台真实 ID 增量 | `T14-foreground-final-id-final-receipt.json`：5 文件（1 生产、4 测试）窄修，pure 26/26；actual 5/5、129.559 秒，自然退出。unnamed FG 18.578、repeat 18.892、resources 33.656、BG 27.371、later Main negative 30.584 秒；fresh bundle `fa76e127c9e2dec0822e489e0d813f68821057202c7f97ecb352bda610f9c792`，360 依赖哈希不变。5 文件 scope 独立 APPROVE，快照 SHA256 `cc6334acd6f6f71020be00ac3a16b37b6bc96c976e10ae76d86f6d85469d30de`；不把前版 15 文件审查当成该增量审查。 |
| 功能候选标准全量 | `d9b5d776`：**6449 项：6424 通过、0 失败、0 取消、24 既有跳过、1 todo，1542.28 秒**，2645 跟踪哈希稳定；原标准 runner，未改变断言/期限/并发/skip。只证明该功能候选，不证明整合提交全量。 |
| 主线组合限定检查 | `03da779e`：21 文件轻组 `458/458，0 失败`；`fb63a68b` 的 actual 五场景/T15 恢复/主线 RPC policy 交叉 `22/22（17 个实际 SDK 场景、5 项轻量），0 失败`；生产 gates `238.2` 秒，主工作区后检查按最终整合记录。各自限定范围，组合未重跑全库，不与功能候选全量混算。 |

首轮标准全量保留为失败记录：固定 `b7720a84c9be70b93645133d3c8dbf2351f7dd3a`、tree `fc2b531e8f2d1cba8d0fdcfa0dfe75e53154b383`，**6441 项：6403 通过、13 失败、0 取消、24 既有跳过、1 todo，1562.75 秒**；HEAD/tree 及 2645 跟踪文件运行前后不变。原始记录为 `.omx/T14-T15-standard-full-test-b7720a8.json/.log`。13 项分为 10 项旧 fixture/合同、同一真实名称同步生产缺口的 2 个失败场景和 1 项 Bun 原期限超时；另独审发现的跨父 Main negative 生产缺口也已修复，它不计入这 13 项。原断言、时间、并发与 skip/todo 不提高。首轮只引用 `-b7720a8` 归档；无后缀 standard-full 路径用于修后固定全量，不能再当作首轮日志。`d9b5d776` 功能候选的修后全量独立记为 `6449 项：6424 通过、0 失败、0 取消、24 既有跳过、1 todo`、1542.28 秒，不能扩展为 `03da779e` 组合全量。

中间候选 `3dc66eab8f628de6713f631570816fa14833bdfb`、tree `45ea743138a9aa86041a339a2c19e4911e7dfcd5` 的标准全量为 **6446 项：6419 通过、2 失败、0 取消、24 既有跳过、1 todo，1545.63 秒**；HEAD 及 2645 跟踪哈希前后不变。失败记录独立归档为 `.omx/T14-T15-standard-full-test-3dc66ea.json/.log`，不是最终通过记录。repeat-child 与 resources 两个失败同源于同步前台子任务预检键（label 或 toolCallId:index）与 allocator 分配的实际 native ID 不同，原资源/重复调用断言保留。后续 5 文件增量复用实际 `TaskTool.execute` 的 AsyncLocalStorage 所有权，以及真实 registry 已登记的 actual ref/profile 和已计数准入名额；不按最近记录或 label 猜所属。所有真实前台子任务始终追踪，原 flag 对 receipt 与并行/后台授权的控制独立保留，后台 exact-job 路径不变。限定回归及独审通过见上表，最终全量只绑定 `d9b5d776`。

本轮修正还区分 SDK 的物理 transcript 与恢复后的 provider context：默认 buildContext 会剔除 aborted/error assistant 的不安全 replay；这不等于物理历史删除。路由 fixture 必须按旧 entry ID 与完整 canonical SHA 证明原 journal 全保，已知 stopped partial 的 raw entry 前后不变；只对已知那一条 ephemeral context 差异作精确断言。原 Object.create 生命周期 fixture 则补真实构造器拥有的空 childVaults Map，不能给生产清理增加 optional fallback 来掩盖夹具缺失。原红日志及修后 actual 结果均保留，物理/公开 DTO 的字段差异不等于物理消息不存在；最终全量另以固定候选为准。

结构判断绑定 `d9b5d776`，不混用主工作区的并行改动。本轮已提取 7 个内聚 helper，并复用原 builder；前台 ID 增量的其余新增 helper 均不足 600 行，旧 legacy 判断不变。以下长文件保留判断分别记录：

| 文件与行数 | 本轮保留理由 |
|---|---|
| `rpc-subagents.ts` 733、`rpc-task-admission.ts` 875（`3dc66eab` 时为 826）、`rpc-child-protocol.ts` 655 | 同一精确子身份、Task 准入/容量、Main-attested owner、重复 Subfactory 执行、取消结算与签名边界内聚；前台 ID 修正继续沿原 execute/registry/actor 所有权。该 admission 源 SHA256 为 `762932d591cd41e4133b0fc42658ec1bba1a8065f229b394412008a22ce6d8bf`。资源、model actor 与 controls 已分离，不在安全修复中机械拆分。 |
| `job-manager.ts` 923、`browser-ipc.ts` 601 | 已有作业所有者及窗口/owner 授权内聚，本轮分别只增加 4 行、16 行；拆分与本次恢复和授权修复无关。 |
| `facadeRoutingOracle.ts` 726 | 同一端到端应用路由 fixture，连贯核对物理 journal、公开 DTO、模型/思考轮换、停止与无重放。 |
| renderer `types.ts` 995 | 应用级 DTO 声明，本轮仅增加 4 行，保持共享类型边界。 |
| Main `index.ts` 12443、facade 1343、remote runtime 1284、runtime-adapter 1252、preload `index.ts` 2125 / `index.d.ts` 1287、App 5364、Main VM 测试 15053 | 明确作为临时 legacy 架构债保留，集中管理同一 owner/代次/checkpoint/关闭时序；以后拆分须先锁住这些真实边界，不在本轮安全/恢复修复中夹带大入口迁移。 |

后续继续原 T11 完整 provider/history/KV 与 side/advisor 兼容性收尾，再做 T16 指定主机、真实 provider/OAuth、MCP、环境及 UI/Finder 验收；RPC 默认仍关闭。新默认路径稳定一个升级周期后才做 T18 清理，T17 随真实交付更新，不另建一套重叠任务。

### 本轮以前的 T14/T15 范围记录

以下保留原阶段当时的范围和限制，不能当作本轮当前能力清单：

- **T14/R6：** 定义编译、真实 CLI 探针和原生子权限基础 `2837875b` 已验收；准入控制底座 `39678516` 与真实前台 task 应用组合 `f148a977` 已分别通过独立审查。真实批准、拒绝、审批中停止、运行中停止、迟到启动、同调用 ID 的不同子身份、双 Phi 会话隔离、主子审批状态、重入关闭、持久失败及显式恢复均有保留的限定证据；最后停止缺口与结果分类问题已闭环，验证版本边界见上文。完整 SDK 启动前准入、实际设置/工具注册表及选定定义不可变性仍未证明；显式关闭本阶段不支持的启动功能只是必要防御，能力继续默认关闭。完整 edit、资源/环境、后台、steer、服务代理与唤醒仍待实现，不宣称完整 R6 或产品开放。
- **T15/R7：** 持久化启动、严格全分支验证及真实 SDK 默认 tool-output shake 机器标记和 `.shake.log` 资产验证均已验收；facade adoption 增量已完成限定审查，`3423a650` 已验证受控产品路径的新实例恢复同 journal；完整资源和后台能力仍待接入。实际搜索验证发现锁定 SDK 持久化对通用字符串按每字段 500,000 字符截断并附提示；本轮保持真实 SDK 的冷恢复语义，不把实时大结果无损传输表述为冷恢复全文无损。header preflight 不替代完整 transcript/blob 验证；公开 switch 的同 UID 外部文件替换残余及首次验证前非内容寻址 shake 文件的历史真实性不作消除声明。

## 冻结整合验收

最新 T12 完整交付：固定候选 `fa6c181c`，tree `73cfa9eaaac5ffa6106d4bc4fc171011fee8472c`，标准并发 4 全量 **6083 项：6058 通过、0 失败、0 取消、24 既有跳过、1 todo，1079.53 秒**。2521 个跟踪文件及 HEAD/tree 前后完全一致；所有原审批、取消、零写入、预算、期限、并发与跳过设置保留。生产 node/web/scripts 类型、完整 lint（0 错误、2 条既有格式警告）、构建及 asar 通过。`smoke:terminal-host` 的四项真实本机场景与 manager smoke 通过，共享 Bun/micromamba 目标字节未变，验收副本的临时链接已恢复。

全量之后仅 `scripts/terminal-stress-smoke.ts` 改动：`c69dd9d3` 让原三处 PID 等待要求文件非空，避免 shell 重定向创建后尚未写入的竞态。独立延迟写入/非法 PID 探针、脚本类型和 lint 通过；原 PID、进程、内存、延迟与全部期限断言保留。所有产品代码及全量测试文件与 `fa6c181c` 逐字相同，没有为这个不被全量 runner 加载的独立脚本重复全库。最终候选 `c69dd9d3` tree `a50ee161c0faf26b509d2d4888899a18aaa716bc`，本地 main 合并 `fb0d054` 的 tree 完全相同；原 main `0cc9bd7c` 的 38 个非入口路径逐字保留，主入口的七行链接预览接线与已审 T12 接线同时保留。合并后主工作区依赖版本仍为 18.10.3，生产类型/构建、asar 与四项终端宿主场景再次通过，工作区干净。

附加压力检查不冒充通过：PID 修复后的前四阶段（无 ACK 洪流、重新附着、有 ACK 洪流、worker 崩溃清理）通过，最后 supervisor SIGKILL 后的 failed 状态等待超出原 5 秒。独立定点一次复现证明：正确存活的 supervisor 被终止并发出 failed，随后 worker 清理的 exit 事件将 Manager 改为 exited，轮询漏过短暂 failed。该独立入口的 40 个生产依赖及依赖锁文件与 `0cc9bd7c` 完全一致，终端树与更早 `631671e6` 也没有变化，无 T12 引入证据。保留完整失败与定点日志；T16 须明确失败终态策略并加 late-exit 回归，不能提高期限或删除断言。额外 `smoke:terminal-packaged` 调用因未传 `.app` 路径未执行；完整打包/Finder 验证仍属 T16，不能写成产品失败或已验收。

本轮 T12 首次冻结组合 `d402cb4f`（包含 main `0cc9bd7c`，tree `dfef840f443498b010757523fe660199306191aa`）标准并发 4 全量为 **6075 项：5807 通过、243 失败、0 取消、24 既有跳过、1 todo，1094.58 秒**；2520 个跟踪文件及 HEAD/tree 前后完全一致，工作区干净。原日志完整保留。238 项共享同一测试初始化失败：main 新增链接预览 import 未登记旧 VM；另有窗口权限测试的源码切片包含新服务初始化。修复仅补真实 preview factory 的隔离测试接缝（拒绝出网）并按 AST 精确提取原权限函数，生产 UI 与全部授权断言不变。空可信技能目录生成 `enum: []` 是真实 schema 缺陷，导致搜索/Library 两项在注册阶段失败；修复只在有可信技能时登记 `skill_run`，保留非空枚举和所有审批/零写入断言。进度预算失败仅为诊断兼容，`4da7ba9d` 恢复原 frame-limit 表述并保留 logical/file/byte 说明，预算/中止/迟到回调行为均不变。最后一项纯 SSH 启动前取消从原 `CommandResult` 变成抛出 `signal.reason`，已在 `222a36eb` 补精确前台取消转换和未提交 launch 的自有目录清理，仍保留最后 dispatch 守卫；改绑等错误不能吞掉，后台无真实句柄时不伪造成功。修复均独立 APPROVE：`13784d49` 原搜索/Library 2/2、main238+scope12 共 250/250，独立空 schema/main2 和实际搜索1；`4da7ba9d` 原进度负例1、window10 和独立权限1；`222a36eb` 确定性前台/后台/改绑/清理/丢回复/helper7、原 Local/SSH 取消2 和 helper 协议5，独立7+2通过。生产类型及定向 lint/typecheck通过，main旧测试类型90→90。修后固定候选标准全量结果另记，不把首轮失败改写为通过，也不放宽超时、预算、并发或跳过条件。

此前 main 整合验收（2026-10-14）：迁移 `0c5d6753` 与 main `acbbb6b8` 的组合 tree `a4a43a8daf43fb57174a8789921a550386794822` 标准并发 4 全量 **5864 项：5839 通过、0 失败、0 取消、24 既有跳过、1 todo，879.08 秒**。前后 2478 个跟踪文件及 tree 完全一致；实际 main 合并 `631671e6` 的 tree 与此候选相同，保留 main 聊天布局逐字一致。独立聊天回归 71/71。合并后主工作区依赖按 frozen lockfile 同步，coding-agent/natives/ai/catalog/tui/utils/wire 均核对为 18.10.3；主工作区生产类型、完整 lint、构建、asar 和真实终端 4 项 smoke 通过，保留两条既有格式警告。本轮标准全量已通过，不抹去下列历史计时失败，也不据此声称真实 SSH/provider/OAuth/Finder 或默认远程启用已验收。

本轮固定提交 `3423a650` 的标准并发 4 首轮全量为 **5864 项：5831 通过、8 失败、0 取消、24 既有跳过、1 todo，926.77 秒**；运行前后 HEAD 和 2478 个跟踪文件哈希一致。7 项失败是早期离线改名成功断言与 `356b3583` 已接受的真实 SDK 标题同步契约冲突，同样的源码及断言已存在于本轮起点；`2016f286` 仅校正两份测试，验证精确拒绝原因、标题不变，并保留所有路径、原始引用、历史、导出和同名本地文件保护断言。两文件 59/59 通过，独立复跑 59/59、定向类型和 lint 通过，生产代码未改。另 1 项是既有容量探测耗时 2688 毫秒超过原 2500 毫秒断言；同一文件原断言、期限的 19/19 独立运行通过，7.91 秒。首轮失败原日志保留，没有放宽期限或增加跳过；测试契约校正后未重复全库，**不把定向结果表述为最终标准全量通过**。该次标准并发计时限制保留；后续 main 组合验收已标准零失败，见上文。

此前冻结整合提交 `72e9eedd` 在独立副本执行标准并发 4 全套测试：**5491 项，5466 通过，0 失败，0 取消，24 既有跳过，1 todo，529.60 秒**。运行前后 HEAD 与全部已跟踪文件哈希一致。生产 node/web/scripts 类型检查、构建及 lint 通过；lint 只有两条既有格式警告。该结果仅覆盖已提交的上述代码，不包含下列尚待独立验收的新改动。此前 `86555985` 标准并发全套 5422 项也为零失败、零取消。

后续冻结 `eb558c26`（含 Library、应用路由及闭包修复，不含子权限、名称控制和搜索 WIP）两轮标准并发全套均为 **5533 项**：第一轮 5505 通过、3 失败；第二轮 5507 通过、1 失败；均 0 取消、24 既有跳过、1 todo，全部文件哈希一致。三个失败分别涉及环境探测进程 10 秒启动、Bun 5 秒版本检查及容量探测 2500 毫秒期限；原断言、原期限单独复现 3/3 通过。第二轮仍有容量计时失败。补充串行全量 **5533 项：5508 通过、0 失败、0 取消、24 既有跳过、1 todo，2036.969 秒**，运行前后 HEAD 与全部跟踪文件哈希一致。标准并行稳定性尚未通过，不将限定或串行结果改写成标准并发全量通过。构建、生产类型、lint 及 asar 检查通过。

路径身份六文件增量 `edd9d988` 通过最终独立复审；独立副本仅含已提交代码，构建、生产类型、lint/打包边界及最终 12 项真实 CLI/同主机 shell 回归全部通过，25.916 秒自然退出，前后 HEAD 与所有跟踪文件哈希一致。新增测试原先依赖跨 RPC 的秒级时间窗口，已通过同一真实 shell 构造 metadata 碰撞修复；额外 1100 毫秒延迟仍通过，三次窗口耗尽必须失败。不伪造 metadata、不跳过、不将此限定验证当作全库测试。

真实 task 应用组合 `f148a977` 已通过最终增量审查并保存：真实 PhiEngine/SessionRunner 发起 native task，子审批只经一个持久 writer 写入；主子审批共享未决状态，停止先封闭精确父运行，再等待原生取消确认及对应终态。原联合审查 23 项为 22 通过、1 失败；失败是审批准备阶段已有 task 来源而尚未创建子任务时，正常停止无法确认结束。通过绑定原父运行、真实 task 结束及从未允许派生记录的认证回执修复；缺少回执仍报告未确认，不以空子任务列表代替证据。该代完成实际检查点并关闭后，必须显式恢复到新通道，禁止旧代复用相同外层调用 ID。重复的未决状态计算收口到共享状态，持久审批和通知分离，关闭流程只发布一个清理 promise。

修复版本独立 4/4 真实 SDK 场景通过（96.319 秒），新协议单测 8/8、消费单测 9/9、必要关联回归 4/4 通过。随后仅一个生产文件修正清理导致的结果误分类，最终版本独立原停止场景 1/1 通过（36.946 秒），另核对实际分类表达式的 18 种状态；其余 46 个冻结文件不变。前版 23 项失败记录保留，未宣称最终重跑全部 23 项或全库。最终独立副本 HEAD 为 `f148a977`，生产类型/构建 29.311 秒、lint 4.590 秒均通过，2461 个跟踪文件哈希和 HEAD 前后完全一致，工作区干净；ESLint 保留两条既有格式警告，结构检查保留既有长文件提示。`remote-session-runtime.ts` 为 791 行，本轮明确保留同一所有者下的证明、检查点和关闭时序；编译、子权限与持久 writer 已分离，不在可靠性修复中机械拆分。

此前 `c237d2b6` 全套 5243 项的唯一失败是旧 worker 派发合同未登记两个新增私有模型代理命令；已在 `1ee9e0b1` 修复并独立验证，完整集合的精确相等断言保留。随后 `3a084a30` 标准并发全套 5246 项出现 1 项既有容量探测时间失败，同一断言单独通过；完整串行复跑 5246 项、0 失败/取消。历史失败保留，不改写为通过，也没有放宽期限、增加跳过或修改标准并发设置。

## 当前任务状态与剩余门槛

- **T11/R3：** 已复现的 Anthropic opaque thinking、仅终态注册 API 缺口和完整工具列表的出站 DTO 均已独立验收；保留完整 schema、本地执行器和推测执行。真实 CLI 已复现 side ephemeral 通道丢失 opaque 及稀疏 thinking 内容；主通道修复不覆盖 SDK 捕获的 side/advisor/maintenance/autolearn 闭包，公开 custom handler 也仍位于外层 normalization 之内。上游最新补丁的定点源码仍保留该路径，未发现可用的全通道接缝或修复；独立 SDK 复现材料已准备但未发送，未修改 SDK、关闭默认维护或宣称完整 R3。Cursor RPC 断流恢复已另验收为 `044bac9b`；完整 KV/history replay 与剩余提供商矩阵仍待验收。
- **T13/R5：** 主运行权限及生产主会话组合已验收。审查复现的宿主桥致命故障悬挂和假就绪问题已修复，独立故障回归通过；实际 CLI 覆盖写入、拒绝、取消及恢复。真实 PhiEngine 路由、存储 adopter 与公共事件投影的 16 文件增量已通过独立 27 项复验，修复旧代清理误停新运行、模型清单不一致、损坏引用触发本地 I/O，以及丢失维护事件四项问题。打包闭包先以 `35ac4c49` 独立保存，应用路由保存为 `8ffb187d`；独立副本仅包含这 18 文件及已提交基础代码，构建、lint、生产类型、asar 检查及 30 项真实回归通过，18 文件哈希一致。上下文与名称控制已另行独立验收为 `356b3583`，19 项真实回归通过；真实前台 task 应用组合已保存为 `f148a977`；`3423a650` 已接通实际应用显式 opt-in。模型/思考级别与异步 UI 控制及默认策略修正随后已合入 `365b2db`，见上文 T13 增量；压缩 `eea33bd3` 与 persona/memory/context/公共入口 `9f723379` 均已完成；原 T13 Phi 功能已全部验收，默认 RPC 仍关闭。关联主宿主审批的终态重入已随 `2837875b` 修复并独立验证，仅复核受影响接点，未重开旧阶段审查。
- **T14/R6：** 本轮已接入独立模型/思考、原生 edit/搜索、受信资源/环境/服务、Task 并行/后台四路、原四控制工具与正确 Phi 完成消费/唤醒。最终固定源码与全量/合入状态见本轮 T14/T15 节；browser 子 typeText 仍明确 unsupported，持续后台需当前代存活，默认不开放。
- **T15/R7：** 本轮已接入显式原 journal 恢复、模型失效后的明确替换、安全错误路径与 D5 摘要新会话、Wrapper 冷 origin 严格绑定。冷 SDK 子任务仅恢复来源 metadata：旧活动且无终态证明的记录标 interrupted，已保存 completed/failed/aborted 终态保留，全部不可控制且无完整历史；不复活 handle 或开放旧子历史；保留 SDK 500,000 字符字段截断与首次 shake 基线/同 UID 替换的既有边界。最终固定验收状态见本轮节。
- **T16/R8：** GPU 已实际安装/隔离执行官方 18.10.3，并通过无 provider RPC foundation 与下文 2026-10-16 的 App 受控 4 场景；仍不代替完整 R8、真实 provider/OAuth、人工 UI/Finder。node2/node3/yzhang 组按用户要求 deferred，本轮未覆盖。终端 failed→exited 精确竞争已在 `10f979bc` 修复并通过原压力检查；历史失败及各版静态资产证据保留，最新限定结果见文末。

## 后续门槛

本轮 T14/T15 的功能全量绑定 `d9b5d776`；当前主线整合 `03da779e` 的限定交叉检查、生产 gates 与本地合入 `a70d403b` 另行绑定，组合未重跑全库。已交付的专家/恢复功能不重派；后续继续完整 T11 通道、T16 实机及 T18 稳定周期，保持原任务编号。默认 RPC 仍须 `PHI_REMOTE_OMP_RPC=1`，专家仍须 main 可信具名选择；未启用不把旧远程历史静默迁移到本机执行。

只有完整模型通道、真实宿主服务、主/子审批、严格恢复以及 R8 实机共同通过，才讨论默认切换。冷 SDK 子任务的中断/终态来源 metadata、D5 新会话上下文与 Wrapper 独立 job 恢复不能相互冒充；禁止隐式重放或用模拟对象冒充完整 SDK session。

### 历史入口边界（3423a650 当时范围）

以下原文保留旧批次的验收边界，其中 read/write/bash 与完整能力待接入指该旧版本，不覆盖本轮当前状态：

`3423a650` 已把原有 facade 接入实际主进程和 runtime-adapter：`PHI_REMOTE_OMP_RPC=1` 显式选择 RPC，`PHI_REMOTE_OMP_AGENTS` 按名字选择主进程目录中的完整专家定义，renderer 定义不能授予权限。实际 CLI 验证可信 Checker 写入、审批中停止和迟到批准、异步选择的过期/取消，以及新实例恢复同 journal 且不重放请求。专家控制范围仍为 read/write/bash；环境、skills、警告或其他工具的专家定义，以及未经主进程可信快照授权的配置明确拒绝；主会话 MCP/skills 现沿上文 T12 的可信选定资源接入，模型/思考控制及默认策略沿 `365b2db` 接通，压缩沿 `eea33bd3`、persona/context/记忆及公共控制沿 `9f723379` 接通。未启用时保留本地和旧远程路径。关闭报错曾跳过选定连接释放，原失败已保留并修复；次要释放错误不替换原错误，重复释放仅执行一次。facade 现为 1160 行，作为临时 legacy 例外保留同一代次的 adoption/验证/关闭所有权，结构判断见 T13 压缩增量。

生产远程能力默认开放前，需要同时具备完整模型通道、真实宿主服务、主/子权限与审批、严格持久恢复及 R8 实机结果；当前实际应用接线只验收上述受控范围，不代表 T11–T15 全部完成。禁止远端失败后回落到本地执行、隐式重放中断 prompt 或用模拟对象冒充完整 SDK session。已按用户新授权合入本地 main；后续真实服务器验证和默认启用仍是独立门槛。

## T11 history 与 T16 前置增量（2026-10-15）

| 范围 | 本轮结果与证据边界 |
|---|---|
| T11 history | `.omx/T11-history-parity-freeze.json` 的三例实际官方 SDK/CLI + 合成 loopback 通过：冷 CLI 同 journal、Anthropic/Responses 迁移及 stateful Responses、Google/Bedrock 迁移。随后补五项隔离断言，`.omx/T11-history-parity-assertion-freeze.json` 只记录 vendor/KV 1/1 复验（用例 1031.727 ms，runner 1389.932 ms，自然退出）；新 runner 哈希 `61ebf01c0b7a9572b2253cd8d719d1e786984c62e86c45f2b3edd31fb185fd2c`。helper 哈希 `d699132f954cff9c4c9f2667feca0afc0d8b47a65bdf532a907f155246469f35`；其余两例测试体未变的证明保留，没有在新 runner 上重跑。补断言后的单 vendor/KV runner 约 1.390 秒。定向类型/lint/格式均通过；不冒称本轮全库。 |
| History / KV 限制 | 真实 SDK 请求证明 Responses previous_response_id/delta 和分支不匹配时完整 replay，不证明外部 vendor 的 KV 命中、算力复用、计费或延迟。冷重启只重启官方 CLI、保留 fixture HOME 与既有桌面 gateway lease，不是重启桌面网关或持久 KV 导出/导入；不宣称 Codex SSE 的 previous_response_id 链式续接。 |
| 辅助 opaque | `.omx/T11-compat-upstream-audit.md`：锁定 18.10.3 和官方 18.11.0 固定提交 `c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4` 的关键 projector 相同；网关补稀疏 delta 不会补出 SDK 缺失的 opaque 消费分支，仍需上游 canonical native / 无损 projector 或公共全通道接缝。没有升级/修改 SDK、全局 patch 或禁用默认维护；完整 T11/R3 未关闭。 |
| T16 终端 | 已合入 main `10f979bc`；failed 后的清理 exit 不再覆盖失败终态，正常 shell exit 保留。生产仅三行 guard（两注释、一条件），原 15/15、未改压力脚本五阶段退出 0，68.318 秒，独立 APPROVE。`.omx/T16-terminal-stress-after-failure-guard.json` 所列源码哈希运行前后稳定；原 PID/进程/内存/延迟/期限断言保留。primary build/types/lint/asar 各退出 0，自有两路径哈希稳定；同期两处其他 UI 变化只限制全树稳定性声明。历史失败仍保留，仅关闭该精确竞争。 |
| GPU 官方资产 | 先前只读预检确认 Linux/x64、glibc 2.35、flock/hash、ext4、无 noexec、约 144 GiB 可用；随后实际安装官方 18.10.3 到 `/home/dengxsh/.phi/runtime/omp/18.10.3/omp`，隔离 HOME 执行确认版本，40.824 秒，测试 cleanup=true。receipt：`.omx/T16-gpu-private-state/t16-30e7b919-df9f-4bd5-ac63-4b9750685225.json`。只证明该安装和版本执行，不扩大为完整科学环境或 R8。 |
| GPU RPC foundation | 真实 SDK session `01a13f6c-92a9-77bb-8583-d79c5196c095` 完成 attestation/get_state/stdio close，64.557 秒；agentInvocations=0、未发普通 prompt、未做用户 Phi adoption、测试 cleanup=true。bundle `d670fd16d55e085913365c851b00021e563f896ea64050156c2f2f57ea83c8f9`；receipt `.omx/T16-gpu-rpc-smoke.t16-rpc-88b7b417-fcf1-46bd-b9f7-ffcb6ac39f9a.json`。仅无 provider 的 foundation，不是完整 R8 读写/Bash、Notebook/Wrapper、adoption、provider/OAuth/Finder 验收。 |
| Cursor 子任务 | 最终实际结果：最终生产 bundle `f964cf799034b298411610e7dd6e4aabc20e94ee4520089b086b3bfd8e25af7a` 的实时停止、排队恢复前停止、后台控制 3/3 自然退出通过（18.561/18.701/26.847 秒），29 个组合文件与当时 HEAD `c136ec4a` 前后稳定。排队场景另用只读出队观察包 `af34ad32`，真实 SDK child verified/aborted，原 EOF/partial 日志如实保留、恢复消息未投递、下一明确 Main 无旧恢复请求；实时停止仍要求实际 journal aborted。依据 `.omx/T11-cursor-final3-receipt.json` 及独立最终审查。旧 d670 范围的 text/repeat/tool/parallel 与 later-Main negative 保留其版本绑定，没有把这些结果迁成 f964 全八例重跑。此前 Node 纯组范围为 6 生产文件 + 4 纯测试文件（10 路径）；原三项红例在修复后的 42/42 纯组中通过，末次常量整理后仅定点 3/3 再验，定向类型/lint/格式通过。纯测试不代替最终实际场景，既有主通道断流验收不替代子任务停止/排队停止。 |
| 最终 bundle 的停止限定验证 | 产品 bundle `f964cf799034b298411610e7dd6e4aabc20e94ee4520089b086b3bfd8e25af7a`，66 文件；原 stream stop 18.561 秒、queued stop 18.701 秒已通过。queued 场景透明 observer 独立记录（哈希前缀 `af34ad3281…`），不与产品 bundle 混称。旧 `d670` 四个正常场景与 later-Main negative 等保留旧版本范围，不冒称 `f964` 全八例重跑；最终后台结果仍以 Cursor 最终 receipt 为准。 |
| GPU 公共模块探针 | 官方 compiled CLI 上的诊断 bundle `baac72ac1f5ba29f27ccf6c3d1bba36b50c44f7f2393c2282697e1ebb5ea1d03` 证明 sameRegistry/lifecycleRelease/USER_INTERRUPT_LABEL 均 true，agentInvocations=0，64.366 秒、测试 cleanup=true。receipt：`.omx/T16-gpu-queued-module-probe.t16-public-module-4308a3f6-1ad6-4f73-acd1-64315a460963.json`。它只是公开模块同实例诊断，不是最终产品 bundle 或完整 R8。 |
| GPU 最终 foundation | `f964` 产品 bundle 的最终基础验证：最终生产扩展 `f964cf79` 另在 GPU 完成真实 attestation/get_state/物理关闭与清理，61.202 秒、agentInvocations=0、无用户 Phi adoption。receipt：`.omx/T16-gpu-rpc-smoke.t16-rpc-1ea1d722-9f51-40e3-bceb-2dbfb313563b.json`；29 个冻结文件与当时 HEAD 稳定。该结果仅为无 provider 的最终扩展/RPC 基础验证，完整 R8 仍未覆盖。仍不代替完整 R8、普通模型、工具/审批、Phi adoption 或外部服务/UI/Finder。 |
| 独立打包运行检查 | standalone packaged worker/native/捆绑 runtime/resize：同一整合候选的目录打包及独立打包终端检查均退出 0（54.58 秒）；在仓库外临时应用和隔离 HOME 中验证包内运行时、真实 native 加载、输入回显及 113 列×37 行缩放，资源引用和 2704 个跟踪文件前后稳定。依据 `.omx/T11-T16-package-smoke.json`；未执行 Electron/Finder 交互启动验收。不据此声称 Electron/Finder 启动或人工 UI 通过。 |
| 用户暂缓的服务器组 | node2/node3/yzhang 按用户明确要求暂缓（deferred），本轮不继续尝试；记为未覆盖，不计功能失败、不阻塞 GPU，也不宣称完整双主机 R8 通过。 |

冻结的停止合同：执行权限立即撤销并拒绝新模型请求，已在途模型独立等待真实 terminal 或对应取消尝试完成（成功、拒绝或 timeout）再清理；传输清理不把拒绝/timeout 冒充停止成功。停止先真实 cancel 已知原生子实例，按精确父 ledger 承接迟到启动，再收齐封闭派发、全部真实 ACK/aborted，原 10 秒期限不变，避免先等派发封闭再取消的互相等待。Cursor 续答复用公开 `Agent.followUp` 进入原 child 队列，保持原已完成工具不重放合同。

公开 queued 取消合同：仅 official cancel 明确返回 false，且当前记录仍是已 verified 的活跃 owned queued Cursor，才允许原 signed control 的新 action `cancel_queued`；原 11 字段及预算不变。复用 SDK 公开精确 registry/agent-lifecycle 与 canonical `USER_INTERRUPT_LABEL`，捕获原 ref/session 和真实私有 queue nonce，每次 await 前后复核；真实 release 与 abort 均 settled，且原 ref 实际 aborted、session=null 后才 ACK。Node 仍等待实际 SDK aborted，执行和模型权限都不恢复。Sub-local 私有 scope 查询是跨 factory 的只读能力；真实 publish/revoke 静态核对及新 queued actual 支持该组合结论，独立 Map 纯测仅算 helper unit。公开 import 只新增两项精确文件 allowlist，总计 47 项，不使用 wildcard。

结构判断：`rpc-subagents.ts` 746 行保留，同一 Sub state/active/profile/teardown 内聚，复用原权限谓词而不复制；`subagents/production-child-runtime.ts` 611 行保留同代 ledger/ACK/teardown。remote runtime 1288 行延续原 1284 行的临时 legacy 例外，只作必要透传，不夹带大入口拆分。

以上证据分别绑定其冻结源码与具体执行范围，不相加成全量、不覆盖旧版本验收。T12–T15 继续复用；真实 provider/OAuth/MCP、人工 UI/Finder 和完整 R8 仍保留原门槛。RPC 默认关闭，T18 须待新路径完成 T16、默认切换并稳定一个升级周期。


## T16 GPU 实际 App 闭环与 node3 登录诊断（2026-10-16）

实际链路复用 App installer、runtime-adapter、SessionRunner、审批持久 writer、远端存储 adopter 与真实 SshHost，没有替换成 direct facade 或 local fake SSH。此前实际 workspace 创建的 Host 平台为 remote/unknown，夹具预先注入平台而遮住部署阻断；本次复用原 fast stdin probe/parser，只把真实平台传给 project/runtime 两个 Host，不扩大工具链权限，不增加依赖或 SDK 修改。保留 fast 10 秒、root 30 秒及每场景 120 秒预算。

| 实际场景 | 本次冻结结果 |
|---|---|
| 读 → 写 → Bash | 真实 GPU 文件效果、本机 anchor 无执行效果；provider 请求 4。write、bash 各有独立 approvalId，分别 requested→approved，一共 4 条唯一持久事件。 |
| 显式同 journal 恢复 | 新代次保留原 OMP ID、journal 与公共历史；恢复本身 0 provider 重放；随后明确 read→final 产生 2 次新请求并读取 GPU 原产物。 |
| 拒绝 | 真实 Runtime/Runner failed，requested→denied 唯一；GPU 与本地目标文件均不存在。实际 provider 请求 2，不写成拒绝后 0 模型请求。 |
| 待批停止及迟到批准 | stopped，requested→cancelled 唯一，迟到 allow 未发布批准或执行写入；GPU/本地目标文件 0 效果，provider 请求 1。 |

固定 OMP 18.10.3、扩展 bundle `f964cf79`；4/4 自然退出 0，8 个私有 operator 文件与 2704 个跟踪文件运行前后哈希稳定，当时 HEAD 为 `b64b5fc0`，其中两处平台修复字节与源码提交 `e62d22cc` 一致。4/4 reverse tunnel 关闭、4 个代次目录和自有测试根目录删除。包含合成模型数据的真实 SDK journal 与隔离本地审计 store 按计划保留，不冒称所有审计数据删除。最终 receipt：`.omx/T16-gpu-workflow-final-receipt.json`（SHA256 `f8ec22ae45daa4ee5a5c80fbdb306b12cbb7bff2456bf5d930edafb69711c941`）；生产检查绑定 `.omx/T16-workspace-candidate-gates.json`，未重跑当前全库。

此前 node3 只读登录诊断经用户重新授权完成：交互登录认证成功，Ctrl+C 后得到可用提示符；独立无 TTY 的输出标记也在 9.732 秒成功，stdout 无额外内容。当前启动链包含 `.bashrc` 的系统 profile、Conda hook 与 brew shellenv，交互分支再进入 Zsh 的 Conda 初始化；单独 hook 测量为 Bash 7.656 秒、Zsh 0.920 秒、brew 0.910 秒。该结果支持启动链慢/有波动，不能唯一归因此前的 20 秒超时，也不说明自动 SSH 必须使用 TTY 或注入 Ctrl+C。该诊断阶段没有修改远端启动文件或恢复安装/工作流；后续受控授权与部署结果见下节。

另观察到 zsh history 的 `disk quota exceeded` 告警；共享盘整体用量 7%、inode 用量 1%，quota -s 未报告用户配额，告警原因未闭合，不据此声称整盘满或配额已修复。只读证据在主工作区 `.omx/omp-recovery/pm/reports/T16-node3-startup-readonly-2026-10-16.json`。完整 R8 的 Notebook/Wrapper、子任务/其余科学工具、真实 provider/OAuth、人工 UI/Finder 仍待验证；T11 opaque、默认 RPC 开关和 T18 门槛保持原状态。


## T16 科研闭环与受控验收增量（2026-10-16）

三项产品窄修已独立审查：`81ab246c` 保留可信环境所选 channel 的次序和空列表的既有默认；`ed7cd6a6` 让已知 starting 的同一 Notebook kernel 接受首个执行，保持互斥、停止及未知状态拒绝；`d7730679` 在原启动预算内串行发布子任务文件并最后发布 sidecar。publisher 四文件夹具的 metadata 往返为 9→3；后续同源真实阶段诊断也确认 3 个 metadata 命令、4 次资源上传全部完成，发布窗口 5.554 秒。该实证不等于整个 attach 成功，见下文。三项已审修复已本地 fast-forward 合入 main `db18ec7c`，自有产品字节与 index 已核对、其他工作保留，未推送；该固定候选生产类型/构建、asar、完整 lint 通过（80.39 秒，2715 跟踪文件、HEAD/tree 与共享资源稳定）；该候选标准全量尚未执行。

同一 `db18ec7c`、官方 OMP 18.10.3/产品 bundle `f964cf79` 的真实 GPU Notebook 3/3 自然退出 0：执行并保存 55.831 秒；同 journal 新代显式恢复/读取 58.279 秒，恢复不重放、执行计数不变；所属 kernel 停止及 live peer 105.582 秒，物理 interrupt 已结算、peer 可继续执行/保存、无迟到磁盘副作用或本机回落。4/4 隧道、4 个代次目录、自有 Jupyter 与测试根清理确认，2715 源文件和 10+3 私有/复用文件哈希稳定。原 13927 批次的 Notebook author/save 两场景保留其版本范围。默认 OFF 的真实 GPU legacy read/edit/bash 与精确历史恢复另验通过；本地自动及手动压缩第二轮通过，正 usage 明确为合成估算且首红保留；80 MiB 真实 SSH 上传在持久 checkpoint 后 caller 取消、同 ID 续传并独立核最终 SHA，通过且自有清理确认。这些结果互不冒充完整 R8、随机断网或真实厂商计费证据。

原双主机门仍未闭合：`db18ec7c` 的原 child-enabled R8 在初始 attach/adoption 超时（50.982 秒，0 完成场景、源码稳定及 cleanup=true），原首红之后的阶段诊断已实证上述发布完成，并观察到真实 RPC ready 和 bootstrap attestation；attach 在后续确认时超时，0 ordinary prompt。具体后续确认原因仍待定位，诊断不代替原场景成功，也不签启动修复验收。node3 经用户恢复受控授权后，官方 binary 18.10.3/隔离版本已通过，extension 在原 900 秒期限超时；物理连接已关闭，但探针/测试根回收未确认，保留待回收，不能签运行时 ready。services 第四轮在 `env_request` 明确拒绝断言失败，实际为通用 host result delivery error；原红及源码/清理证据保留，待诊断，不倒签整轮或先前零完成场景为通过。

13927 打包 GUI 的已配置 Cursor 短文本真实请求成功；DeepSeek 余额不足、Moonshot 404 为失败观察，Cursor 的 API key/OAuth 路径未单独 attest。终端中文 paste、40×36→40×59 实际拖动、collapse 保留输出及正常退出后的自有进程消失已确认；完整 IME、有效模型 draft/解释及 fresh OAuth 仍未验。阶段性本地证据索引为 `.omx/omp-recovery/pm/reports/T16-current-evidence-ledger.json`，应与后续原始 receipt 一起核对；该索引及 `.omx/` receipt 当前为 gitignored 私有审计资料，不作为仓库长期分发附件。T16 保持 partial，增量合入不构成关单；T11 opaque、RPC 默认 OFF 与 T18 稳定周期门保持原状态。
