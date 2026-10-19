# Phi 代码整洁度优化方案

Date: 2026-10-18
Status: 方案(未实施)
依据: Robert C. Martin《代码整洁之道》(Clean Code) + 本仓既有架构契约(`AGENTS.md`、`docs/architecture/frontend-feature-boundaries.md`)

本方案只处理"既有代码的可读性、可测性、可维护性",不新增产品能力,不改动内测范围。
所有判定口径尽量可被脚本复现,避免靠感觉做重构。

---

## 0. 判定工具(什么算"整洁")

沿用 Clean Code 的可操作阈值,并与本仓既有规则对齐:

| 维度     | 阈值                                                       | 现状来源                        |
| -------- | ---------------------------------------------------------- | ------------------------------- |
| 文件行数 | ≤ 600 保持;600–1000 明确判断;> 1000 视为架构债务           | `check-frontend-boundaries.mjs` |
| 函数行数 | ≤ 50 行(超出必然混了多层抽象)                              | 本方案新增                      |
| 函数参数 | ≤ 3 个;更多用 options 对象,但 8 个键以上要拆成显式协作对象 | 本方案新增                      |
| 缩进层级 | ≤ 2 层                                                     | 本方案新增                      |
| 圈复杂度 | ≤ 10                                                       | 本方案新增                      |
| 重复     | 同一知识点只允许存在一份;出现第三次即抽取                  | Clean Code「三次法则」          |
| 命名     | 表达"做什么"和领域含义,不做缩写游戏                        | Clean Code 第 2 章              |
| 注释     | 只写意图与原因,不写代码复述;死代码直接删                   | Clean Code 第 4 章              |
| 错误处理 | 边界层统一转换,业务层抛领域错误,不在每处重拼消息           | Clean Code 第 7 章              |

---

## 1. 现状基线(实测,2026-10-18)

### 1.1 体量与集中度

| 对象                                  | 实测                                                                                                                   | 判定                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `src/main/index.ts`                   | **12,902 行**,约 315 个顶层声明,234 个 `ipcMain.handle`                                                                | 严重超标,主进程上帝文件 |
| `src/main/index.ts` 的 IPC 注册区     | 第 9,898–12,902 行,连续约 3,000 行,区域内 500 行里塞了 52 个 handler                                                   | 缺乏模块边界            |
| `src/main/index.ts` 最长函数          | `getAgentSession` 579 行、`submitPromptRun` 350 行、`persistSessionEvent` 325 行、`captureRuntimeRecoveryScope` 245 行 | 单函数承担多个抽象层    |
| `src/renderer/src/App.tsx`            | **5,504 行**,`App()` 单个组件 706–5,503 行                                                                             | 上帝组件                |
| `App.tsx` 内部状态                    | 29 个 `useState`、16 个 `useEffect`、127 个 `useCallback`、7 个 `useMemo`                                              | 状态所有权混乱          |
| `src/preload/index.ts` + `index.d.ts` | 2,178 + 1,299 行                                                                                                       | IPC 表面三重手写        |
| `tests/main-integration.test.ts`      | 16,560 行,331 个 `test()`                                                                                              | 测试巨石,失败定位成本高 |

### 1.2 重复

| 重复点                                                   | 处数                                         | 说明                                    |
| -------------------------------------------------------- | -------------------------------------------- | --------------------------------------- |
| `function isRecord(`                                     | **80**(全部在 `src/`)                        | 同一个类型守卫被复制 80 次              |
| `error instanceof Error ? error.message : String(error)` | **166**                                      | 没有共享的错误消息工具                  |
| `optionalStringField`                                    | 2                                            | 已有的共享化先例,未推广                 |
| IPC 通道字符串                                           | main 194 个 / preload 263 个 / d.ts 手写一遍 | 同一字符串在三个文件各写一次,靠人肉对齐 |

`writeAppLog(` 在 `src/main/index.ts` 出现 53 次,大量是「try → catch → 记一条日志 → 继续」的复制粘贴。

### 1.3 缺失的护栏

- `check-frontend-boundaries.mjs` **只检查 renderer**,主进程 17 万行完全无边界检查。
- ESLint 目前只有 `typescript-eslint recommended` + react hooks,**没有** `max-lines`、`max-lines-per-function`、`complexity`、`max-depth`、`max-params`。
- 结果是:文件可以无限增长,而且没有任何机制会在 PR 阶段提醒。

### 1.4 测试形态的信号

`tests/app-deferred-views.test.ts` 等文件用 `typescript` 的 AST 去断言 `App.tsx` 的 JSX 结构
(例如 Suspense fallback 是否存在),而不是渲染后断言行为。这是「无法实例化组件」的替代手段,
属于可测性不足的症状,不是测试设计目标。

---

## 2. 排序:先修热点,不先修「看起来最脏」的

热点 = 体量 × 近期改动频率(2026-06 起 `git log --numstat`):

| 文件                                                             | 变更行数 | 行数   | 处置优先级 |
| ---------------------------------------------------------------- | -------- | ------ | ---------- |
| `src/main/index.ts`                                              | 20,634   | 12,902 | **P0**     |
| `tests/main-integration.test.ts`                                 | 19,254   | 16,560 | **P0**     |
| `src/renderer/src/App.tsx`                                       | 16,664   | 5,504  | **P0**     |
| `src/renderer/src/components/MarkdownContent.tsx`                | 3,678    | 965    | P1         |
| `src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx` | 2,983    | 1,512  | P1         |
| `src/renderer/src/features/wrapper/WrapperView.tsx`              | 4,243    | 已拆   | P1         |

前三个文件占了绝大部分「每次改需求都要动、每次都要在大文件里找位置」的成本。
其余超标文件按 Clean Code 的「600 行重新判断」规则,在**下次实质改动时**顺手拆,不做专项运动。

---

## 3. 五项核心病灶与对策

### 3.1 主进程上帝文件 → 按「通道域」切片,沿用仓内既有范式

**证据**:12,902 行;234 个 handler;3,000 行连着注册;24 个模块级 `let` 共享可变状态。

**关键判断**:本仓已经有正确的范式,只是没铺开。

```
src/main/workspace-file-ipc.ts        106 行  registerWorkspaceFileIpc({ ipcMain: Pick<IpcMain,'handle'>, ... })
src/main/terminal/terminal-ipc.ts             registerTerminalRendererIpc(...)
src/main/browser/browser-ipc.ts               registerBrowserRendererIpc(...)
src/main/agent/ssh-bootstrap/ipc.ts           registerSshBootstrapIpc(...)
src/main/agent/remote-micromamba-ipc.ts       registerRemoteMicromambaIpc(...)
src/main/agent/remote-ripgrep-ipc.ts          registerRemoteRipgrepIpc(...)
```

这些模块的共同特征值得作为标准写进文档:
**注入 `Pick<IpcMain,'handle'>`、注入依赖而不是直接读全局、请求先过 validator、统一 `requireRenderer` 守卫。**

**动作**:

1. 新建 `src/main/ipc/` 目录,`index.ts` 只保留 `bootstrap()`;`src/main/index.ts` 最终只做
   应用生命周期 + 组装,目标 **≤ 800 行**。
2. 按域切分注册模块:`sessions`、`runs`、`tools/approvals`、`notebook`、`projects`、
   `packages/mcp`、`wrappers`、`environment`、`remote`、`files`、`files-preview`、`app/settings`。
   每个模块 150–400 行,导出 `register<Domain>Ipc(options)`。
3. 把 24 个模块级可变状态收敛成一个显式的运行时上下文对象
   (窗口、终端管理器、浏览器注册表、包缓存……),由 `bootstrap` 创建、向下注入,
   而不是靠模块级 `let` 互相可见。**这是测试可写性的前提**:现在这些状态无法在测试里隔离。
4. 三个超长函数就地拆职责:
   - `getAgentSession`(579)→ 「会话查找」「主/远端分流」「权限与工具装配」三段。
   - `submitPromptRun`(350)→ 「校验与配额」「run 创建」「事件转发」。
   - `persistSessionEvent`(325)→ 「事件归类」「消息写入」「摘要更新」。
5. 分节:大文件拆分后不要再依赖行注释做路标;每个模块文件头写 3–5 行「职责 + 不负责什么」。

**验收**:

- `src/main/index.ts` ≤ 800 行;`src/main/` 下无 > 1,000 行的非数据文件。
- 234 个 handler 全部可在 `src/main/ipc/` 中按域找到。
- 现有 `bun run test` 全绿,且**不改任何测试断言**(行为零变化)。

### 3.2 App 上帝组件 → 按「状态所有权」拆,而不是按 JSX 块切

**证据**:5,504 行 / 29 `useState` / 127 `useCallback`;JSX 从 4,968 行一路到文件尾。

**关键判断**:不能按「左侧栏 / 右侧栏 / 主区」这种视觉分块去切 JSX,那只会把 5,500 行变成
5 个互相传 20 个 props 的 900 行组件。正确的切法是 Clean Code 的「一个函数只做一件事」在
React 里的等价物——**一个状态归一个所有者**,把状态和操作它的回调放在同一个 hook 里。

从现有 `useCallback` 名单可直接归纳出六个真实职责簇:

| 簇                       | 现有回调举例                                                                                                           | 去向                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 会话导航                 | `onSelectSession`、`onNewChat`、`openNewChat`、`onDeleteSession`、`onExportSession`                                    | `features/session-actions/`(已有目录)                          |
| 工作区标签与侧边面板     | `onToggleWorkspaceSidePanel`、`onCloseWorkspaceSidePanelSlot`、`onStartWorkspaceSidePanelResize`、`workspaceTabs` 系列 | `features/workspace/lib/useWorkspaceLayout.ts`                 |
| 文件 / Notebook 打开链路 | `onOpenFilePreview`、`onOpenLocalPath`、`onOpenNotebookWorkspaceFile`、`onOpenDefaultPreviewPath`                      | `features/file-preview/hooks/`(已有 `useWorkspaceFileActions`) |
| 面板桥接                 | `openBrowserPanelFromRequest`、`onOpenWebUrl`、终端请求转发                                                            | 各 feature 已有 hook,App 只留装配                              |
| 运行控制                 | `onCompactContext`、`onRetryUserMessage`、`onForkUserMessage`                                                          | `features/chat/hooks/`                                         |
| 对话框与设置             | `openSettings`、`onGoProviderSettings`、各类 `isXxxOpen`                                                               | 单个 `useAppDialogs()`                                         |

**动作**:

1. 先写特征化测试(characterization test)锁定当前可见行为:切会话、开关面板、打开文件、
   打开设置这四条主路径。
2. 逐个 cluster 迁移:状态 + 依赖回调一起搬进 hook,`App.tsx` 只保留 `const shell = useWorkspaceShell()` 之类。
3. 每个 cluster 一次提交,单次 diff 控制在 300–600 行,**不允许**混合行为修改。
4. 迁移完成的簇,把它对应的 AST 结构测试改为真实渲染测试。

**验收**:

- `App.tsx` ≤ 1,200 行;从 `legacyOversizedFiles` 例外名单中移除。
- `App.tsx` 内 `useCallback` ≤ 30 个。
- 快照/行为测试数量不减少。

### 3.3 重复 → 只抽「已确定重复」的三类,不高举 DRY 大旗

Clean Code 反对重复,但同样反对为了 DRY 制造错误抽象。只处理满足「三次法则」且语义完全一致的:

| 重复                            | 处置                                                                                          | 位置                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `isRecord` ×80                  | 抽 `src/shared/guards.ts`: `isRecord` / `optionalString` / `optionalNumber` / `requireRecord` | 共享层,无领域依赖,风险极低                       |
| 错误消息 idiom ×166             | 抽 `src/main/errors.ts`: `errorMessage(e)`、`describeError(e)`、`toUserFacingError(e)`        | 主进程;**renderer 不引**,避免把 Node 处理混入 UI |
| `optionalStringField` ×2        | 并入 `guards.ts`                                                                              | —                                                |
| 53 处 `try/catch + writeAppLog` | 抽 `runLogged(event, fn)` 包装器,只覆盖「记日志并继续」这一种形态                             | `src/main/logging/`                              |

**明确不做**:把 `wrappers/`、`packages/`、`notebook/` 里长得像但语义不同的解析函数合并。
它们的相似来自同构的输入格式,不是同一个知识点。

**验收**:`grep -c "function isRecord(" src` → 1;`grep -c "Error ? .*message : String(" src` → ≤ 10(剩余为确实需要差异化的场景)。

### 3.4 IPC 契约 → 单一来源,让漂移在编译期或 CI 期暴露

**证据**:main 侧 194 个通道、preload 侧 263 个调用、`index.d.ts` 再手写一遍;
通道名是三份手写字符串,当前**没有任何机制**保证三者一致。

**动作**:

1. 新建 `src/shared/ipcChannels.ts`,以常量对象导出全部通道:
   ```ts
   export const IPC = {
     sessions: { list: 'sessions:list', updatePermissionMode: 'sessions:updatePermissionMode' }
     // ...
   } as const
   export type IpcChannel = (typeof IPC)[keyof typeof IPC][keyof (typeof IPC)[keyof typeof IPC]]
   ```
2. `ipcMain.handle` 与 `ipcRenderer.invoke` 一律只接受 `IpcChannel`,禁止字面量
   (ESLint `no-restricted-syntax` 拦截 preload 里的字面量调用)。
3. `preload/index.d.ts` 用 `typeof api` 推导,不再手写 1,299 行签名。
4. 加一个契约测试:遍历 `IPC` 全量通道,
   **每个通道都必须有 handler**,且 **preload 暴露的每个方法都指向存在的通道**。

**收益**:这三重手写是典型的「同一个知识点写三遍」,而且是**最容易静默坏掉**的那种
(改了名字但没人报错,直到运行时 `No handler registered`)。

### 3.5 缺少护栏 → 把整洁变成 CI 的默认状态

只做一次清理,三个月后必然回到原样。Clean Code 的「持续整洁」靠的是让脏代码**无法通过关卡**。

**动作**:

1. 扩展架构检查:`scripts/check-main-boundaries.mjs`
   - `src/main/index.ts` 超 800 行 → 失败;
   - 其他 `src/main/**` 超 1,000 行 → 失败(数据/fixture 白名单除外);
   - 禁止 `src/main/index.ts` 内出现 `ipcMain.handle`;
   - 接进 `bun run lint`。
2. ESLint 追加(先在**新增文件**上 error,存量文件 warn,逐版本收紧):
   `max-lines`、`max-lines-per-function`、`complexity`、`max-depth`、`max-params`、
   `no-restricted-imports`(`renderer` 不得引 `src/main/**`)。
3. 当前 `check-frontend-boundaries.mjs` 的 `legacyOversizedFiles` 是 6 条「临时例外」。
   每条补一个到期条件(例如「App.tsx 拆分完成后移除」),避免临时例外变成永久豁免。

---

## 4. 分阶段计划

### P0:止血(约 6–8 个切片,不改行为)

| #   | 切片                                                 | 产出                                         | 验收                                |
| --- | ---------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| 0   | 提交当前工作区改动                                   | 干净基线                                     | `git status` 无未提交的 `src/` 变更 |
| 1   | 共享守卫 + 错误工具                                  | `src/shared/guards.ts`、`src/main/errors.ts` | 替换 80 + 166 处重复;测试全绿       |
| 2   | 通道常量模块                                         | `src/shared/ipcChannels.ts` + 契约测试       | 新增测试通过;漂移可检测             |
| 3   | 主进程 IPC 第一刀:`notebook` + `tools/approvals`     | 2 个注册模块,`index.ts` −1,500 行            | 相关测试全绿                        |
| 4   | 主进程 IPC 第二刀:`sessions` + `runs`                | `index.ts` −1,200 行                         | 同上                                |
| 5   | 主进程 IPC 第三刀:`projects` + `packages` + `remote` | `index.ts` ≤ 3,000 行                        | 同上                                |
| 6   | 拆 3 个超长函数                                      | `getAgentSession` 等 ≤ 60 行                 | 同上                                |
| 7   | `App.tsx` 前两个 cluster(会话导航、对话框)           | `App.tsx` −1,200 行                          | 行为测试全绿                        |

### P1:收敛(按热点顺序)

| #   | 切片                                                    | 产出                                         |
| --- | ------------------------------------------------------- | -------------------------------------------- |
| 8   | `App.tsx` 剩余 cluster                                  | ≤ 1,200 行,移出例外名单                      |
| 9   | 运行时上下文对象替换 24 个模块级 `let`                  | 主进程可隔离测试                             |
| 10  | 拆 `tests/main-integration.test.ts`                     | 按域拆成 6–8 个文件,单一 `test()` 仍逐条保留 |
| 11  | `MarkdownContent.tsx`(965)、`NotebookCanvas.tsx`(1,512) | 按「解析 / 渲染 / 交互」拆                   |
| 12  | 主进程边界检查上线 + ESLint 复杂度规则                  | CI 守门                                      |

### P2:习惯化

- 每个 feature 的 `<Feature>View.tsx` 保持在 300 行内,复杂子域下沉到 `components/`、`lib/`、`hooks/`。
- 新代码一律满足第 0 节的阈值;存量按「下次实质改动时顺手拆」推进,不再另立专项。
- 每季度跑一次热点分析(体量 × churn),只处理前 5 名。

---

## 4.5 执行状态

App shell 拆分正在进行,进度、剩余切片、踩坑记录与「新会话如何接手」都在
[app-shell-refactor-handoff.md](app-shell-refactor-handoff.md)。本文档保留原始方案与目标,不随执行滚动更新。

## 5. 度量看板(前后对照)

| 指标                                  | 现状         | 目标           | 采集方式   |
| ------------------------------------- | ------------ | -------------- | ---------- |
| `src/main/index.ts` 行数              | 12,902       | ≤ 800          | `wc -l`    |
| `App.tsx` 行数                        | 5,504        | ≤ 1,200        | `wc -l`    |
| > 1,000 行的源文件数                  | 6(含例外)    | 0              | 新架构检查 |
| `isRecord` 定义数                     | 80           | 1              | `grep -c`  |
| 错误消息 idiom 数                     | 166          | ≤ 10           | `grep -c`  |
| 通道字符串手写份数                    | 3            | 1              | 人工       |
| 单测文件数 / 最大单测文件行数         | 844 / 16,560 | 844+ / ≤ 2,000 | `wc -l`    |
| `main-integration` 单文件 `test()` 数 | 331          | ≤ 60           | `grep -c`  |

---

## 6. 不该做的事(Clean Code 同样强调的边界)

1. **不做大爆炸式重写。** 上面每一项都是「保持行为、移动代码」,任何切片如果开始需要改产品逻辑,说明切错了。
2. **不为了拆而拆。** `features/chat/ChatView.tsx`(873 行)目前虽然偏大,但职责集中、没有状态泥潭,不在清单里。
3. **不追求 100% DRY。** 只合并语义完全一致的重复;形似而神不同的解析逻辑保持独立,否则会造出"要传 8 个开关的通用函数",那比重复更糟。
4. **不把领域词改成通用词。** `cwd`、`phiSessionId`、`runId`、`approvalId` 是领域语言,保留;真正要改的是那些看不出意图的名字。
5. **不在重构提交里顺手修 bug。** 分开提交,否则回滚和归因都会失效。
6. **不用注释补救烂代码。** 拆完的文件不需要解释性注释;需要注释的是「为什么这么绕」的取舍,例如 `src/main/index.ts` 里 `APP_NAME` 那条兼容性说明,那类注释必须保留。

---

## 7. 与内测路线图的对齐

按 `AGENTS.md` 要求复核 `docs/roadmap/internal-beta-implementation.md`:
本方案**不新增任何内测功能**,不触碰 P0/P1 条目的产品行为,只做结构整理。

需要提请注意的两点:

1. 路线图 P2 的验收条款要求 `bun run test` / `lint` / `typecheck` / `build` 全绿。
   本方案第 3.5 节的护栏会在**现有命令内部**新增失败条件,属于收紧门槛而非新增门槛,
   对 beta 交接是正向的;但要提前告知团队,避免交接时突然红。
2. 路线图已把 Plugins(step 6)、内容分发(step 7)、远程/HPC(step 8)放到 beta 之后。
   这几块正好是 `src/main/index.ts` 里最大的几段注册区。**建议在 step 6–8 动工前完成 P0 的
   主进程拆分**,否则后续每个 step 都要往一个 13,000 行文件里继续加,成本会指数上升。

---

## 8. 建议的起手式

先做 **P0-1(共享守卫 + 错误工具)**。理由:

- 改动机械、语义确定、风险接近零;
- 立刻让 246 处重复消失,给后续所有重构提供一个「共享层」的示范;
- 用一次小胜仗确认流程(特征化测试 → 迁移 → `lint` + `test` 全绿 → 单独提交)可以跑通,
  再拿这个流程去动 13,000 行的主进程文件。

紧接着做 **P0-2(通道常量 + 契约测试)**,因为它给后面每一次 IPC 搬移都装了安全网。
