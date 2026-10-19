# Test Gate

Date: 2026-10-19
Status: 生效中的本地回归门

## 为什么需要它

`bun run test` 会跑全部 884 个顶层套件,其中一部分依赖宿主能力(用 `/bin/ps` 校验进程组、真实子进程、真实 bun worker)。在没有这些能力的环境里——CI 沙箱、受限容器——它们必然失败,于是"红灯"不再意味着"代码坏了",回归门失去信号价值。

固定做法:**把已知失败显式登记下来,并让门在运行时重新探测宿主能力**。有能力的机器会照常运行这些套件;受限环境自动跳过并打印原因。

## 用法

```sh
bun run test:gate            # 日常回归门:跑除已知失败外的全部套件
bun run test:known-failures  # 只跑被跳过的套件,用于在正常机器上复核
node scripts/test-gate.mjs --list   # 只看计划:跑哪些、跳过哪些、探测结果
```

`bun run test` 保留原样,作为"全量"入口;beta 交接仍以全量结果为准,但在受限环境下应改用 `test:gate`。

## 已知失败清单

登记文件:`scripts/test-known-failures.json`。每条必须包含:

| 字段 | 含义 |
| --- | --- |
| `file` | 测试文件路径,顶层 `tests/*.test.ts` |
| `kind` | `environment`(宿主能力缺失)或 `fixture`(真实红灯) |
| `probe` | `kind=environment` 时的探测项,目前支持 `ps` |
| `owner` | 负责清理的模块 |
| `reviewBy` | 复核日期,过期会被门判定为 stale 并**失败** |
| `reason` | 具体现象,必须可复现 |

三类行为:

1. `kind=environment` 且探测项**不可用** → 跳过,打印原因。
2. `kind=environment` 且探测项**变得可用** → 自动恢复运行(不需要改清单)。这条很重要:能力恢复后不能继续静默跳过。
3. `kind=fixture` → 始终跳过,靠 `reviewBy` 逼着修。

清单**只减不增**。新增条目必须在 PR 里说明为什么不是代码问题。

## 环境探测

| 探测项 | 方法 | 缺失时的现象 |
| --- | --- | --- |
| `ps` | `execFileSync('/bin/ps', ['-o','pid=','-p',pid])` | 生产启动器报 `phi-run: /bin/ps: Operation not permitted` 与 `PHI_LAUNCH:NOT_GROUP_LEADER`,断言在业务代码运行前就失败 |

2026-10-19 在当前开发环境实测:`ps` 不可用,于是 3 个套件被跳过
(`t14production-child-controls`、`engine-facade-checkpoint`、`engine-facade-child-composition`)。
这三者失败时业务代码尚未执行,属于环境限制而非回归。

## 分级

| 层 | 内容 | 期望时长 |
| --- | --- | --- |
| 快档 = `test:gate` | 881 个顶层套件,排除已知失败 | 分钟级 |
| 慢档 = `test` | 全量,含真实子进程套件 | 20 分钟以上,仅里程碑与交接 |

## 与整洁度方案的关系

`docs/architecture/clean-code-optimization-plan.md` 的全部切片都以 `test:gate` + `typecheck` + `lint` 作为回归门。
在这套门落地之前,机械迁移没有可信信号,这是先治理验证门、再继续批量重构的原因。

`bun run typecheck:tests` 目前在干净检出上有约 450 个既有错误(测试 tsconfig 与 `AgentEventSummary` 等类型不同步),
不纳入本门,单独治理;改动若触及类型定义,仍需人工新增对应断言。
