# Phi 应用内终端第一版实现计划

日期：2026 年 10 月 1 日  
交付目标：本地手动终端及 Agent 辅助命令草稿  
状态：实现计划，尚未开始功能开发  
修订：2026 年 10 月 3 日，按浏览器面板、运行时基础与 bun 迁移合入后的代码重新核对

第一版让用户在 Phi 内打开真实 Shell，直接输入命令、查看输出、调整面板大小和中断程序。Agent 可以帮助生成命令及解释用户选择的输出；生成的内容先进入可编辑草稿，只有用户明确操作后才发送到终端。默认界面接近用户提供的参考图：一个简单标题栏和一块终端区域。

本计划以当前仓库为基线，沿用现有右侧终端入口。先交付 macOS 本地闭环，保持后台聊天与手动终端的生命周期独立。SSH 终端、Agent 接管输入以及已有命令执行器的全面统一放到后续增量。

## 产品要求与交付边界

### 第一版必须实现的能力

| 能力           | 用户操作                                      | 明确结果                                                   |
| -------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 打开终端       | 点击现有右上角终端按钮                        | 显示当前工作区的终端，首次打开时创建一个本地 Shell         |
| 手动执行       | 在终端中输入命令并按 Enter                    | 命令通过 PTY 在本机执行，输出和交互提示实时显示            |
| Shell 状态保持 | 连续执行 `cd`、`export`、环境激活及下一条命令 | 同一终端中的工作目录、环境与 Shell 状态持续存在            |
| 新建终端       | 点击标题栏的加号                              | 在当前工作区新建独立 Shell，并切换到它                     |
| 切换终端       | 多个终端时点击标题或选择器                    | 显示目标终端，其他终端继续运行                             |
| 调整大小       | 拖动已有面板分隔线或点击放大按钮              | 终端列数和行数随可见区域变化，进程保持原身份               |
| 收起面板       | 点击标题栏的关闭按钮                          | 隐藏面板，Shell 和已运行程序继续存在                       |
| 中断与结束     | Ctrl+C；或菜单中的结束终端                    | 分别中断前台程序及关闭整个终端，二者语义不同               |
| 命令辅助       | 选择“帮我写命令”并描述需求                    | 返回可编辑命令草稿、简短说明和必要的待填参数               |
| 草稿提交       | 用户审阅后点击“发送到终端”                    | 确认目标终端后发送；模型完成、切换工作区和粘贴均不触发提交 |
| 输出辅助       | 选中终端文本并选择“让 Agent 解释”             | 用户确认所选内容后，生成解释或后续命令草稿                 |

手动终端由用户持有。聊天 Agent 现有的 Bash 执行与审批机制继续按已有规则运行；本版不向 Agent 注册用户终端的输入、结束或修改尺寸工具。

### 第一版的平台范围

- macOS 是本轮验收平台，重点验证系统 zsh、用户 Shell 配置、中文输入和 Conda 初始化。
- Linux 可以沿用 POSIX 后端，但未经对应真机验证时标明未验证，不能宣称已支持。
- Windows 不通过 POSIX 模拟实现；PTY 后端未通过 ConPTY 验证时明确显示暂未支持。
- 远程项目的终端面板显示“远程终端将在后续版本支持”，不在远程项目的本地私有锚点目录创建 Shell，也不自动切换为本地终端。

### 后续版本的能力

后续增加 SSH PTY、用户查看或接管 Agent 执行终端、可查询的命令完成状态，以及长期进程与后台任务面板的关联。第一版不包含自动运行 Agent 草稿、分屏、复杂终端设置页、跨应用重启恢复 PTY、常驻服务托管或新的终端审批规则编辑器。

本地手动输入 `ssh host` 可像普通系统终端一样使用，但这不等同于 Phi 已具备远程项目终端管理能力。

## 已核实的仓库现状

以下位置是实现入口，行号仅用于定位本计划编写时的代码；开始实施时应重新确认附近内容。

| 编号 | 已核实事实                                                                                                          | 文件与位置                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | 右上角已有终端开关，右侧工作区面板可以切换模式                                                                      | `src/renderer/src/App.tsx:312`、`:2627`                                                                                                      |
| E2   | 当前终端只是占位卡片；右侧容器在 jobs 与 browser 模式消费 children，browser 模式去掉内边距                          | `src/renderer/src/components/WorkspaceSidePanel.tsx:93`、`:122`                                                                              |
| E3   | 侧面板模式已包含 jobs、terminal、browser，有切换测试                                                                | `src/renderer/src/lib/workspaceSidePanelMode.ts:1`；`tests/workspace-side-panel-mode.test.ts:5`                                              |
| E4   | 默认侧面板宽度 340，现有拖动范围为 240 至 520                                                                       | `src/renderer/src/App.tsx:205`、`:2641`                                                                                                      |
| E5   | 当前工作区可以取得项目身份、本地工作目录和远程位置                                                                  | `src/renderer/src/App.tsx:638`；`src/main/index.ts:636`                                                                                      |
| E6   | OMP 运行在 Bun 子进程；请求与事件通过桥接传递                                                                       | `src/main/agent/omp/omp-bridge.ts:126`、`:160`、`:187`                                                                                       |
| E7   | OMP 桥接会跟踪运行时聊天会话；直接复用其生命周期需要处理空闲停止与崩溃                                              | `src/main/agent/omp/omp-bridge.ts:138`、`:238`、`:275`                                                                                       |
| E8   | 当前 OMP Bash 交互 PTY 要求其自己的 UI 上下文，缺少时退回普通执行                                                   | `node_modules/@oh-my-pi/pi-coding-agent/src/tools/bash-pty-selection.ts:10`；`node_modules/@oh-my-pi/pi-coding-agent/src/tools/bash.ts:1448` |
| E9   | OMP 已有后台 Bash 的列出与取消接口；UI 已有后台任务面板                                                             | `src/main/agent/omp/omp-sdk-worker.ts:1760`、`:1781`；`src/renderer/src/features/jobs/BackgroundJobsPanel.tsx:75`                            |
| E10  | 远程 Bash 明确拒绝 PTY 与后台执行                                                                                   | `src/main/agent/remote-workspace-bash.ts:92`                                                                                                 |
| E11  | 现有 preload 采用具名 API 和可取消的事件订阅                                                                        | `src/preload/index.ts:994`、`:1001`；`src/renderer/src/types.ts:703`                                                                         |
| E12  | Notebook 已有无工具的临时模型生成模式，可复用调用原则                                                               | `src/main/index.ts:3936`、`:3976`、`:4005`                                                                                                   |
| E13  | 主窗口关闭与应用退出共用 `cleanupMainWindowRuntime()` 清理屏障；before-quit 等待它，浏览器注册表已接入              | `src/main/index.ts:498`、`:6076`、`:9030`                                                                                                    |
| E14  | Worker 源码及依赖由构建插件复制；新增独立 Worker 需要明确打包                                                       | `electron.vite.config.ts:6`、`:44`；`electron-builder.yml:16`                                                                                |
| E15  | 页面和嵌入面板应位于 feature 目录，大文件需要明确拆分判断                                                           | `docs/architecture/frontend-feature-boundaries.md:9`、`:64`；`AGENTS.md`                                                                     |
| E16  | 内测优先稳定的本地工作台、可恢复历史和有界输出，暂缓公开分发与复杂界面；终端列为 P1 In-App Terminal                | `docs/roadmap/internal-beta-implementation.md` 的 P0、P1 和 Deferred 部分                                                                    |
| E17  | 已安装原生库公开 `PtySession.startArgv/write/resize/kill`，有启动 PID 回调及退出 Promise；公开声明没有 pause/resume | `node_modules/@oh-my-pi/pi-natives/native/index.d.ts:273`、`:315`、`:327`                                                                    |
| E18  | 同包有稳定进程引用及进程组终止参数；OMP broker 已实际采用该调用模式                                                 | `node_modules/@oh-my-pi/pi-natives/native/index.d.ts:2335`；`node_modules/@oh-my-pi/pi-coding-agent/src/launch/broker.ts:720`、`:1153`       |
| E19  | 原生包要求 Bun 运行环境，包含平台可选二进制；当前声明与调用模式尚未经过本功能真机验证                               | `node_modules/@oh-my-pi/pi-natives/package.json:57`；`node_modules/@oh-my-pi/pi-natives/README.md:58`                                        |
| E20  | `pi-natives` 不是 Phi 的直接依赖，经 `@oh-my-pi/pi-coding-agent` 间接安装；`asarUnpack` 只解包 OMP Worker           | `package.json`；`electron-builder.yml:19`                                                                                                    |
| E21  | 应用退出时整体清理只等 2 秒，超时直接退出                                                                           | `src/main/index.ts:419`（`APP_QUIT_CLEANUP_TIMEOUT_MS`）、`:6076`                                                                            |
| E22  | Phi 启动时向自身进程环境写入 `PI_CODING_AGENT_DIR`；原样继承会让终端里的 omp/pi CLI 共用 Phi 配置目录               | `src/main/agent-env.ts:5`                                                                                                                    |
| E23  | 浏览器面板已按 feature 落地：主进程注册表、IPC 精确字段校验、requestId 缓存、清理与 Renderer 控制层，可作结构样板   | `src/main/browser/`（`browser-ipc.ts`、`browser-workspace-registry.ts`、`browser-workspace-request-cache.ts`）；`src/renderer/src/features/browser/` |
| E24  | 浏览器工作区按 Phi 会话归属，切换聊天即切换浏览器工作区                                                             | `src/main/browser/browser-workspace-registry.ts:133`；`src/renderer/src/features/browser/hooks/useBrowserWorkspace.ts`                      |
| E25  | 运行时基础的 L2 执行原语使用净化后的白名单环境，并与用户 conda 隔离                                                 | `docs/design/phi-runtime-foundation.zh-CN.md` §2.2、§4.1                                                                                     |

E8、E14 是后端选型的重要约束：存在 PTY 代码并不能证明桌面可直接连接，开发模式可运行也不能证明安装包可运行。E21 是清理设计的硬约束：终端清理不能假设退出流程会等待超过 2 秒。

终端已列入内测路线图的 “P1: In-App Terminal”（E16），后续增量列在路线图的 Deferred 部分。本计划范围变化时同步更新路线图条目。

## 界面与交互设计

### 参考样式

参考图随本计划保存在 [terminal-v1-reference.png](terminal-v1-reference.png)。图中的 Shell 提示符、Conda 环境和 Git 信息由用户的 Shell 配置产生，Phi 不伪造这些内容。

默认标题栏按以下顺序排布：

```text
Terminal   +                                  放大   ×
──────────────────────────────────────────────────────
真实 Shell 输出与提示符
可直接输入的光标
```

- 默认只有标题栏和终端正文，不常驻大卡片、统计区、运行按钮或帮助文字。
- terminal 模式沿用 browser 模式的接法：`WorkspaceSidePanel` 直接渲染 feature children，去掉容器内边距，由终端面板自行控制标题栏与正文留白。
- 保留右侧位置及现有宽度调整方式。放大后覆盖主工作内容区，保留应用导航，恢复时回到之前宽度；这不是操作系统全屏。
- 容器使用细边框与约 16 px 圆角；正文背景、前景和 ANSI 色来自当前主题。暗色接近截图，浅色维持可读对比。
- 标题栏高约 44 px；正文四周留 12 px；等宽字体起始 13 至 14 px。参考图比例仅作为视觉方向，不按图片尺寸固定布局。
- 只有一个终端时不显示标签栏。多个终端时标题旁出现紧凑选择器，默认名称为 Terminal 1、Terminal 2。
- 加号、放大与关闭均有 tooltip 和可访问名称，点击区域不小于 28 px；终端输入区与按钮都设为 `no-drag`。
- 项目和初始目录显示在标题 tooltip 或菜单内。首版不把初始目录标成“当前目录”，因为用户和 Shell 配置都可能执行 `cd`。
- 长期保持滚屏，但用户向上滚动或选中文字后停止自动追尾；回到底部才恢复。

### 关闭与结束的语义

| 操作                           | 结果                                           |
| ------------------------------ | ---------------------------------------------- |
| 标题栏 ×；再次点击右上终端开关 | 收起面板，保留所有终端                         |
| 切到后台任务或浏览器面板       | 隐藏终端，保持进程与屏幕状态                   |
| 切换项目或聊天                 | 显示新工作区的终端列表，旧工作区继续运行       |
| Ctrl+C，无文本选择             | 转发终端控制输入，由 PTY 和 Shell 中断前台程序 |
| Cmd+C，有文本选择              | 复制选择，保留前台程序                         |
| 终端菜单中的结束终端           | 展示一次结束确认；确认后关闭 PTY，执行有界清理 |
| 终端菜单中的结束全部           | 明确显示影响数量，确认后只结束当前工作区终端   |
| 用户关闭主窗口或退出 Phi       | 执行统一清理；macOS 重开窗口不会复活旧 PTY     |
| Shell 自行 `exit` 或启动失败   | 保留结果界面，显示退出或错误状态，提供新建按钮 |

首版不尝试根据输出静默、提示符样式或进程存在来推断当前命令已完成。终端的“已启动”只说明 PTY 存在，不意味着任意子命令已经成功。

### Agent 辅助

“帮我写命令”放在终端标题的菜单或右键菜单中。用户主动打开时，在面板底部显示临时草稿区域：需求输入、命令编辑框、简短说明、复制、发送到终端和取消。

流程为：

```text
用户描述需求
    ↓
没有工具权限的模型调用
    ↓
结构化命令草稿及必要的待填参数
    ↓
用户编辑并检查目标终端
    ↓
用户明确点击发送到终端
    ↓
命令进入目标 PTY，用户查看实际结果
```

实现规则：

- 生成中、生成完成、恢复草稿、切换终端和收到模型流式片段均不能发送终端输入。
- 模型只能获得用户需求、目标 Shell 类型、项目名称、初始目录及用户主动附加的文本；不自动读取整个终端、环境变量或聊天历史。
- 一次生成返回命令、说明及待填参数。参数未填完整、模型不可用或响应无效时禁用发送，保留可复制内容。
- 不运行命令来“验证”生成结果。语法和结构校验不调用 Shell。
- 草稿绑定 `terminalId` 与工作区。生成结束时，即使用户已切换项目，也只更新原草稿；不改写当前工作区输入。
- 发送前重新显示目标终端。Shell 可能正在 REPL 或其他输入程序中，因此文案使用“发送到终端”，不把 PTY 接受输入当成命令执行成功。
- 请求发送时必须看见目标终端；若存在未知的待输入文字，用户先明确选择“我已准备好接收此命令”。Phi 不发送 Ctrl+U 清除输入，也不隐式 Ctrl+C 中断程序。
- 多行草稿先完整显示。仅在用户确认发送后写入，符合 Shell 的 bracketed paste 行为并明确提交；后端只保证输入到达，不保证 Shell 立即执行。
- 草稿发送是一个不可交错的输入事务：粘贴起始、完整内容、粘贴结束及提交字符作为一个串行操作处理。提交期间的新键盘输入排在事务之后；不能分开使用多个无关联 IPC 写入。是否使用 bracketed paste 根据终端实际模式决定，不假定每个前台程序都支持它。
- 普通多行剪贴板粘贴先进入同一预览区；通过 xterm 输入通路的 paste 事件需要拦截，不能绕过预览。单行粘贴维持系统终端体验。
- “让 Agent 解释”仅发送用户选中的内容，先允许编辑或移除；首版生成解释与后续草稿，不直接启动主聊天 Agent 的自动工具执行。
- 每个窗口最多一个辅助生成请求；可取消，超时显示错误。完成、失败和取消都释放临时模型会话。普通聊天、Notebook 及终端辅助的并发资源计数应在实施时核对，不新增无限并发入口。

手动 Shell 的输入和输出可能包含敏感信息。用户未选择发送时，终端内容不会进入模型上下文。

## 后端方案与技术边界

### 架构选择

推荐由 Electron 主进程持有终端注册表和可信工作区解析，独立 PTY Worker 持有实际终端。Renderer 负责显示与输入，preload 暴露有限接口。命令生成服务只能返回草稿，不能取得 PTY 写入能力。

```mermaid
flowchart LR
    UI[TerminalPanel 用户输入] --> API[preload 具名接口]
    API --> IPC[主进程身份与工作区校验]
    IPC --> Registry[TerminalManager 注册表]
    Registry --> Host[独立 PTY Worker]
    Host --> Shell[用户本地 Shell]
    Shell --> Host
    Host --> UI
    AI[无工具模型调用] --> Draft[可编辑命令草稿]
    Draft --> Confirm[用户明确发送]
    Confirm --> API
```

上图中的输出实际经过 Worker 桥接、主进程与 preload，不能由 Worker 直接访问 Renderer。

后端优先直接适配已安装的 `@oh-my-pi/pi-natives` 18.1.10 的公开 `PtySession` 和 `Process`，使用独立 Bun Worker 以保持与现有依赖运行环境一致。E17 至 E19 已证明声明与 OMP 使用模式存在，但没有证明本功能已能在真实应用中运行。复用底层原语，不把手动终端加入 OMP 的聊天会话表，也不让模型运行时的空闲停止影响手动 Shell。

启动调用使用 `PtySession.startArgv()`。收到 `onStart` 并登记 PID 后返回创建结果，持续保存整个退出 Promise 并处理 rejection，不能等待长驻 Shell 退出才返回创建响应。终端原始输出只交给 xterm；不同时启用 OMP broker 的 `TerminalQueryResponder`，避免两个响应者向同一终端写入查询回复。

前端建议使用 `@xterm/xterm` 与 `@xterm/addon-fit`。这些是拟议依赖，不是本轮已安装内容。仓库要求新增依赖具有明确授权；实施前需要核对现有授权及依赖清单，不能为了完成计划自行加入未授权包。

如果 OMP 原生 PTY 无法提供所需事件、输入、resize、背压或清理契约，则评估 `node-pty` 加独立执行宿主。不能只在工具结果文本外包一层假终端，也不能修改依赖包内部代码。后端选型在里程碑 T0 结束时锁定。

OMP `hub` 可以管理长期进程，但其项目共享语义、固定 120×40 尺寸和现有日志协议不是本版用户终端契约。第一版不改造它，也不重复接管其已有进程。

### 工作区与所有权

- 每个终端有随机、不复用的 `terminalId`；PID 仅由宿主管理，不接受 Renderer 提供的 PID。
- 用户终端按工作区分组。本地项目使用已登记 `projectId`；普通工作区使用主进程验证后的任务目录派生稳定分组。
- 同一项目切换聊天时仍看见该项目的终端；不同项目有独立列表和 Shell。进入项目后可以直接打开终端，不为此创建空聊天。
- 这与浏览器面板按 Phi 会话归属（E24）不同，是有意的差异：Shell 状态（cwd、环境激活、运行中的程序）属于项目工作目录，跟随聊天切换会让长任务“消失”。界面上在终端标题 tooltip 显示所属项目，切换聊天时不出现新建动画；普通工作区按任务目录分组，同样不跟随会话。
- 主进程从已有项目登记及应用配置解析路径，校验目录存在并取 `realpath`；创建请求只接受工作区引用，不接受任意 `cwd`、Shell 可执行文件或环境覆盖。
- 远程项目与远程私有锚点路径明确拒绝本地 PTY 创建，沿用 E5、E10 的本地与远程边界。
- 实际写入、resize、结束、订阅必须匹配创建时的主窗口 `webContents` 和终端归属；不能依赖此刻的全局选中项目来寻找目标。
- 删除项目或改变其根目录前，若有终端存在，提示结束受影响终端，或拒绝该操作并提供关闭入口。不能静默把原进程搬到新目录。
- 工作区之间的 Shell 独立不代表操作系统权限隔离。用户终端按当前用户权限运行，用户可以通过命令访问其他路径。

### Shell 与环境

- macOS 使用可信的用户 Shell 配置；验证可执行路径后启动交互登录 Shell，回退到系统 zsh 或 bash 时明确显示原因。
- 初始 cwd 是经过校验的工作区目录；不通过拼接 `cd path; command` 构造启动命令。
- 保留用户 Shell 初始化体验，包括 `.zshrc`、提示符和 Conda。启动配置本身可能运行用户命令，这是用户 Shell 的既有行为，不是 Agent 草稿的执行。
- 终端环境采用白名单，不从 Phi 进程环境做减法。只传入 `HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`LC_*`、`HTTP(S)_PROXY`、`NO_PROXY`、`SSH_AUTH_SOCK`，再由终端设置 `TERM`、`COLORTERM`、`TERM_PROGRAM=Phi`；`PATH` 只给系统最小路径，由交互登录 Shell 按用户配置重建。白名单参考 E25 的保留列表，但用途相反，见下一条。
- 明确排除 `PI_CODING_AGENT_DIR`（E22）、`MOONSHOT_BASE_URL`、`ELECTRON_*`、`ELECTRON_RENDERER_URL`、Provider 密钥、内部 RPC 令牌及 Worker 专用标记。用户在终端里运行 omp/pi CLI 时必须使用其自身配置目录，不能与 Phi 共用认证和会话存储。用户自身 Shell 配置产生的环境继续由用户控制。
- 用户终端不是运行时基础的 L2 执行原语：不激活 Phi 的 micromamba 环境，不受“与用户 conda 隔离”约束（E25），也不写入运行记录。它就是用户自己的 Shell 环境。在终端中使用 Phi 托管环境属于后续能力。
- 处理 UTF-8 与宽字符；语言环境不能为终端功能重写用户系统配置，`LANG` 缺失时才补 UTF-8 默认值。
- 终端 UI 和普通日志不记录输入按键；密码提示正常使用 PTY 的 echo 行为。开启 Shell 后不主动读取项目 `.env`。
- 原始终端输入不进行 Shell 包装或自动引号转换。发送前对大小、NUL 和异常控制字符做边界检查；草稿与手动控制输入使用不同验证规则。

### 生命周期与清理

终端状态采用 `starting → open → closing → exited`，任何阶段的宿主异常转为 `failed`。`open` 表示 PTY 可用，不描述前台命令是否繁忙。输入串行发送，重复关闭幂等，关闭开始后拒绝新输入。

默认最多 4 个终端每工作区、8 个每窗口。达到限制时显示具体数量与关闭入口，不排队也不自动结束旧终端。这是本计划提出的首版限制，可在真机验证后调整。

关闭分两种路径，因为应用退出只等 2 秒（E21）：

- **用户结束终端**：先停止接受输入并取消草稿生成，执行 PTY 后端关闭及已验证的进程组清理；先发 SIGHUP，2 秒宽限后升级为 SIGKILL，整个清理默认上限 5 秒。
- **关闭主窗口或退出应用**：不等宽限。所有终端同时停止输入，立即对已登记进程组发 SIGHUP，约 1 秒后对仍存活的进程组发 SIGKILL，整体在 1.5 秒内结束，给全局 2 秒上限留余量。不为终端提高全局退出上限。

终端清理作为 `cleanupMainWindowRuntime()` 的一个分支接入现有清理屏障（E13），与浏览器注册表、提示运行的清理并行，不新建并行的退出钩子。清理开始后终端注册表进入 disposing 状态，拒绝新建请求，做法同浏览器注册表的 lifecycle。并发关闭复用同一个 Promise，避免重入。超时未确认退出的进程组写入应用日志（只记 terminalId 和 PID，不记输出），不能显示“已全部结束”。

启动超时默认 10 秒，超时释放已创建资源，不把无输出当成启动成功。T0 必须明确后端是否只能验证 PTY 建立，还是能够验证 Shell 存活；首版不要求修改用户提示符来探测就绪。

用户终端默认与 Phi 主窗口共存：主窗口关闭时结束，重开窗口提供新建终端；不把 PTY 状态写进聊天 manifest。Shell 历史是否落盘遵循用户自身配置，Phi 不另外自动保存输入历史。

普通前台进程与后代的清理需要真机验证。刻意脱离终端的 `nohup`、`disown`、`setsid` 或调度器作业不承诺随关闭终止；不得对无法核验身份的 PID 进行扫描式强杀。此类长期任务继续推荐 Wrapper 或用户明确管理。

Worker 崩溃或通信卡住不能只把界面改成 failed。`terminal-host.ts` 负责存活监督，主进程注册表保留由创建回调产生的可信清理身份，并维护独立于 PTY 输出的清理路径。具体实现必须在 T0 锁定：优先验证宿主退出关闭 PTY 时的普通前台进程组行为；若不足，使用独立清理监督者，在创建时就登记稳定的进程引用或可验证的进程创建身份和进程组，不能等到崩溃后才盲目凭旧 PID 建立引用。

使用公开 API 的最小后备实现是每个主窗口一个独立 Bun 清理监督者，与 PTY Worker 分开。`onStart` 后立即在监督者中调用 `Process.fromPid(pid)` 并保留稳定引用，登记完成后才确认终端创建；关闭请求按 terminalId 路由并调用 `terminate({ group: true, gracefulMs, timeoutMs })`：用户结束时 `gracefulMs: 2000`、总期限 5 秒，退出路径按上文 1.5 秒预算传参。**T0 结论（见 [terminal-backend.md](../decisions/terminal-backend.md)）**：Worker 被强杀后 Shell 随 PTY master 关闭立即退出，但对已退出根引用调用 group terminate 不会到达忽略 HUP 的后代。因此监督者在 Worker 存活期间随心跳（每 1 秒）从可信根引用刷新后代的 `Process` 稳定引用集合，崩溃时终止根与全部已登记后代，绝不按 PID 扫描系统。保证范围相应缩小：崩溃前 1 秒内新建、尚未登记的后代不在保证内，文档与验收如实说明。Bun 原生库仍由 Bun 加载，不为监督逻辑假设 Electron 可直接导入。

监督协议使用不混入 Shell 输出的心跳：每 1 秒一次，连续 3 秒无响应开始故障处理；故障清理从识别起最多等待 5 秒（应用退出期间改用退出路径的预算）。故障时先拒绝新输入，将终端标为 failed，再通过独立路径结束已验证的受管理进程并回收 Worker。清理失败保留错误，不能显示“已全部结束”。如果原生后端无法通过进程身份校验及故障清理验证，T0 判定该后端不满足本版要求，不能带着无效保证交付。

## 接口与数据契约

新增契约放在 `src/shared/terminalTypes.ts`，终端功能通过独立 `TerminalApi` 交叉合并到已有 `RendererApi`，避免三处维护不一致的手写形状。命名、IPC 输入解析（精确字段集、按 UTF-8 字节限长、非法输入统一报错）和 requestId 缓存沿用浏览器的 `src/shared/browserTypes.ts`、`browser-ipc.ts`、`browser-workspace-request-cache.ts`（E23），能直接复用的工具函数提到共享模块，不复制一份。

以下类型是计划草案，T0 确认后端后补齐具体字段：

```ts
type TerminalWorkspaceRef =
  { kind: 'project'; projectId: string } | { kind: 'ordinary'; sessionId?: string }

type TerminalSnapshot = {
  terminalId: string
  workspaceKey: string
  title: string
  host: 'local'
  initialCwd: string
  shell: string
  state: 'starting' | 'open' | 'closing' | 'exited' | 'failed'
  createdAt: string
  cols: number
  rows: number
  exitCode?: number
  message?: string
}

type TerminalEvent =
  | { type: 'data'; terminalId: string; seq: number; data: string }
  | { type: 'state'; terminalId: string; snapshot: TerminalSnapshot }
  | { type: 'gap'; terminalId: string; resumeSeq: number }

type TerminalCommandDraft = {
  draftId: string
  terminalId: string
  workspaceKey: string
  source: string
  explanation: string
  requiredInputs: Array<{ name: string; description: string }>
}
```

`sessionId` 若传入仅用于验证普通工作区来源，主进程从已知 session 获取 cwd；不存在 session 时使用已配置任务目录。Renderer 不提供 `workspaceKey` 的权威值。

| IPC 接口                                      | 作用                 | 核心验证                                       |
| --------------------------------------------- | -------------------- | ---------------------------------------------- |
| `terminal:list(workspaceRef)`                 | 当前工作区终端摘要   | 主窗口、主 frame、合法工作区                   |
| `terminal:create(workspaceRef, cols, rows)`   | 创建 PTY             | 本地目录、数量上限、尺寸、重复请求去重         |
| `terminal:attach(terminalId)`                 | 连接输出与最新摘要   | 归属、订阅 epoch；返回重放起点与限制说明       |
| `terminal:input(terminalId, data)`            | 用户键盘及控制输入   | 归属、open 状态、单次字节限制、串行写入        |
| `terminal:submitDraft(draftId, editedSource)` | 用户提交完整草稿     | 归属、草稿目标、必填项、字符限制、重复提交去重 |
| `terminal:resize(terminalId, cols, rows)`     | 更新尺寸             | 归属、有效整数、20–500 列、5–200 行            |
| `terminal:ack(terminalId, epoch, seq)`        | 确认已消费输出       | 当前订阅 epoch、单调范围，拒绝越界 ACK         |
| `terminal:close(terminalId)`                  | 结束终端             | 归属、幂等、清理屏障                           |
| `terminal:generateDraft(request)`             | 生成命令草稿         | 目标、模型配置、有界上下文、可取消请求         |
| `terminal:cancelDraft(requestId)`             | 取消辅助生成         | 请求归属，仅取消对应生成                       |
| `terminal:event`                              | 向当前主窗口推送事件 | preload 消费并返回取消订阅函数                 |

所有创建及草稿提交请求使用 `requestId` 去重。创建已接受但响应丢失时，重复请求返回同一终端。草稿提交的去重记录绑定精确内容、终端及请求身份；成功确认只表示字节已写入，不表示命令执行成功。未知终端、已退出终端、目标变更、目录不存在、平台不支持和数量超限均返回明确错误；主进程与 Worker 的解析器拒绝额外的危险字段。

去重记录与草稿都有边界：每窗口最多保留 1,024 条近期请求结果，默认保留 10 分钟；未完成请求不能提前淘汰，容量不足时拒绝新请求。活跃终端保留对应创建映射直至关闭；当前草稿保留“已提交”状态，重复点击不能通过生成新 requestId 重新提交。终端结束时清除其映射，草稿最多 32 个，终端结束或 30 分钟未使用后删除。Renderer 不自动重试超过保留窗口或结果未知的发送：先查询终端，再由用户决定是否发起新操作，不把过期重试当成幂等操作。

独立 Bun Worker 使用有界的逐行 JSON 请求与事件，启动后的 stdout 专用于协议，stderr 只输出不包含终端内容的诊断。请求带 id，响应关联该 id；输出事件带 terminalId 和 seq，禁止把原始 Shell 输出直接写入协议 stdout。事件帧大小设上限，超长输出先切块，切块不能破坏 Unicode code point。`PtySession.onChunk` 已返回字符串，因此首版 wire data 为字符串；流量统计统一按 UTF-8 字节，ACK 按事件 seq。不能混用字符串长度、字节数和 seq 进行水位判断。

终端 IPC 单独检查 `event.sender`、`senderFrame` 与主窗口的主 frame，并匹配开发模式的已配置 Renderer origin 或打包模式的实际应用页面路径。拒绝来自 iframe、应用内浏览器 `WebContentsView`（已上线，E23）和导航后失效页面的请求，终端事件也只推送给主窗口的主 frame；不能只检查某个 URL 以 `file:` 开头。身份校验隔离其他 frame，但不能证明同一受信 Renderer 中某段脚本是用户手势。因此写入权限不提供给模型工具，终端页面保持本地静态内容，不能加载不受信脚本。

## 输出传输与性能

PTY 底层输出是字节流，当前原生 `onChunk` 的公开回调已经返回字符串。首版保存这些字符串的顺序与控制序列，不重复无状态解码；T0 验证原生库对跨块中文的处理。若替代后端返回 Buffer，使用持续解码器后再进入字符串协议，不能逐块调用无状态 UTF-8 解码。Renderer 把流交给 xterm，普通文本只在用户选择发送或导出时生成。

建议首版阈值如下，均是实施与验收目标，不是已测量结果：

| 项目                 | 初始设置或验收目标                                         |
| -------------------- | ---------------------------------------------------------- |
| 输出推送             | 约 16 ms 合批或累计 32 KiB 时推送                          |
| 已订阅终端未消费数据 | 高水位 512 KiB，低水位 128 KiB                             |
| 可重放输出缓存       | 每终端最多 2 MiB                                           |
| 可见滚屏             | 每终端最多 5,000 行                                        |
| 单次用户输入         | 最多 64 KiB，超限明确拒绝                                  |
| 单次命令草稿         | 最多 16 KiB，结构有效后才能发送                            |
| 发送给模型的选中输出 | 最多 16 KiB，截断位置可见                                  |
| resize               | 合并连续变化，约 50 ms 节流；最终尺寸必须发送              |
| 真机压力验收         | 持续输出 10 秒时仍能输入；Ctrl+C 到输出停止目标不超过 1 秒 |

**T0 结论**：`PtySession` 没有 pause/resume，PTY 读取不可暂停。流控改为“Worker 始终 drain + 每终端 2 MiB 有界环形缓冲 + 应用层停止 live 转发 + gap 标记”。3 秒 `yes` 压测（约 330 MiB）下 Worker RSS 增长约 60 MiB、Ctrl+C 后约 15–25 ms 停止输出。xterm `write` 完成回调产生 ACK，高低水位只控制主进程向 Renderer 的 live 转发，不控制原生读取。策略必须覆盖可见、隐藏和 Renderer 断连状态：

- 面板收起、终端切换和工作区切换保留 xterm 实例，实例继续消费输出及 ACK，避免隐藏后把进程永久暂停。
- 实例管理位于终端 feature 的长生命周期控制层，而非条件渲染的可见面板。React state 只存摘要；原始输出不进入聊天 store 或每个 chunk 的 React state。
- Renderer 重载或失去订阅时，宿主继续 drain 到有界重放缓存并丢弃最旧数据，不能等待一个不存在的 UI ACK。
- 重新 attach 使用新 epoch，先取得缓存区间，再接续 live seq，避免重复或遗漏。缓存缺口显示“部分输出已超出保留范围”。
- 缓存截断后的 ANSI 状态与全屏程序画面不能保证完整恢复。重载后重置显示并重放保留内容，明确标示截断；V1 不承诺重建重载前的完整 alternate screen。
- 到达高水位时停止 live 转发（Worker 继续 drain 到环形缓冲），低水位后从缓冲续传；被丢弃的区间以 gap 事件提示。不能用无界 Promise 队列模拟背压。
- 终端交互需要的协议回复可以送回同一 PTY，但限制类型与尺寸，不能转为任意命令。禁用未授权的 OSC 52 剪贴板写入和自动外部链接打开。

输出默认仅保留在有界内存中，避免额外保存可能包含密钥的手动终端完整转录。用户可以复制或主动导出保留文本，导出说明保留范围。既有 Agent 工具输出的本地存储规则继续使用原实现。

## 文件组织与改动范围

以下新增文件按职责建立；小而清晰的实现可以合并相邻辅助函数，不为拆分而制造空模块。

```text
src/shared/
  terminalTypes.ts

src/main/terminal/
  terminal-manager.ts         注册表、身份、状态、关闭屏障
  terminal-ipc.ts             具名 IPC 注册与主窗口校验
  terminal-workspace.ts       本地工作区及初始目录解析
  terminal-host.ts            Worker 进程及事件桥接
  terminal-worker.ts          原生 PTY 生命周期与输出
  terminal-cleanup.ts         独立故障清理契约与可信身份
  terminal-protocol.ts        Worker 请求和事件验证
  terminal-command-draft.ts   无工具生成、解析、取消

src/renderer/src/features/terminal/
  TerminalPanel.tsx           简单标题栏、终端区域、状态
  components/
    TerminalViewport.tsx     xterm 容器
    TerminalCommandDraft.tsx 临时命令草稿
  hooks/
    useTerminalWorkspace.ts  工作区终端列表与状态
    useTerminalViewport.ts   xterm 生命周期、输入、fit、ACK
  lib/
    terminalApi.ts           feature API 适配
    terminalInput.ts         快捷键和粘贴预览规则
    terminalOutput.ts        输出 seq 与重连规则
```

既有文件的改动限制：

| 文件                                                 | 拟议改动                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/renderer/src/App.tsx`                           | 接入终端工作区引用和可见性；放大/恢复布局；不写 PTY、草稿解析或事件缓冲逻辑 |
| `src/renderer/src/components/WorkspaceSidePanel.tsx` | terminal 模式渲染真实 feature children；其余模式行为保持兼容                |
| `src/renderer/src/types.ts`                          | 合并 `TerminalApi`；复用共享终端类型                                        |
| `src/preload/index.ts`、`src/preload/index.d.ts`     | 暴露具名终端 API 和可取消订阅；保持接口形状一致                             |
| `src/main/index.ts`                                  | 初始化服务、注册 IPC、传入可信工作区解析及模型生成工厂；终端清理接入 `cleanupMainWindowRuntime()` |
| `electron.vite.config.ts`                            | 独立终端 Worker 及其依赖复制与输出路径                                      |
| `electron-builder.yml`                               | `asarUnpack` 补齐 `out/main/terminal/**`、`node_modules/@oh-my-pi/pi-natives/**` 与平台包 `pi-natives-*/**`（E20、T0） |
| `package.json` 与 `bun.lock`                         | 仅在依赖选型与授权完成后修改；使用 `pi-natives` 时将其声明为直接依赖并锁定与 OMP 相同版本 |

`App.tsx` 和 `src/main/index.ts` 当前已明显超出一般文件大小要求。本功能只做接线，新增逻辑置于独立模块，并在实现说明中记录保留既有大文件的判断；不把终端接入变成整个应用迁移。

本计划编写期间这些既有文件存在其他工作产生的未提交改动。实施者应先查看最新 diff，沿用新的主题与布局接口，不能覆盖或回退其他工作。

## 实施里程碑

### T0 验证后端与构建路径

目标是证明真实 PTY 能在 Phi 的运行与打包环境中使用，而非仅证明类型可导入。

1. 验证已安装原生 PTY 的公开导出、运行环境和版本；`pi-natives` 当前只是间接依赖（E20），选定后改为直接依赖并与 `@oh-my-pi/pi-coding-agent` 锁定同一版本，不依赖 hoisting 结果。核对 Bun 至少满足包声明的版本要求。
2. 构建一个独立 Worker 的最小验证：启动干净 zsh/bash，接收字节、写入输入、resize、观察 exit、关闭后核验进程资源。
3. 以假后端测试之外的真实子进程验证 `test -t 0`、`stty size`、持续 Shell 状态、交互读取和 Ctrl+C。
4. 确定 pause/resume、隐藏时输出消费和退出清理的可实现边界。强制终止 Worker 和阻断其通信，验证独立清理路径：普通前台父子进程在故障识别后 5 秒内退出，进程身份不明时拒绝强杀。另测退出路径：多个终端各带忽略 SIGHUP 的前台进程时，1.5 秒内全部结束。将监督者形式和创建时登记身份的具体方法写入技术决策记录。
5. 验证开发目录、`out/` 和 unpacked 应用三种路径；检查 Bun 发现与原生库加载，不假设安装包拥有开发目录的 node_modules。
6. 锁定后端和最小依赖清单。若缺少必要能力，记录具体失败证据后评估 node-pty；涉及新增依赖的实施遵守已有授权规则。

交付：短技术决策记录、实际使用的依赖清单、真实 PTY 验证结果。T0 失败时不能进入 T2 的模拟面板交付。

### T1 建立主进程注册表与可信协议

以 E5、E11、E13、E23 为入口，新增 `terminalTypes`、工作区解析、manager、IPC、host 和 Worker 协议，结构参照 `src/main/browser/`。先用假 PTY 后端保护以下行为，再接上 T0 验证的真实后端：

- 创建去重、数量限制、独立身份和固定初始工作区。
- 拒绝远程项目、本地锚点、任意 Shell/env 参数与越界输入。
- 终端环境按白名单构造，`PI_CODING_AGENT_DIR` 等应用变量不出现在 Shell 环境中。
- 按主窗口及 frame 校验操作与输出订阅。
- resize、串行写入、状态转换、幂等关闭和关闭中拒绝输入。
- 草稿完整提交的不可交错输入事务，requestId 缓存及草稿数量/寿命边界。
- 独立于聊天 stop、OMP 空闲回收和聊天会话切换的生命周期。

交付：真实 Shell 的后台服务接口与针对权限及生命周期的测试。不要在此阶段新增聊天 Agent 的终端工具。

### T2 接入参考图样式的手动终端

以 E1 至 E4 为入口新增 terminal feature，替换占位内容：

- 首次打开创建 Shell，其后打开 attach 现有终端。
- 标题栏新建、紧凑选择器、放大、恢复、收起。
- 用户键盘、IME、选择、复制、单行粘贴、Tab、历史键及 Ctrl+C。
- 真实 ANSI、宽字符、滚屏和 resize。
- 工作区切换保留终端，普通工作区与项目入口均可使用。
- 生命周期控制层持续存在，StrictMode 重挂载不创建第二个 Shell。

交付：用户可以在 Phi 内完成一次真实手动操作。每轮视觉验收在真实应用中截图，与参考图并排对比，记录差异与结论；本计划阶段仅保存参考图，不制造已实现截图或视觉通过结论。

### T3 补齐有界输出与关闭恢复

在 T1、T2 上实现合批、ACK、背压、重放 seq 与订阅 epoch。以 E13、E14、E20、E21 为入口，把终端清理接入 `cleanupMainWindowRuntime()`，按两种关闭路径的预算实现，并完成独立 Worker 与原生库打包。

验收重点是高速输出时仍能 Ctrl+C、隐藏面板不暂停进程、Renderer 重载不会无限排队、旧 ACK 不影响新订阅、Worker 崩溃不影响聊天运行时、Worker 崩溃或卡住后独立清理可用、应用关闭无已知前台子进程残留。

交付：有界资源、明确断连错误和构建产物验证。T3 是最小手动终端可交付条件的一部分。

### T4 实现 Agent 命令草稿与输出解释

复用 E12 的临时无工具会话原则，注入现有 provider/model 解析工厂到 `terminal-command-draft.ts`。使用内存 SessionManager，显式 `noTools: 'all'`，关闭 MCP、扩展和可执行工具发现；失败与取消均 dispose。

完成需求输入、结构化草稿解析、待填项、编辑、复制、显式发送、取消与输出选择预览。默认使用发起工作区适用的模型设置，无有效模型时提示配置，并保留手动终端可用。

测试用模型返回一个会创建临时标记文件的命令。生成与展示阶段标记不存在；只有用户提交后才允许在隔离测试目录产生标记。再用测试 spy 证明模型请求没有工具权限，且生成完成路径没有 `input` 或 `submitDraft` 调用。

交付：用户主导的辅助闭环，结果可编辑，模型不能直接操作用户终端。

### T5 集成验证与内测交付

运行下文测试矩阵、已有回归检查和真实 unpacked 应用验证。按 E15 执行前端边界检查，并复查内测路线图，确保没有把远程终端或公共分发混入此次交付。

补充简短使用说明：打开终端、收起与结束区别、Agent 草稿的发送行为、支持平台与已验证的清理边界。记录真实验证证据及未验证平台。

交付：完整第一版，包括手动终端、资源稳定性及辅助草稿。T1 至 T3 可以先形成内部可试用版本；完整 V1 的验收包含 T4、T5。

## 测试与验收条件

测试文件沿用 `node:test` 和现有 loader，不因本功能引入新的测试框架。普通测试使用假后端；原生 PTY 真机验证使用明确的独立命令，不让 CI 默默跳过后仍声称已验证。

| 验收项             | 验证方法                  | 通过条件                                                                    |
| ------------------ | ------------------------- | --------------------------------------------------------------------------- |
| 真实终端           | 本地 PTY 集成             | `test -t 0` 成功，`stty size` 对应面板尺寸                                  |
| 状态保持           | 临时目录中的真实 Shell    | 上一条命令改变的 cwd/env 在下一条可见                                       |
| 多终端隔离         | 两个真实 Shell            | cwd、变量及输入互不串流                                                     |
| UI 参考样式        | 真机截图与 visual-verdict | 默认只见简单标题栏及正文，主题可读，无占位卡片                              |
| 终端输入           | 真机与输入规则测试        | Tab、上下键、中文 IME、复制、粘贴按设计工作                                 |
| 尺寸变化           | PTY 集成与真机拖动        | 放大/恢复后 `stty size` 更新，terminalId 不变                               |
| 收起与切换         | 假后端及真机              | 每次导航操作后同一进程继续；没有额外创建请求                                |
| StrictMode         | feature 生命周期测试      | 重挂载只有一个创建请求，监听器正确取消                                      |
| 多行粘贴           | 输入规则测试与真机        | 确认前 PTY 没有收到多行输入                                                 |
| 草稿不执行         | 生成服务及组件行为测试    | 模型完成不会写入 PTY，不产生测试标记文件                                    |
| 草稿显式发送       | IPC 集成                  | 只有确认操作写入目标终端；重复请求至多提交一次                              |
| 输入事务与去重边界 | IPC 并发及时间推进测试    | 草稿提交期间键盘排队，不拼接命令；重复点击不执行第二次；缓存和草稿不越界    |
| 异步目标变化       | 草稿和工作区测试          | 迟到结果属于原终端，不能进入新工作区                                        |
| Agent 权限         | 注入模型/session 工厂测试 | 生成会话工具集合为空，无法调用用户终端 API                                  |
| 越权访问           | IPC 假 sender 测试        | iframe、浏览器 WebContentsView、未知终端及远程锚点被拒绝                    |
| 有界输出           | 流量模拟与两组 30 秒真机压力 | 断连后协议转发归零，Worker RSS 增长 181.7 MiB < 200 MiB，主堆增长 0.9 MiB；ACK 路径 Ctrl+C 后 65.3 ms 停止 |
| 隐藏消费           | 10,000 事件假 ACK 与真机压力  | 隐藏控制层持续 ACK，累计 ACK 不超过已交付字节；隐藏后不永久锁住输出                  |
| 断连恢复           | 输出协议测试与 30 秒断连真机压力 | gap 与 2,097,152 字节重放受 2 MiB 上限约束；旧 epoch ACK 未授信，69 个 replay/live seq 连续且不重复 |
| UTF-8 与 ANSI      | 跨块字节测试              | 中文、emoji 和分割控制序列正确处理                                          |
| 结束与退出         | 真机前台父子进程与退出预算测试 | 关闭幂等；用户结束 ≤5 秒；Manager dispose 2.6 ms，低于 1.5 秒预算                |
| 终端环境           | 真实 Shell 中执行 `env`   | 无 `PI_CODING_AGENT_DIR`、`ELECTRON_*`、Provider 密钥；登录 Shell 重建 PATH |
| Worker 崩溃与卡住  | Worker/Supervisor `kill -9` 真机注入 | Worker 崩溃后 Shell 与忽略 HUP 后代 10.7 ms 退出、可重建终端；Supervisor 崩溃后拒绝新建并由 Worker 关闭已有 PTY |
| 输出隐私           | 模型请求与日志 spy        | 未选择内容不进入模型；按键、全文和密钥不进普通日志                          |
| 既有聊天           | 现有 session/OMP 回归     | 手动终端开关、崩溃和结束不改变聊天运行状态                                  |
| 安装包             | 移出开发目录的 macOS arm64 unpacked 应用 | 最小 PATH 下使用绝对 Bun；Shell 回显与 37x113 resize 通过；`lsof` 只见复制 app 内的 `pi_natives.darwin-arm64.node` |

建议新增 `tests/terminal-manager.test.ts`、`terminal-workspace.test.ts`、`terminal-ipc.test.ts`、`terminal-output.test.ts`、`terminal-input.test.ts`、`terminal-command-draft.test.ts`、`terminal-panel.test.ts`。真实 PTY smoke 脚本放在 `scripts/`，明确要求本机环境；具体文件数量可按测试职责合并。

实施后的验证顺序：

1. 针对修改模块运行终端行为测试与已有侧面板切换回归。
2. 运行 `bun run check:architecture`、`bun run lint`、`bun run typecheck`。
3. 运行 `bun run test`、`bun run build`，验证 Worker 输出目录及依赖闭包。
4. 运行 `bun run build:unpack`，从实际产物中完成本地 PTY 手动闭环。
5. 采集参考样式、收起/切换、高速输出中断、Agent 草稿以及退出清理证据。

没有源码实现的本计划交付不执行上述功能测试，也不宣称上述验收已通过。

## 主要风险与处理方式

| 风险                            | 具体影响                                   | 处理与验证                                                           |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| PTY 公共接口不足                | 只能执行一次命令，不能稳定输入/resize/背压 | T0 真机门槛；失败再评估替代后端                                      |
| 开发与安装包运行环境不同        | Bun、原生库或 Worker 路径找不到            | T0 和 T5 均验证实际 unpacked 产物，更新真实复制及解包路径            |
| Shell 配置改变目录或启动缓慢    | 初始目录标签与实际提示符不同，启动卡住     | 标签写初始目录；10 秒启动边界；显示具体 Shell 及错误                 |
| 图形界面 PATH 不含 Conda 等工具 | 内测用户无法复现外部终端环境               | 真机验证交互登录 Shell，保留初始化输出，不自动安装环境               |
| 输入混入现有半条命令或 REPL     | 草稿到达了错误的输入上下文                 | 显示目标、要求用户准备接收；不给出虚假的命令完成承诺                 |
| 面板隐藏后 ACK 消失             | 高速程序被永久暂停                         | xterm 生命周期与可见面板分开；隐藏及断连分别测试                     |
| 大输出占满内存                  | UI 卡顿、无法中断、进程失控                | 合批、背压、滚屏和重放上限，独立 Worker 隔离                         |
| 迟到草稿写入新项目              | 用户以为运行的是另一个环境                 | 捕获目标身份；结果只更新草稿，显式发送再校验                         |
| 输出或按键包含凭证              | 敏感数据进入模型或普通日志                 | 默认只存有界内存，选择内容才发送，不记录按键                         |
| 退出清理不足或 PID 复用         | 残留子进程，或误结束其他程序               | 验证 PTY/进程组清理，清理屏障；不信任 Renderer PID，不强杀未验证身份 |
| Worker 消失后无人清理           | Shell 后代残留、窗口退出不可信             | 创建时保存独立清理身份；故障注入验证监督路径；失败则后端不通过 T0    |
| 退出清理被全局上限截断          | 应用 2 秒后退出，终端进程组残留            | 退出路径不等宽限，1.5 秒预算；接入现有清理屏障并真机计时             |
| 应用环境变量泄漏到终端          | 终端里的 omp/pi CLI 共用 Phi 配置目录      | 环境白名单；`env` 检查纳入验收                                       |
| 与浏览器归属模型不一致          | 切换聊天时终端保留、浏览器切换，用户困惑   | 文档与 tooltip 说明终端按项目归属；真机检查切换行为                  |
| 用户把 cwd 理解为沙箱           | 误判命令的实际系统访问范围                 | 使用本机终端语义；不宣称项目目录构成 OS 隔离                         |
| 同时修改 App 与主题             | 覆盖其他功能或引入布局回归                 | 先读最新 diff，只做接线，保持 feature 私有实现                       |

## 参考方案与设计决策

- [DeepSeek Harness 终端服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/terminal/tool-terminal/README.md)：参考持久会话、所有权校验、工具适配和有界输出；用户终端的 owner 在本版是应用工作区及主窗口，Agent owner 留待后续。
- [Codex unified exec](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs)：参考可继续操作的进程身份、增量输出与串行交互。独立 exec 调用不等同于一个持久交互 Shell。
- [Claude Code 后台命令](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)：参考后台可见性、查看输出和停止行为；用户提供的截图是本版样式依据，不据此推断 Claude 内部实现。
- [xterm 流量控制](https://xtermjs.org/docs/guides/flowcontrol/)：采用写入完成回调及水位，避免把 PTY 数据无限送入 Renderer。
- [xterm 安全说明](https://xtermjs.org/docs/guides/security/) 和 [Electron 安全说明](https://www.electronjs.org/docs/latest/tutorial/security)：终端视图加载本地静态代码，主进程验证 IPC 来源，输出不能获得外部导航或剪贴板写入能力。

本版选择独立手动 PTY 与无工具草稿生成，原因是它满足“在应用内输入、用户决定运行”的需求，同时沿用已有终端入口、项目模型和运行环境。全面替换 OMP Bash 管理器会把现有聊天、审批和后台任务一并卷入改动；直接嵌入 OMP TUI 又不能解决 Phi 的面板输入与 resize 契约，因此两者均不作为第一版实施路线。

开始实现前，以 T0 结果确定唯一后端。之后按 T1、T2、T3、T4、T5 的依赖关系推进，每个里程碑完成都保留行为证据；完整 V1 以测试矩阵和真机产物验证为交付标准。
