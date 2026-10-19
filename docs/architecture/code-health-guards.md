# 代码健康护栏

Date: 2026-10-19
Status: 生效中

两份检查,一个目的:**让结构债务只减不增**,不靠自觉。

| 护栏 | 位置 | 拦什么 |
| --- | --- | --- |
| 前端结构 | `scripts/check-frontend-boundaries.mjs` | renderer 里新增页面级 view 到共享层、超过 1000 行且无例外登记的文件 |
| 主进程结构 | `scripts/check-main-boundaries.mjs` | `src/main/index.ts` 变长、IPC 注册回流、`src/main` 下出现新的超大山头 |
| 复杂度预算 | `eslint --max-warnings` in `package.json` | 规则告警总数增加 |
| 引擎边界 | `scripts/check-engine-boundary.mjs` | 引擎目录外引用 `@oh-my-pi/*`,内部子路径未登记 |

全部随 `bun run lint` 运行。

## 主进程结构:冻结基线

`src/main/index.ts` 有 13,002 行、234 个 `ipcMain.handle`,无法一次拆完,所以这里用**棘轮**而不是绝对阈值:

```sh
bun run check:main-boundaries          # 校验
node scripts/check-main-boundaries.mjs --update   # 拆分后把更低的数字锁进基线
```

基线文件:`scripts/main-boundaries-baseline.json`。

| 规则 | 现状 | 目标 |
| --- | --- | --- |
| `src/main/index.ts` 行数 | 13,002(上限 13,002) | ≤ 800 |
| `src/main/index.ts` 的 `ipcMain.handle` 数 | 234(上限 234) | 0 |
| `src/main` 下单文件行数 | 4 个文件有独立上限 | ≤ 1,000 |

行为:

- 任何数字**变大** → 失败,并提示"把一个域搬出去,而不是继续加"。
- 任何数字**变小** → 只提示 `ratchet available`,不改文件;拆分完成后跑 `--update` 锁住新低点。
- 新文件超过 1,000 行且未登记 → 失败。

之所以不能照搬 renderer 的绝对规则:`ipcMain.handle` 从一个文件搬到另一个文件时,数量下降要人确认;冻结基线让"拆了一半"也能通过。

## 复杂度预算:warning 总数

`eslint.config.mjs` 新增(仅对 `src/**`,warn 级别):

| 规则 | 阈值 |
| --- | --- |
| `complexity` | 15 |
| `max-depth` | 3 |
| `max-params` | 5 |
| `max-lines` | 600(忽略空行与注释) |
| `max-lines-per-function` | 80(同上) |

存量代码必然大量超标,所以真正的闸门是 `--max-warnings`:

```json
"lint": "... eslint --cache . --max-warnings 1470"
```

冻结在 1,470(2026-10-19 从 1,472 下调:App.tsx 的标题栏组件迁出后,标签项拆成独立组件,消掉两条 `max-lines-per-function`)。**新增任何一条告警都会让 `bun run lint` 失败**;清理存量后把数字调低即可,它只能往下走。

试过并对齐过的一条:**不要**按目录把规则设成 `error` —— `src/shared` 里 `notebookCodeGeneration.ts` 有 715 行,直接 error 会让 lint 立刻红;总数预算对"新增"的约束是一样的,而且不需要给每个目录维护例外。

## 例外与退出条件

- 前端检查的 `legacyOversizedFiles` 目前有 5 条临时例外,每条都应在拆分完成后删除。
- 主进程基线的每条上限都是待消除目标,不是许可。
- 引擎边界的白名单只允许减少;新增需要 PR 说明理由。

## 与重构顺序的关系

护栏先上,再动结构:否则拆 `index.ts` 的过程中很容易一边减少一边新增,最后看不出净进展。当前顺序:

1. 护栏(本文)
2. `App.tsx` 按状态所有权拆分
3. 事件契约收口(OMP-05)
4. 主进程按 IPC 域拆分,每完成一个域跑一次 `--update`

`docs/architecture/clean-code-optimization-plan.md` 给出切片的详细做法与验收标准。
