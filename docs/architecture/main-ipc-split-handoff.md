# 主进程 IPC 拆分:交接文档

Date: 2026-10-20
Status: IPC 拆分(IPC-1 至 IPC-7)、第 9 步运行时上下文(RC-1、RC-2)、第 6 步超长函数(LF-1 至 LF-4)已完成。`src/main/index.ts` 13,014 → 6,859 行,不注册 IPC、无模块级 `let`,四个超长函数已拆成命名阶段

给接手这条线的新会话看。读完应能直接派发下一刀,不需要回看之前的对话。

相关文档:

- 方案:[clean-code-optimization-plan.md](clean-code-optimization-plan.md) 第 3.1、9 节
- 通道常量与契约:`src/shared/ipcChannels.ts`、`tests/ipc-channel-contract.test.ts`
- 测试门(`--changed`、重试、抖动套件):[test-gate.md](test-gate.md)
- App 拆分(另一条线,当前暂停):[app-shell-refactor-handoff.md](app-shell-refactor-handoff.md)

---

## 1. 目标与不变量

目标:`src/main/index.ts` 只剩应用生命周期与组装,≤ 800 行;IPC 注册按域放在 `src/main/ipc/<domain>-ipc.ts`。

不变量:

- **不改行为**。处理函数原样搬,只改注入依赖的引用名;不顺手修 bug、不加校验。
- **注册顺序不变**。`register<Domain>Ipc(...)` 放在原处理函数所在位置调用。
- **依赖靠注入,不反向 import `../index`**。易变的模块级值(`currentCwd`、`selectedModel`、`mainWindow`)
  用 getter 在调用时读取,不能在注册时捕获。
- **依赖面要小**。options 超过约 12 个成员就按已有的内聚单元分组(IPC-1 分成 `notebooks` / `jupyter` /
  `generation`);只是把一堆 deps 原样转发的包装层不算进展。
- **只有本域用的辅助函数跟着搬**,放进对应领域目录(如 `src/main/agent/notebook/`),不放进 IPC 模块;
  被别的域共用的留在 `index.ts`,通过 options 传入,在报告里列出共用方。
- **新文件按职责命名,一个文件一个关注点**。不要 `helpers.ts`、`utils.ts`、`ipc-helpers.ts`;
  IPC-2 的 `ipc-helpers.ts` 在审查时拆成了 `featured-api-key-verification.ts` 与 `remote-mcp-trust-request.ts`。
- **不凑行数**。禁止 `// prettier-ignore`、删空行、为省 import 行改用 `import * as` 等手段;行数是副作用。
- **一个域一个模块,按域命名**。不能为了把文件压到 600 行以下而按行数拆、起含糊的名字(IPC-3 因此返工一次)。
- 每刀结束跑 `node scripts/check-main-boundaries.mjs --update`,行数与 `ipcMain.handle` 数只降不升。

## 2. 已有的基础设施(后续每刀直接复用)

- `tests/main-integration.test.ts` 的 harness 会把 `src/main/ipc/**` 和 `explicitlyLoadedSourceModules`
  里列出的新模块按**真实源码**加载,import 按 `src/main` 相对路径归一后查同一张 `modules` 表。
  新增的领域辅助模块要么加进 `explicitlyLoadedSourceModules`,要么(纯外部依赖时)加进 `modules` 表——优先前者。
- 契约测试已识别 `options.ipcMain.handle(IPC.x.y, ...)`,搬走的注册无需改扫描器。
- 读 `index.ts` 源码文本的测试(`grep -rlE "src/main/index" tests`)要改成读事实所在的新文件,断言不放宽。

## 3. 切片清单(按建议顺序)

行数为注册区内处理函数本身的行数,不含随迁的辅助函数(IPC-1 处理函数 421 行,实际降了 989 行)。

| #     | 域                                                                                  | 处理函数 | 行数   | 状态   | 备注                                               |
| ----- | ----------------------------------------------------------------------------------- | -------- | ------ | ------ | -------------------------------------------------- |
| IPC-1 | `analysis`                                                                          | 23       | 421    | 已完成 | 建立 `src/main/ipc/` 与 harness 加载器             |
| IPC-2 | `mcp`                                                                               | 26       | 307    | 已完成 | index.ts 12,025 → 11,561;按关注点分 7 个注册函数   |
| IPC-3 | `packages` + `sources` + `phiPlugins` + `skills` + `enablement` + `resources`       | 39       | ~650   | 已完成 | 11,561 → 10,795;一域一模块,注册调用保持交错顺序    |
| IPC-4 | `wrappers` + `wrapperResults` + `jobs` + `environmentBuilds`                        | 26       | ~320   | 已完成 | 10,795 → 10,320;wrappers 分三次注册,保持交错顺序   |
| IPC-5 | `projects` + `remote` + `remoteProjectUploads` + `remoteWorkspace` + `memory`       | 37       | ~420   | 待派发 | 远端项目相关,依赖 SSH/远端运行时                   |
| IPC-6 | `sessions` + `agent` + `agents` + `tool` + `models` + `thinking`                    | 39       | ~610   | 待派发 | 风险最高(会话切换、运行控制),最后做,先补特征化测试 |
| IPC-7 | 其余小域(`window`、`app`、`settings`、`auth`、`persona`、`files`、`environment` 等) | 50       | ~1,000 | 已完成 | 8,648 → 7,582;14 个模块,index.ts 内 0 个 handle    |

处理函数已全部搬完(2026-10-20)。`index.ts` 仍有 7,582 行辅助函数、组装代码与 24 个模块级 `let`,
距 ≤ 800 的目标还差很远。下一阶段按方案:

1. 第 9 步:把 24 个模块级 `let` 收敛成 `bootstrap` 创建、向下注入的运行时上下文对象。IPC 模块已经通过
   getter / 窄回调访问这些状态,收敛后可以直接改为读上下文,这一步也是主进程可隔离测试的前提。
2. 第 6 步:拆 `getAgentSession`、`submitPromptRun`、`persistSessionEvent` 等超长函数。
3. 剩余辅助函数按归属迁入领域目录,`index.ts` 只留生命周期与组装。

主进程门禁已经在 `check-main-boundaries` 里把 `ipcMain.handle` 上限锁在 0,`index.ts` 不能再新增处理函数。

### 第 9 步的设计决定(2026-10-20,用户确认)

- 形态:**封装成带方法的状态类**,不是普通对象。字段私有,读取走 getter,每个写入点变成一个按意图命名的方法,
  方法体就是原来的语句;不新增行为、默认值或状态。Electron 对象不在类里创建,类只持有引用,便于单元测试。
- 位置:`src/main/app-state/`,由 `createMainRuntimeContext()` 组装,在原来第一个 `let` 的模块加载位置创建,
  初始化顺序不变。IPC 模块只拿它需要的那个方法,不拿整个上下文。
- 切片:RC-1 先做窗口生命周期、工作区服务、应用缓存三组(15 个 `let`);RC-2 再做会话状态 9 个 `let`
  (风险最高,单独跑门)。
- 结果(2026-10-20):RC-1(`aaf12ab5`)、RC-2(`79befe3f`)均已合入,`src/main/app-state/` 下有
  `MainWindowState`、`WorkspaceServicesState`、`AppCaches`、`SessionState`,`tests/main-app-state.test.ts` 覆盖每个方法。
  上下文创建点后移到原会话变量位置,以保持初始 cwd、读盘的上次模型、初始会话 key 的加载时机;此前的顶层代码只存回调。
- 合入后复核告警发现 RC-2 的改名让一个方法越过 80 行;已把标题模型解析提成 `resolveSessionTitleModel`
  (`c6b0cb8f`),告警 1,434 → 1,431。审查清单补充:**合入后在主仓库重新统计全仓告警**,不采信切片内的计数。

### 第 6 步:超长函数(2026-10-20 开始)

`index.ts` 里需要拆的四个函数(行数 / 圈复杂度):启动组装 `app.whenReady` 回调 729 行;`getAgentSession` 567 行 / 131;
`submitPromptRun` 335 行(内含 222 行运行回调与 149 行 `execute`);`persistSessionEvent` 303 行 / 95。

顺序:LF-1 `persistSessionEvent`(职责最清楚,按事件族拆分、定下模式)→ LF-2 `submitPromptRun` →
LF-3 `getAgentSession`(风险最高)→ LF-4 启动组装拆成命名阶段。每刀先补特征化测试,再按原顺序拆成 ≤ 80 行、
复杂度 ≤ 15 的命名函数,原语句只搬不改;同一时间只做一刀(都改 `index.ts`)。

结果(2026-10-20,全部合入,每刀全量门首轮 0 失败):

| 刀   | 函数                       | 之前                   | 之后               | 去向                                                       |
| ---- | -------------------------- | ---------------------- | ------------------ | ---------------------------------------------------------- |
| LF-1 | `persistSessionEvent`      | 303 行 / 95            | 11 行分派器 / 3    | `agent/session/session-event-persistence.ts` 等 4 个模块   |
| LF-2 | `submitPromptRun`          | 335 行(内含 222 + 149) | 11 行协调函数      | 阶段留在 `index.ts`,会话执行进 `prompt-run-execution.ts`   |
| LF-3 | `getAgentSession` 创建回调 | 548 行 / 131           | 72 行协调函数 / 13 | `SessionCreationContext` 与 5 个 `session-creation-*` 模块 |
| LF-4 | `app.whenReady` 回调       | 729 行                 | 20 行协调函数 / 1  | 命名启动阶段与 9 个 IPC 注册分组,留在 `index.ts`           |

`index.ts` 6,763 → 6,859 行:LF-4 的命名阶段增加了 102 行组装脚手架,原因记在基线里。全仓告警 1,431 → 1,410;
`index.ts` 自身剩 15 条(复杂度 8、函数长度 3、嵌套深度 3、文件长度 1)。启动时 247 个通道的注册顺序由
`main-integration` 快照守住。

下一步候选:`index.ts` 里剩余的复杂度告警函数(`handlePlanReviewRequest`、`presentableRun`、`scopeFor` 等),
以及把与会话执行无关、只被单一领域使用的辅助函数继续迁出,使 `index.ts` 接近「生命周期 + 组装」。

### 继续瘦身:单一领域代码与剩余告警(2026-10-21 开始)

`index.ts` 剩 15 条告警。按领域切四刀,每刀把该领域独占的函数迁到对应目录,并把迁出的函数拆到复杂度 ≤ 15、≤ 80 行:

| 刀   | 领域             | 内容                                                                              | 告警                      |
| ---- | ---------------- | --------------------------------------------------------------------------------- | ------------------------- |
| SL-1 | 引擎宿主请求     | 交付文件展示、交互请求、计划审阅、各类确认;经 `getPhiEngine().host.register` 接入 | 复杂度 4 条(最高 32)      |
| SL-2 | 应用级远端运行时 | 远端智能体环境、提示词上下文、桌面工具加载、分发控制                              | 函数长度 1 条             |
| SL-3 | 会话控制与载荷   | `captureSessionControlTarget`、`getCurrentSessionPayload`、`scopeFor` 等          | 复杂度、长度、嵌套共 5 条 |
| SL-4 | 消息文本与窗口   | `extractMessageText` 一族纯函数、`createWindow`                                   | 2 条                      |

归属判定用 TypeScript AST:属于某领域的函数,或只被该领域函数使用的函数;被其他代码共用的留在 `index.ts` 并注入。

## 4. 每刀的执行与验收(项目管理约定)

- 实现交给 Codex(`gpt-5.6-sol`、`xhigh`),每刀一个 worktree:`../Phi-worktrees/ipc-<n>-<domain>`,
  `node_modules` 软链到主仓库;任务说明放 scratchpad,`codex-watch.sh` 后台监控。
- 各刀都改 `index.ts`,**只能串行**;不改 `index.ts` 的任务可以并行。
- Codex 只跑 typecheck、eslint、边界检查、`main-integration`、`--changed`;全量门由审查方在沙箱外跑。
  (Codex 沙箱里 Go 写不进软链的 `node_modules/.cache`,`engine-rpc-startup-transaction-real-helper`
  会因 EPERM 失败,属环境问题。)
- 审查清单:
  1. 删除行与新增文件逐行比对,非原样的行逐个确认是注入改名或函数改方法;
  2. 易变值走 getter;新构造的协作对象定义顺序不触发 TDZ;
  3. options 成员数与分组;共用辅助函数清单是否属实;
  4. 有无 `prettier-ignore` / 删空行;
  5. 全量门通过(首轮失败但串行重试通过的套件写进提交说明)。
  6. 不直接采信报告里的「通过」:IPC-1 的报告称定向套件全绿,但它最后一次改源码后没重跑,
     `analysis-view` 的一条断言已与源码不符,是全量门的串行重试才暴露的。任务说明要求 Codex
     在最后一次修改后重跑所有动过的套件并贴出那次输出;审查方仍以自己的全量门为准。

## 5. 新会话开场方式

```text
读 docs/architecture/main-ipc-split-handoff.md,按第 3 节顺序派发下一刀给 Codex,
按第 4 节审查、跑门、合入;不要偏离第 1 节的不变量。
```
