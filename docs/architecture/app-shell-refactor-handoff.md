# App shell 拆分:交接文档

Date: 2026-10-19
Status: 进行中(`App.tsx` 5,569 → 4,481,目标 ≤ 1,200;第 5 节第 1–2 项已完成)

这份文档是给**接手这个任务的新会话**看的。读完它应当能直接开工,不需要回看之前的对话。

相关文档:

- 方案与技术债清单:[clean-code-optimization-plan.md](clean-code-optimization-plan.md)
- 缺陷审计:[design-defects-audit.md](design-defects-audit.md)
- 护栏(棘轮、预算、例外名单):[code-health-guards.md](code-health-guards.md)
- 测试门(为什么有些套件跳过、重试机制):[test-gate.md](test-gate.md)
- 前端边界契约:[frontend-feature-boundaries.md](frontend-feature-boundaries.md)

---

## 1. 目标与不变量

目标:`src/renderer/src/App.tsx` 降到 ≤ 1,200 行,并从 `scripts/check-frontend-boundaries.mjs` 的
`legacyOversizedFiles` 例外名单里删除。

不变量(违反任何一条就是走错方向,应立即停下):

- **不改变行为**。拆分只搬代码,不改语义;每次提交后完整测试门必须绿。
- **不为了行数而拆**。抽出的模块要有单一职责和清晰接口;如果抽完得到一个 45 props 的组件,
  那是把问题挪了个位置,不算进展。
- **棘轮只往下走**。`package.json` 的 `--max-warnings` 只能下调,不能上调;新增告警必须先修掉。
- **前端边界**:页面级 surface 放 `features/<feature>/<Feature>View.tsx`;共享 UI 放
  `components/`;共享逻辑放 `lib/`;feature 私有 hook 放 `features/<feature>/hooks/`。
- **每 3 轮**复查一次 `docs/roadmap/internal-beta-implementation.md`,确认没有漂到公测功能上。

---

## 2. 当前状态

| 指标                                                            | 值                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `App.tsx`                                                       | 4,481 行(`App()` 函数本体 4,253 行,即 228–4,480)           |
| `App()` 内 `useState` / `useEffect` / `useCallback` / `useMemo` | 13 / 15 / 104 / 6                                          |
| ESLint `--max-warnings`                                         | 1,470                                                      |
| 测试门                                                          | ≈7,092 例,0 失败,12 跳过                                   |
| 主进程边界基线                                                  | `index.ts` 13,002 行,234 通道,4 个超长文件(本次工作未触碰) |

### 已经抽出的模块(全部已合入)

| 模块                                                    | 行数 | 职责                                     |
| ------------------------------------------------------- | ---- | ---------------------------------------- |
| `components/app-shell/TopRightControls.tsx`             | 173  | 标题栏右侧的面板开关                     |
| `components/app-shell/WorkspaceTitlebar.tsx`            | 315  | 文件/资源两种标签条 + header             |
| `components/app-shell/AppResizeSeparator.tsx`           | 40   | 侧面板拖拽分隔条                         |
| `components/app-shell/AppWindowChrome.tsx`              | 128  | 窗口 chrome 两簇(mac 交通灯 + 右侧开关)  |
| `lib/app-shell/useAppDialogs.ts`                        | 73   | 9 组对话框状态                           |
| `lib/app-shell/useWorkspaceSidebar.ts`                  | 63   | 7 组导航侧栏状态                         |
| `lib/app-shell/useWorkspaceSidePanel.ts`                | 167  | 侧面板:槽位、宽度、停靠/浮层、拖拽改宽   |
| `features/workspace/WorkspaceView.tsx`                  | 234  | workspace 主列的布局与内容槽位选择       |
| `features/workspace/lib/workspaceViewMode.ts`           | 28   | 内容槽位优先级(纯函数)                   |
| `features/workspace/hooks/useWorkspaceTabNavigation.ts` | 356  | 标签选择/打开/关闭的语义                 |
| `features/chat/hooks/useChatRunControl.ts`              | 130  | 运行控制组合入口(停止生成 + 刷新信号)    |
| `features/chat/hooks/usePromptQueue.ts`                 | 90   | 每个会话的提示词队列状态                 |
| `features/chat/hooks/useManualCompaction.ts`            | 87   | 手动压缩:在途 key、渲染态、派发守卫      |
| `features/chat/lib/promptQueue.ts`                      | 101  | 队列纯变换(append/drop/shift/retarget)   |
| `features/file-preview/lib/pathOpeners.ts`              | 237  | 路径路由:包装结果 → 远程 → 笔记本 → 预览 |
| `features/file-preview/hooks/useFilePathOpeners.ts`     | 133  | 把路由绑定到 shell 拥有的各个 surface    |

对应的测试:`tests/app-workspace-*.test.ts`、`tests/app-window-chrome.test.ts`、
`tests/workspace-view-mode.test.ts`、`tests/workspace-tab-navigation.test.ts`、
`tests/prompt-queue.test.ts`、`tests/file-path-openers.test.ts`。

---

## 3. 每轮的工作循环

1. 选一块(App.tsx 里连续的、职责单一的代码)。
2. 先读调用点,数清依赖(`grep -c` 每个标识符),估算是否需要 `deps` 对象。
3. 抽到 `components/app-shell/`、`lib/app-shell/` 或 `features/workspace/`。
4. 跑验证:

   ```bash
   bun run typecheck                      # ~13s
   npx eslint --no-cache .                # 数告警总数,必须 ≤ 1,470
   npm run check:architecture             # 前端边界
   npm run check:main-boundaries          # 主进程基线(没动主进程就不用)
   bun run test:gate                      # ~11–20 分钟,必须 0 失败
   ```

5. 有源码断言测试失败时,**把断言指向新模块**,而不是放宽断言。参见第 4 节。
6. 提交,提交信息写清「搬了什么、为什么这个边界、验证方式、测试怎么改的」。

### 提速技巧

- 定向跑测试用 `node --import ./scripts/test-loader.mjs --test tests/xxx.test.ts`;
  直接 `node --test` 会因缺少转译 loader 报 `ERR_MODULE_NOT_FOUND`。
- **不要用 `--cache` 判断告警数**:缓存会让你读到旧结果(本仓库出现过 1,470 被读成 1,473/1,476)。
  用 `npx eslint --no-cache --format json .` 汇总。
- 改完测试文件一定要 `npx prettier --write`,否则 prettier 的 lint 告警会让总数超标。

---

## 4. 踩过的坑(按代价排序)

1. **把常量切走会连带切走 App 还在用的东西**。按行切片前先确认区域里的每个模块级常量在当前
   文件里还有没有别的引用(`titlebarChromeTopOffset` 就踩过)。
2. **常量块必须放在 import 之后**。放到组件导入中间会让 CJS 转译后的求值顺序出错,
   `tests/app-deferred-views.test.ts` 会报 `Cannot access 'x' before initialization`。
3. **hook 不能返回 ref**。`react-hooks` 编译器规则按语法判定,自定义 hook 返回的 `RefObject`
   会让 `.current =` 直接报错。ref 留在 App,等操作它的回调也搬走后再改成 hook 内部 API。
4. **`useCallback` 依赖数组会连锁**。搬走一个回调后,`exhaustive-deps` 会连带报警一批;
   逐个补依赖,别直接关规则。
5. **文件预览面板曾被构造两次**(标签内容 + 分析视图文件布局),props 几乎逐字重复。
   遇到这类重复,先合并再搬。
6. **源码断言测试是主要摩擦点**。处理方式:
   - 事实搬到新模块 → 断言也搬到新模块(读新文件)。
   - 断言的是「顺序/结构」→ 改成断言真正决定它的东西(例如"chrome 在拖拽层之后渲染"
     改成断言 `<AppWindowChrome` 的位置)。
   - 断言的是「某个内联箭头的文本」→ 把它命名成 `useCallback` 再按名字取,或者直接改成行为测试。
7. **AST-eval 测试不要在拆分后勉强保留**。`workspace-tab-navigation.test.ts` 原来从 App.tsx 切箭头
   函数进 vm 沙箱跑;拆到 hook 后重写成「渲染 hook → 拿 actions → 调记录型假依赖」,
   断言更强也更稳。
8. **测试门偶发负载敏感失败**。门内置串行重试;重试转绿视为抖动,但要在提交说明里写出来。
9. **新 hook 会撞上 `max-lines-per-function: 80`**。一次抽出 ~130 行的 hook 会把告警数顶到
   1,471,棘轮立刻失败。按职责拆成「队列 / 压缩 / 组合」三个 ≤80 行的小 hook 即可回到 1,470;
   拆完也让每个 hook 的依赖面更小。别用 `eslint-disable` 消掉它。
10. **`isBusy` 容易被误当成运行控制**。它只由 `useProviderAuth(setIsBusy, ...)` 写入,是鉴权闸,
    留在 App 里才对;`isSendingMessage`/`isSendingRef` 才是聊天运行状态。
11. **路由类回调优先做成 lib 纯函数 + 显式 targets,别再 AST 切闭包**。`pathOpeners` 把
    「哪个 surface 打开」写成 `f(targets, path, kind)`,store 读取也走 targets;测试直接传记录型
    targets,不再从 App 里切 `useCallback` 再拼 vm。`useFilePathOpeners` 只做绑定,`useMemo`
    统一重绑(路由用整个上下文决策,部分重绑会让两个入口对「当前项目」判断不一致)。
12. **源码断言要跟着事实走**。`analysis-view.test.ts` / `app-top-right-controls.test.ts` 里
    「App.tsx 含 `const xxx = useCallback`」的断言,搬走后应改成「新模块含 `export function xxx`」
    (并可加一条 `doesNotMatch` 防止回流),而不是放宽或删掉。

---

## 5. 剩余任务(按建议顺序)

`App.tsx` 现在还剩下三块(第 1、2 块已合入)。顺序按「依赖面从小到大」排列,不是按行数。

| 顺序 | 切片                                                                                                 | 位置                                          | 估算 | 状态   | 备注                                                    |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---- | ------ | ------------------------------------------------------- |
| 1    | 运行控制:`isBusy`/`isSendingMessage`/`compactingSessions`/`contextUsageRefreshKey` + 停止生成 + 队列 | 新 `features/chat/hooks/` 或 `lib/app-shell/` | ~300 | 已完成 | 实际只降 113 行:`isBusy` 是鉴权闸、发送 ref 留给第 4 块 |
| 2    | 文件/笔记本打开链                                                                                    | `features/file-preview/`                      | ~200 | 已完成 | 实际降 208 行;路由做成纯函数 + 显式 targets             |
| 3    | 请求桥接:`requestedConnectorJobId`/`requestedBackgroundJobKey`/`requestedTerminalInput`              | `features/jobs/` 或 `lib/app-shell/`          | ~120 | 待做   | 三个同构的小状态对,可以一次做完                         |
| 4    | 巨型回调:`onAgentEvent` 订阅(190 行)、`sendPromptText`(151 行、复杂度 39)                            | `features/chat/hooks/`                        | ~340 | 待做   | 先拆函数再做 hook;复杂度是这个文件最高的                |
| 5    | 应用级编排收尾:`navigateToView`、快捷键、通知、远程连接重试                                          | 看实际情况                                    | ~400 | 待做   | 做完这步 APP 才可能接近 1,200                           |

每完成一块,`App.tsx` 会降 100–300 行。**不要指望一次抽走很多**——JSX 只有 534 行,
其余全是编排逻辑;这是前面几轮反复验证过的测量结论。

到 1,200 行附近时,额外做两件收尾:

- 从 `scripts/check-frontend-boundaries.mjs` 的 `legacyOversizedFiles` 删除 `App.tsx`。
- 若 `App()` 仍然过长但已无可抽的部分,就在方案文档里记录它作为「编排根」的保留理由。

---

## 6. 后续任务(不在 `App.tsx` 这条线上)

这些在 [clean-code-optimization-plan.md](clean-code-optimization-plan.md) 的 P1/P2 里,
和 App 拆分**可以并行**,但不要同时开两条大改动的线。

| 任务                                         | 现状                               | 目标                                            | 入口                                                                             |
| -------------------------------------------- | ---------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| 主进程 `index.ts` IPC 拆分                   | 13,002 行、234 个 `ipcMain.handle` | ≤ 800 行,按域拆成注册模块                       | 方案文档 step 2–5;先用 `scripts/check-main-boundaries.mjs --update` 冻结当前上限 |
| 运行时上下文替换模块级 `let`                 | 24 个                              | 主进程可隔离测试                                | 方案 step 9                                                                      |
| `tests/main-integration.test.ts`             | 单文件数百个 `test()`              | 按域拆 6–8 个文件                               | 方案 step 10;该文件是 `eslint.config.mjs` 之外的独立风险                         |
| `MarkdownContent.tsx` / `NotebookCanvas.tsx` | 965 / 1,512 行                     | 按解析/渲染/交互拆                              | 方案 step 11                                                                     |
| 设计线缺陷                                   | 见审计文档「分支状态」表           | OMP-05 事件 DTO、X-01 会话身份、主进程 IPC 拆分 | `design-defects-audit.md`                                                        |
| 测试门抖动                                   | 偶发负载敏感失败                   | 定位到具体套件                                  | `test-gate.md`;先找 `rpc-launch`/`pty` 之外的抖动用例                            |

判优先级的原则:先做**能减少后续成本**的(主进程 IPC 拆分、棘轮护栏),
再做**能减少认知负担**的(App 拆分),最后才是零散清理。

---

## 7. 新会话开场方式

在 Phi 仓库根目录开新会话,把这段发给它:

```text
读 docs/architecture/app-shell-refactor-handoff.md,按第 5 节的顺序继续拆 App.tsx。
从第 1 项(运行控制)开始。每块单独提交、单独跑门;不要偏离文档第 1 节的不变量。
```

如果它需要确认当前数字,让它先跑:

```bash
wc -l src/renderer/src/App.tsx
git log --oneline -5
node -e "const s=require('fs').readFileSync('src/renderer/src/App.tsx','utf8');console.log('useCallback',(s.match(/useCallback\(/g)||[]).length)"
```
