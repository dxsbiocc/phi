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

日常改动优先用 `--changed`,只跑受这次改动影响的套件(见下文「按改动选择」):

```sh
node scripts/test-gate.mjs --changed          # 对比 main + 未提交/未跟踪的改动
node scripts/test-gate.mjs --changed=<ref>    # 对比任意 ref
```

`bun run test` 保留原样,作为"全量"入口;beta 交接仍以全量结果为准,但在受限环境下应改用 `test:gate`。

## 已知失败清单

登记文件:`scripts/test-known-failures.json`。结构分两层:

- `profiles`:共享同一成因的一组套件的说明(原因、负责模块、复核日期、需要的探测项)。
- `entries`:只写文件路径与所属 profile;真实红灯条目直接内联自己的字段。

每个 profile / 条目必须包含:

| 字段         | 含义                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `kind`       | `environment`(宿主能力缺失)或 `fixture`(真实红灯)                    |
| `probes`     | `kind=environment` 时需要的探测项数组,目前支持 `ps`、`flock`         |
| `alwaysSkip` | `kind=environment` 且能力无法廉价探测时置 true,跳过依据写进 `reason` |
| `owner`      | 负责清理的模块                                                       |
| `reviewBy`   | 复核日期,过期会被门判定为 stale 并**失败**                           |
| `reason`     | 具体现象与判定依据,必须可复现                                        |

三类行为:

1. `kind=environment` 且探测项**不可用** → 跳过,打印原因。
2. `kind=environment` 且探测项**变得可用** → 自动恢复运行(不需要改清单)。这条很重要:能力恢复后不能继续静默跳过。
3. `kind=fixture` → 始终跳过,靠 `reviewBy` 逼着修。

清单**只减不增**。新增条目必须在 PR 里说明为什么不是代码问题。

## 环境探测

| 探测项  | 方法                                              | 为什么需要                                                                                             |
| ------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ps`    | `execFileSync('/bin/ps', ['-o','pid=','-p',pid])` | RPC 启动包装脚本用 `ps -o pgid=` 证明自己是进程组组长,不是就 `exit 78` + `PHI_LAUNCH:NOT_GROUP_LEADER` |
| `flock` | `sh -c 'command -v flock'`                        | 同一脚本用 `flock` 拿 run lock,拿不到就 `exit 75` + `PHI_LAUNCH:RUN_LOCK_BUSY`                         |

2026-10-19 在当前开发环境实测:两项都不可用(`ps` 被沙箱拒绝,`flock` 在 macOS 上默认不存在),
于是 38 个真实启动套件被跳过。判定依据是一次对照实验:**给 PATH 补上 `flock`/`ps` 替身之后,
这些套件全绿**;唯一仍需真实 `flock` 的是 `engine-rpc-run-guard.test.ts`,因为它测的是锁竞争与 TERM/KILL 接管。

还有两类能力无法廉价探测,由 `alwaysSkip` 处理:

| profile            | 缺失的能力                        | 现象                                                                                     |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `electron-sandbox` | 能启动真实 Electron BrowserWindow | `sandbox initialization failed: Operation not permitted`(`notebook-editor-retention`)    |
| `real-ssh-server`  | 可达的真实 OpenSSH 服务器         | `RemoteSshConnectionError: network_unreachable`,200ms 内失败(`remote-ssh-real-identity`) |

macOS 开发者想本地运行这些套件:`brew install flock`,并确保 `ps` 未被安全策略禁用。
Linux 服务器(远端运行时的真实目标)两者都自带。

## 抖动与真失败

系统负载高时,个别用例会失败或超时,而单跑必然通过(实测:`workspace-host-contract.ts` 里的
"only one concurrent expected-hash write win" 在全量并发下偶发失败,单跑 3/3 通过)。

门在首次运行失败后会自动**串行重试失败的那几个套件**,并区分两种情况:

| 情况       | 门的输出                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 重试通过   | `Retry passed: the failure is load-sensitive, not a regression.` 退出码 0 |
| 重试仍失败 | `Retry failed too: this is a real failure.` 退出码非 0                    |

失败套件的识别覆盖共享测试体:`tests/workspace-host-contract.ts` 这类文件被多个 runner 导入,
报告里只出现契约文件路径,门会反查引用它的 runner 再重试。用 `--no-retry` 可关闭重试。

重试通过不代表可以无视:它说明该用例对并发敏感,应当修测试隔离,而不是长期依赖重试。

## 分级

| 层                 | 内容                                    | 期望时长                   |
| ------------------ | --------------------------------------- | -------------------------- |
| 快档 = `test:gate` | 844 个顶层套件,排除 40 个已知能力受限项 | 分钟级                     |
| 慢档 = `test`      | 全量,含真实子进程套件                   | 20 分钟以上,仅里程碑与交接 |

## 按改动选择(`--changed`)

`scripts/test-affected.mjs` 从每个测试文件出发,沿静态 import、动态 import 和带引号的仓内路径
(读源码文本的测试、按路径拉起的 fixture)求可达文件集合;改动命中集合的套件才会运行。

- 只改 `docs/`、根目录 `*.md` → 不跑任何套件。
- 改动落在导入图追不到的地方(`package.json`、`bun.lock`、`scripts/`、`resources/`、tsconfig 等)→ 退回完整选择。
- 结果偏保守:读 `App.tsx` 源码的测试会连带 App 的全部依赖,宁可多跑,不漏跑。

提交前、里程碑和交接仍跑完整的 `test:gate`。

## 耗时与提速(2026-10-20 实测)

- 基线:855 个套件,并发 4,墙钟约 12 分钟(宿主同时有其他任务)。套件内耗时合计约 2,280 秒,
  58 个 > 10 秒的套件占 80%,主要是假 SSH / Slurm / 远端部署类套件,多数时间在等待而不是算。
- 每个测试文件是独立进程,原来每个进程都要加载 TypeScript 编译器并重新转译共享模块。
  `scripts/test-loader.mjs` 现在把转译结果按「源码 + 编译器版本 + 选项」缓存到
  `node_modules/.cache/phi-test-transpile/`,命中时不加载编译器。200 个小套件:无缓存 27.1 秒 → 命中 9.6 秒。
- 提速后空闲宿主实测:855 个套件,并发 7,墙钟 **9 分钟**(7,117 例)。
- 并发提高后曾有 4 个套件首轮失败、串行重试通过。根因与修法(只改测试,未改产品与断言):
  - `jupyter-runtime-backend`、`remote-jupyter-server`(连带 `remote-notebook-tools-e2e`):
    启动脚本的资源监控每 5 秒用 `ps -eo pgid=,rss=,nlwp=,time=` 采样,读不到就停掉 Jupyter。
    测试用的假 `ps` 不认这条采样,所以首次采样必然杀掉假 Jupyter;空闲时测试在 5 秒内跑完看不出,
    负载下启动变慢就会被杀,随后测试自己的 20 秒等待超时。假 `ps` 现在用真实进程表回答采样
    (macOS 无 nlwp,线程数报 1);测试自己的等待上限放宽到 60 秒,e2e 套件原 2 秒等待同样改为 60 秒。
  - `workspace-host-prelaunch-cancellation`:等待后台启动写出 `exit_code` 只轮询 2 秒且超时后静默继续,
    改为 20 秒截止并在超时时明确报错。
  - `remote-nextflow-install-flow`:探测脚本对每个版本检查有固定 3 秒守卫(`sleep 3`),十个检查同时启动时
    负载下会误报 "version check timed out"。测试在 PATH 前放一个 `sleep` 垫片,只把这个守卫拉长到最多
    25 秒,并随父进程结束退出。
  - 复现方法:同一套件并行 6–12 份加 20 个以上 `yes` 占满 CPU,修复前每份必挂,修复后全部通过;
    全量门在 `PHI_TEST_CONCURRENCY=14 --no-retry` 下连跑 3 次(各约 5 分钟),上述套件首轮全过。
  - 并发 14 下另有 3 个套件偶发首轮失败,共同根因是 macOS 对**新写出或新复制的可执行文件**首次执行时
    要做 XProtect 扫描,且全机排队:空闲时一个 sh 脚本约 0.2 秒、复制出的 63 MB bun 约 1 秒;60 个新脚本
    同时首次执行,中位等 7.4 秒、最长 13.7 秒,再执行一次全部 10 毫秒。门里大量套件同时写假命令,
    扫描队列就会吃掉固定超时。只用 `yes` 占 CPU 复现不出来,要再加一组不停「写新脚本并执行」的进程。
    修法(只改测试):`tests/helpers/firstExec.ts` 的 `warmExecutable` 在交给产品计时之前,
    用 60 秒截止先无副作用地执行一次新文件。
    - `envs-application-bun`:产品给 `bun --version` 5 秒;假 bun 每次重写、真 bun / node 每次复制后
      都是新文件。夹具写完或复制完立即用 `--version` 预热。
    - `mcp-stdio-tools`:`timeoutMs: 1` 被夹到最小 5 秒,预算里包含新写的 `fixture-mcp` 垫片首次执行,
      负载下服务端还没写出 stderr 就超时,捕获内容为空;同文件其他用例的 15 秒启动等待也被它吃掉。
      垫片加一个 `--phi-warm` 立即退出的分支,夹具装好后先预热。
    - `remote-jupyter-resource-guard`:脚本要首次执行 5 个新假命令,再等产品 1 秒的 TERM→KILL 间隔,
      测试自己的 10 秒子进程上限不够,改为 60 秒。
    - 复现:每个套件 8 份并行 + 20 个 `yes` + 12 个写新脚本的进程,修复前 jupyter 8/8 失败、
      mcp 7/8 出现空捕获;修复后全部通过。并发 14 `--no-retry` 全量门连跑 3 次,这 3 个套件都未再失败。
  - 同样 3 次门里仍有其他套件偶发首轮失败,待另行处理:`envs-application-tools`(产品自己写出
    `.bun.*.partial` 后给 `--version` 5 秒,同属首次执行扫描,但新文件由产品生成,测试无法预热)、
    `workspace-host-remote-micromamba`(慢容量探测软超时 5 秒,两次)、`remote-project-download-ownership`
    (两例 5 秒)、`remote-runtime-root-doctor`、`omp-bridge-model-gateway`(200 毫秒)。
- 门的默认并发从固定 4 改为 `max(4, 核数/2)`,`PHI_TEST_CONCURRENCY` 仍可覆盖;失败套件的串行重试不变。
- 缓存异常时删除 `node_modules/.cache/phi-test-transpile/` 即可,无需其他清理。

## 与整洁度方案的关系

`docs/architecture/clean-code-optimization-plan.md` 的全部切片都以 `test:gate` + `typecheck` + `lint` 作为回归门。
在这套门落地之前,机械迁移没有可信信号,这是先治理验证门、再继续批量重构的原因。

`bun run typecheck:tests` 目前在干净检出上有约 450 个既有错误(测试 tsconfig 与 `AgentEventSummary` 等类型不同步),
不纳入本门,单独治理;改动若触及类型定义,仍需人工新增对应断言。
