# 会话运行时服务:设计

Date: 2026-10-21
Status: 阶段一已完成(SR-1 至 SR-4);阶段二进行中:SO-1 至 SO-4 已完成,DM 待做

相关文档:[main-ipc-split-handoff.md](main-ipc-split-handoff.md)(规则、审查清单、第 9 步状态类决定)、
[clean-code-optimization-plan.md](clean-code-optimization-plan.md)(第 3.1 节「主进程可隔离测试」)。

---

## 1. 为什么做

IPC 拆分、运行时上下文、超长函数、单一领域迁出都完成后,`src/main/index.ts` 仍有 6,224 行。2026-10-21 的
AST 测量:

- 17 个组装函数(启动阶段与 IPC 注册分组)引用 102 个 `index.ts` 内部名字,其中 **85 个被其他代码共用**。
  直接把组装搬到 `src/main/bootstrap/` 只能带一个约 100 项的依赖包过去,不做。
- 去掉 15 个枢纽函数后,仍有 147 个函数(约 2,500 行)连成一整块。其中约 1,800 行属于同一个领域:
  **会话运行时**(会话生命周期、key 与别名、清单约 1,140 行;提示词运行、压缩、恢复约 650 行)。
- 被引用最多的枢纽正是这块的访问函数:`resolveSessionKeyAlias` 30 处、`getPhiSessionIdForKey` 17 处、
  `findPhiManifestForSession` 16 处、`getLifecycleForKey` 10 处。

目标:把会话运行时的**状态**收进有明确接口的服务对象(阶段一),再把依赖这些状态的**编排**迁出 `index.ts`
(阶段二)。收益是主进程核心第一次能脱离 Electron 单独测试,85 个共享名字收敛成少数几个服务;之后
`bootstrap/` 拆分才变得便宜。

非目标:不改任何行为,不改会话 key 的格式,不重新设计别名或恢复机制,不碰渲染进程。

## 2. 现状:状态与访问方式

### 2.1 状态清单(模块级 `Map` / `Set`)

| 组              | 状态                                                                        | 键                                | 直接读写它的函数                                                                               |
| --------------- | --------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 会话 key 与身份 | `sessionKeyAliases`                                                         | 会话 key                          | `resolveSessionKeyAlias`、`aliasSessionKey`                                                    |
|                 | `phiSessionIdsByKey`                                                        | 规范会话 key                      | `getPhiSessionIdForKey`、`setPhiSessionIdForKey`                                               |
|                 | `runtimeSessionOrigins`                                                     | 运行时会话 ID                     | `resolveOriginSession`、`linkCreatedSession`、`resolveRemoteNotebookToolBackend`、一处顶层语句 |
| 生命周期        | `sessionLifecycles`                                                         | 会话 key(规范 key 与别名都会写入) | `getLifecycleForKey`、`aliasSessionKey`                                                        |
|                 | `sessionAbortControllers`                                                   | 会话 key                          | `cleanupSessionRecord`、`prepareSessionCreationRuntime`                                        |
|                 | `cleanupBarriersByPath`、`unknownPathCleanupBarriers`                       | 会话文件路径                      | `cleanupSessionRecord`、`waitForSessionCleanup`                                                |
| 会话偏好        | `sessionModelSelections`、`sessionThinkingLevels`、`sessionPermissionModes` | 规范会话 key                      | `resolveSession*` 三个解析函数;另有多处直接读写(权限模式共 8 个函数)                           |
| 提示词运行      | `promptQueues`、`promptGenerations`                                         | 规范会话 key                      | 各自一对 get/set(advance)函数                                                                  |
|                 | `activePromptRuns`                                                          | 规范会话 key                      | 4 个访问函数,另有 6 处 `[...values()].find/filter` 遍历                                        |
|                 | `runtimeRecoveryOperations`、`runtimeRecoveryFailures`                      | **Phi 会话 ID**                   | 准入、标题、停止全部、两个 IPC 依赖构造                                                        |
|                 | `manualCompactionIds`、`manualCompactionOperations`                         | **Phi 会话 ID**                   | 唤醒、准入、空闲检查、两个 IPC 依赖构造                                                        |

当前会话(`currentSessionKey` 等)已经在 RC-2 收进 `SessionState`,不在本设计的迁移范围,但服务会读它。

暂不纳入:续写计数(`automaticContinuations`、`pendingContinuations`)、`reportedAgentRuns`、标题任务三张表、
`loadedSkillNamesBySession`。它们属于「会话之上的功能」,等阶段一完成后再判断归属。

### 2.2 必须原样保留的语义

1. **别名规范化在访问函数内部完成**。除 `resolveSessionKeyAlias` 本身外,上表所有按会话 key 的访问函数都会先
   解析成规范 key 再读写。服务方法必须同样在内部规范化,而且**不能给现在没做规范化的调用点额外加上**
   (例如 `runtimeSessionOrigins`、按 Phi 会话 ID 的锁)。
2. **别名解析能处理循环**:沿别名链前进,遇到已访问过的 key 就停在当前 key。
3. **建立别名会联动生命周期**:`aliasSessionKey(alias, canonical)` 先把 `canonical` 规范化;若与 `alias` 相同就
   返回;否则写入别名,并在规范 key 已有生命周期对象时,把**同一个对象**也挂到 `alias` 上。
4. **`getLifecycleForKey` 会写入**:规范 key 没有生命周期对象时新建并登记;如果传入的是别名,还会把同一个对象
   挂到这个别名上。
5. **`deleteActivePromptRun` 有副作用顺序**:先取消该运行的浏览器任务、异步清理它的标签页,再在「表里的仍是这个
   运行对象」时删除。浏览器副作用不属于注册表,但顺序必须保持。
6. **遍历顺序是行为**:6 处 `[...activePromptRuns.values()].find(...)` 依赖 Map 插入顺序取第一个匹配。
7. **两套键空间**:恢复与压缩锁按 Phi 会话 ID,其余按会话 key,不能混用。
8. **对象身份**:生命周期对象、`PromptRun` 对象、队列 Promise 都按引用比较,服务不能复制或包装它们。
9. **`createSessionKey` 的默认参数**读取 `SessionState.freshSessionCounter`(调用时读取)。

## 3. 设计

### 3.1 分层

```
SessionKeyRegistry            会话 key 创建、别名、规范化比较、Phi 会话 ID、运行时会话来源
   ↑ canonicalize
SessionLifecycleRegistry      生命周期对象、中止控制器、清理屏障
SessionPreferences            模型 / 思考档位 / 权限模式
PromptRunRegistry             队列、代数、活跃运行、恢复锁、压缩锁
   ↑
SessionRuntime                组合以上四者;只放跨注册表的操作(建立别名)
```

- 沿用第 9 步的决定:**封装成带方法的状态类**,字段私有,读取走 getter 或查询方法,写入是按意图命名的方法,
  方法体就是原来的语句。
- 下层只认识上层传进来的 `canonicalize(key)` 函数,不直接依赖 `SessionKeyRegistry` 的类型,便于单测。
- 这些类不 import Electron,不读写磁盘;需要清单查找、浏览器清理之类协作者时,由调用方在 `index.ts` 编排,
  或以函数参数传入。

### 3.2 各类的职责与方法(与现有访问函数一一对应)

**`SessionKeyRegistry`**(`src/main/app-state/session-key-registry.ts`)

| 方法                                                | 对应现有函数                                      | 说明                                                                    |
| --------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `createKey(path, cwd, freshId?)`                    | `createSessionKey`                                | `freshId` 缺省时通过注入的 getter 读 `SessionState.freshSessionCounter` |
| `createPhiKey(sessionId, cwd)`                      | `createPhiSessionKey`                             | `phiOnlySessionPath` 作为注入函数                                       |
| `canonicalize(key)`                                 | `resolveSessionKeyAlias`                          | 循环保护逻辑原样搬入                                                    |
| `sameCanonical(a, b)`                               | `sameCanonicalSessionKey`                         |                                                                         |
| `setAlias(alias, canonicalKey)`                     | `aliasSessionKey` 的别名部分                      | 只写别名表;生命周期联动在 `SessionRuntime`                              |
| `phiSessionIdFor(key)` / `setPhiSessionId(key, id)` | `getPhiSessionIdForKey` / `setPhiSessionIdForKey` |                                                                         |
| `originFor(runtimeSessionId)` / `recordOrigin(...)` | `runtimeSessionOrigins` 的读写点                  | 不做别名规范化(现状如此)                                                |

**`SessionLifecycleRegistry`**(`session-lifecycle-registry.ts`)

| 方法                                                       | 对应现有函数                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `forKey(key)`                                              | `getLifecycleForKey`(含「别名也挂同一对象」)                                                 |
| `shareWithAlias(alias, canonicalKey)`                      | `aliasSessionKey` 的生命周期部分                                                             |
| `installAbortController(key, controller)` / 相应读取与删除 | `sessionAbortControllers` 的读写点                                                           |
| `registerCleanup(...)` / `waitForCleanup(snapshot)`        | `cleanupSessionRecord` / `waitForSessionCleanup` 里的屏障表部分;会话中止与释放仍由调用方编排 |

**`SessionPreferences`**(`session-preferences.ts`)

| 方法                                                     | 对应现有函数                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `modelSelectionFor(key)` / `setModelSelection(key, sel)` | `sessionModelSelections` 的读写点;`resolveSessionModelSelection` 中「查表之外的回退规则」仍在调用方 |
| `thinkingLevelFor` / `setThinkingLevel`                  | 同上                                                                                                |
| `permissionModeFor` / `setPermissionMode`                | 同上;直接读写它的 8 个函数逐一换成方法调用                                                          |

解析函数(`resolveSession*`)里还读清单与项目默认值,第一步保留在 `index.ts`,只把查表与写表换成方法调用。

**`PromptRunRegistry`**(`prompt-run-registry.ts`)

| 方法                                                                                               | 对应现有函数 / 读写点                                                  |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `queueFor(key)` / `setQueue(key, queue)`                                                           | `getPromptQueue` / `setPromptQueue`                                    |
| `generationFor(key)` / `advanceGeneration(key)`                                                    | `getPromptGeneration` / `advancePromptGeneration`                      |
| `activeRun(key)` / `hasActiveRun(key)` / `setActiveRun(key, run)`                                  | 同名访问函数                                                           |
| `deleteActiveRunIfCurrent(key, run)`                                                               | `deleteActivePromptRun` 的删除部分;浏览器副作用留在调用方,在其之前执行 |
| `findActiveRun(predicate)` / `activeRuns()` / `activeEntries()`                                    | 6 处遍历;保持插入顺序                                                  |
| `recoveryOperation(phiId)` / `beginRecovery` / `endRecovery` / `recoveryFailure...`                | `runtimeRecovery*` 的读写点(按 Phi 会话 ID)                            |
| `isCompacting(phiId)` / `beginManualCompaction` / `endManualCompaction` / `compactionOperation...` | `manualCompaction*` 的读写点(按 Phi 会话 ID)                           |

**`SessionRuntime`**(`session-runtime.ts`)

- 构造时创建四个注册表,把 `keys.canonicalize` 传给另外三个。
- 唯一的跨表方法:`alias(aliasKey, canonicalKey)`,方法体是 `aliasSessionKey` 的原语句(先规范化、相同则返回、
  写别名、联动生命周期)。
- 暴露 `keys`、`lifecycles`、`preferences`、`runs` 四个只读属性。

### 3.3 创建与接入

- `MainRuntimeContext` 增加 `sessions: SessionRuntime`,在 `createMainRuntimeContext` 里创建(当前在 `index.ts`
  第 1095 行)。这些表现在都是空初始化,创建时机前移或后移不改变行为;但每一刀都要检查原 `Map` 声明与上下文
  创建点之间有没有顶层代码立即读写它们。
- IPC 模块与已迁出的会话模块**只拿窄接口**:用 `Pick<PromptRunRegistry, 'activeRun' | 'generationFor'>` 这类
  类型声明依赖,不传整个 `SessionRuntime`,也不传 `runtime`。
- 旧的访问函数在对应切片里**直接删除**,调用点改为调用服务方法;不留一行转发的包装函数。

### 3.4 阶段二:编排迁出(阶段一完成后再细化)

阶段一只搬状态和访问函数,`index.ts` 预计只少约 200 行,但共享名字会大幅减少。真正减行数的是阶段二:把依赖
这些状态的编排搬到 `src/main/session-runtime/`,依赖服务对象和少量协作者,而不是 `index.ts`:

- 会话切换与创建入口:`disposeAndSwitchSession`、`createPhiManagedSession`、`createRemoteManagedSession` 等;
- LF-3 留在 `index.ts` 的会话创建阶段;
- LF-2 留在 `index.ts` 的提示词运行阶段(准入、分配、排队、收尾)。

预计 `index.ts` 再少约 1,500 行。阶段二开始前重新测量耦合,单独写切片计划交用户确认。

## 4. 迁移切片

| 刀   | 内容                                                                                                                                                                                  | 主要风险                                       | 验收要点                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| SR-1 | `SessionKeyRegistry` + `SessionRuntime` 骨架;别名、Phi 会话 ID、运行时会话来源迁入;`aliasSessionKey` 暂由 `SessionRuntime.alias` 协调,生命周期部分先调用 `index.ts` 里的表(SR-2 再收) | 别名语义、30 处调用点                          | 别名链与循环的单测;调用点不新增 / 不减少规范化    |
| SR-2 | `SessionLifecycleRegistry`;生命周期、中止控制器、清理屏障迁入;`alias` 的联动收进 `SessionRuntime`                                                                                     | 「别名挂同一对象」、清理屏障时序               | 对象身份单测;清理与创建的特征化测试原样通过       |
| SR-3 | `SessionPreferences`;三张偏好表迁入,直接读写权限模式表的 8 个函数换成方法调用                                                                                                         | 权限模式写入点多                               | 每个写入点对照表;与 `SessionState` 的配合顺序不变 |
| SR-4 | `PromptRunRegistry`;队列、代数、活跃运行、恢复锁、压缩锁迁入                                                                                                                          | 遍历顺序、两套键空间、删除时的浏览器副作用顺序 | 插入顺序单测;按 Phi 会话 ID 的锁不被规范化        |
| 收尾 | 更新交接文档;测量共享名字和 `index.ts` 行数;写阶段二切片计划交用户确认                                                                                                                | —                                              | —                                                 |

规则沿用交接文档第 1、4 节:每刀一个 worktree 交给 Codex,串行执行;先写测试;原语句只搬不改;不凑行数;
审查方在沙箱外跑全量门,合入后在主仓库重新统计告警。

## 5. 测试策略

1. **每个类先写单元测试**(`tests/session-runtime.test.ts`,或按类分文件),不依赖 Electron:
   - 别名:单跳、多跳、循环、`alias === canonical` 时不写入;
   - 生命周期:`forKey` 新建并登记、别名拿到同一对象、`alias` 联动;
   - 运行:代数单调递增、队列默认 `Promise.resolve()`、`deleteActiveRunIfCurrent` 只删同一对象、`findActiveRun`
     按插入顺序取第一个;
   - 锁:按 Phi 会话 ID,不经过规范化。
2. **集成层**:`main-integration` 已有大量会话切换、创建、运行、恢复、压缩的特征化测试(含 IPC-6a、LF-2、LF-3
   新增的),每刀必须原样通过;只改源码文本类断言的位置,不放宽。
3. **审查**:每刀对照第 2.2 节逐条核对;机械比对删除的访问函数与新方法的语句;核对 `[...values()]` 遍历点数量
   不变;全量门首轮通过。

## 6. 风险与缓解

| 风险                                         | 缓解                                                              |
| -------------------------------------------- | ----------------------------------------------------------------- |
| 「顺手」给某个调用点加上或去掉别名规范化     | 方法与原访问函数一一对应;审查时逐个核对调用点是否原本经过访问函数 |
| Map 遍历顺序改变                             | 继续用同一个 `Map` 实例、按原顺序写入;单测钉住                    |
| 对象被复制或包装导致引用比较失效             | 注册表只存原对象;单测断言 `===`                                   |
| 上下文创建点与原声明之间的顶层代码读写这些表 | 每刀检查;必要时调整创建点并在报告说明                             |
| 依赖面膨胀                                   | 模块只拿 `Pick<>` 窄接口;超过约 12 项必须分组                     |
| 阶段一减行不多,被误判为没进展                | 本文第 3.4 节已说明;验收看共享名字数量和可测性,不看行数           |

## 7. 目标修订建议

方案中「`index.ts` ≤ 800 行」在不做本设计的前提下达不到。建议改成分阶段目标:

- 阶段一完成:`index.ts` 约 6,000 行,组装函数依赖的共享名字从 85 降到约 20;
- 阶段二完成:约 4,000 行;
- 之后再评估 `bootstrap/` 拆分,向 ≤ 800 推进。

## 8. 需要用户确认的点

1. 四个状态类放在 `src/main/app-state/`(与第 9 步一致),阶段二的编排放 `src/main/session-runtime/`。
2. 旧访问函数在切片内直接删除,不保留转发包装。
3. 续写计数、标题任务、已加载技能等表暂不纳入,阶段一完成后再判断。
4. 阶段二不在本次确认范围,阶段一完成后单独出切片计划。
5. 采纳第 7 节的分阶段目标,替换方案中的「≤ 800 行」。

---

## 9. 阶段一结果(2026-10-21)

| 刀   | 内容                                                       | 提交       | `index.ts` 行数 |
| ---- | ---------------------------------------------------------- | ---------- | --------------- |
| SR-1 | `SessionKeyRegistry` 与 `SessionRuntime` 骨架              | `3b3edb97` | 6,224 → 6,191   |
| SR-2 | `SessionLifecycleRegistry`(生命周期、中止控制器、清理屏障) | `05007b74` | 6,191 → 6,149   |
| SR-3 | `SessionPreferences`(三张偏好表,窄接口、不做规范化)        | `35e8018f` | 6,149           |
| SR-4 | `PromptRunRegistry`(队列、代数、活跃运行、恢复锁、压缩锁)  | `282d5b54` | 6,149 → 6,099   |

每刀全量门首轮 0 失败;告警保持 1,396。`index.ts` 已没有会话运行时的模块级状态表。

**耦合指标(同一脚本、同一口径)**:组装函数依赖的 `index.ts` 内部名字 102 → 86,其中被其他代码共用的
85 → 69。第 7 节预估的「约 20」偏乐观,原因是当时假设共享名字大多是状态访问函数;实测剩下的 69 个是:

| 类别                         | 约数 | 说明                                                                                                                           |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 应用级基础设施               | 12   | `runtime`、`AGENT_DIR`、`getActiveWindow`、`sendToAllWindows`、`logUnexpectedError`、`createWindow` 等;组装根本来就该有        |
| 在 `index.ts` 构造的协作对象 | 16   | `runnerRegistry`、`environmentBuilds`、`wrapperJobs`、`jupyterServerRegistry`、`remoteConnectionTracker` 等;在这里创建并往下传 |
| 会话编排函数                 | 20   | 切换、创建、提示词运行、清单查找、偏好解析、会话来源;阶段二目标                                                                |
| 其他领域辅助函数             | 21   | 远端项目上下文 8、内容包 6、notebook 4、模型解析 2 等                                                                          |

约 28 个(前两类)是组装根的合理下限,不追求消除。

## 10. 阶段二计划:编排迁出

把依赖会话服务的编排搬到 `src/main/session-runtime/`(与 `app-state/` 的状态类分开:这里放流程,那里放状态)。
每个模块依赖 `SessionRuntime` 的窄接口和少量协作者,不 import `index.ts`。

| 刀   | 内容                                                                                                                                                                         | 估算行数 | 风险                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------- |
| SO-1 | 清单查找与三个偏好解析(`findPhiManifestForSession`、`resolveSession*`、`projectForSession`)                                                                                  | ~60      | 低                                |
| SO-2 | 会话来源与链接(`linkPhiManagedSessionKey`、`runtimeSessionPath`、`resolveOriginSession`、`currentRuntimeOriginScope`、`resolveRecoverableJobOrigin` 等)                      | ~110     | 中                                |
| SO-3 | 会话切换与创建(`disposeAndSwitchSession`、`createPhiManagedSession`、`createRemoteManagedSession`、`invalidateAgentSession`、`getAgentSession` 与 LF-3 留下的 17 个创建阶段) | ~650     | 高;可再拆成「切换」与「创建」两刀 |
| SO-4 | 提示词运行编排(LF-2 留下的阶段、`stopPromptRun`、`stopAllPromptRuns`、`captureSessionControlTarget`)                                                                         | ~350     | 高                                |
| DM   | 其他领域小块(远端项目上下文、内容包、notebook),沿用 SL 做法,可与 SO 交替进行                                                                                                 | ~265     | 低                                |

合计约 1,450 行。考虑新增的接线代码,阶段二完成后 `index.ts` 预计 **4,600–4,700 行**(修正第 7 节的「约 4,000」)。
共享名字预计降到 30–35 个,接近上面说的合理下限。

执行状态(2026-10-21):SO-1、SO-2、SO-3 已完成。SO-4 拆成三段并全部完成:SO-4a 迁出
`captureSessionControlTarget`(`session-runtime/session-control-target.ts`)与
`stopPromptRun`/`stopAllPromptRuns`(`session-runtime/prompt-run-stop.ts`);
SO-4b1 迁出目标解析与准入(`session-runtime/prompt-run-admission.ts`);
SO-4b2 迁出运行状态/入队准备(`session-runtime/prompt-run-start.ts`)与
队列/执行/收尾(`session-runtime/prompt-run-queue.ts`)。
对应单测为 `tests/prompt-run-stop.test.ts`、`tests/prompt-run-admission.test.ts`、
`tests/prompt-run-start.test.ts`;`index.ts` 4,388 行。DM(远端项目上下文、内容包、notebook)仍待做。

顺序建议:SO-1 → SO-2 → DM(穿插)→ SO-3(切换)→ SO-3(创建)→ SO-4。前两刀风险低、能先定下 `session-runtime/`
的依赖写法;高风险的切换、创建、运行放在后面,每刀先补特征化测试。规则沿用第 4 节与交接文档第 1、4 节。

需要确认:

1. 编排放 `src/main/session-runtime/`,与 `app-state/` 的状态类分开。
2. 采纳上面的顺序与切片(SO-3 拆成两刀)。
3. 修正后的阶段二目标:`index.ts` 4,600–4,700 行,共享名字 30–35 个。
