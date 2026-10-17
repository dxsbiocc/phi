# 远程真机验收 R8（`scripts/remote-r8.ts`）

R8 是对一台真实 SSH 主机的验收：真实应用组合（App 路由、`createRuntimeAgentSession`、SessionRunner、
生产远程运行时）加官方 OMP，模型是本机回环的合成 provider，经生产反向 SSH 隧道到达服务器。
不使用任何真实凭据或用户数据：每次运行有全新的私有 HOME、agent 目录和合成认证。

它取代了原先冻结在仓库外的 GPU / node3 operator（含逐文件冻结、部署阶段和 `--expected-bundle-sha256`）。
自 `d2629aa7` 起远程启动是一个启动事务，缺失的 OMP 二进制、Phi 扩展和 helper 都经正常应用路径安装，
所以不再有独立的部署阶段。

## 运行

```bash
# 计划模式（默认）：只打印将连接、创建、删除什么，以及三个用例；不启动任何 SSH、SDK、provider 或模型进程
bun scripts/remote-r8.ts --host GPU
bun scripts/remote-r8.ts --host yzhang-node3 --runtime-root /tmp/phi-t16-node3-1021-626b199b-9f4d-4f2b-af98-f4de6fcd0ccd

# 真实运行
bun scripts/remote-r8.ts --host GPU --execute
bun scripts/remote-r8.ts --host yzhang-node3 \
  --runtime-root /tmp/phi-t16-node3-1021-626b199b-9f4d-4f2b-af98-f4de6fcd0ccd --execute
```

- `--host` 是 `~/.ssh/config` 里的任意别名。
- `--runtime-root` 选择服务器运行时根目录（绝对路径或 `~/...`），默认 `~/.phi/runtime`。
- 退出码：0 通过（或计划）、1 运行失败或被拒绝、2 参数错误。

## 完整性

没有逐文件冻结，只记录两个事实：

1. `--execute` 在 `git status --porcelain --untracked-files=no` 非空时拒绝运行（只看已跟踪文件，未跟踪文件不影响）。
2. 回执记录 `HEAD` 和扩展 bundle hash。bundle hash 由源码按生产方式计算
   （`resolvePhiExtensionSourceRoot` + `createPhiExtensionBundle`），子进程启动前、运行后各算一次；
   运行后 `HEAD` 或 bundle hash 变化都判失败。

## 三个用例（各限 120 秒，整次运行限 15 分钟）

1. **native-search-read-edit-bash**：`glob` → `grep` → `read` → `edit` → `bash`，edit 与 bash 经真实 ask 模式审批；
   服务器上的效果可见，本地 anchor 的哨兵文件不变，每个工具都成功，审批事件恰为 requested/approved 两对。
2. **one-actual-blocking-child**：一个真实的阻塞子智能体（只读 `R8Inspector`），两个子模型请求，
   已验证的 completed 子快照（原 Phi/项目/父运行，非后台），子结果里有服务器上的内容。
3. **ssh-loss-reconnect-explicit-original-journal**：对本次运行拥有的 SSH master 发 SIGKILL；旧 proxy 的 prompt 失败且没有
   provider 请求；dispose 完成；显式 `resume: true` 得到新一代、同一 OMP session 和 journal、历史不变且无 provider 请求
   （恢复后 journal 只允许追加 `custom/session_exit` 条目）；之后一次新的显式 read 成功，没有重复 edit/bash/task。

合成 provider 一共收到 12 个请求（root 10、child 2、summary 0）。

## 清理

无论成功与否都执行：生产路径 dispose 应用 → 等待每个自有 SSH 子进程和 RPC 通道关闭 →
确认每个已证明的 `rpc-sessions/<nonce>` 目录已消失 → 仅在 owner token、UID、0700/0600、单链接、非符号链接、
规范路径都核对通过后删除本次运行自己的 `<runtime-root>/r8-acceptance/<run-id>`。
运行时根目录本身、已安装的二进制/扩展/helper 和合成 journal 保留。任何未确认的关闭或删除都使运行失败。

运行时根目录不存在时会创建（`--runtime-root` 指定的根必须恰为 0700；默认根不得对组/其他可写）。
已存在的根必须是当前用户拥有的非符号链接目录，否则拒绝。

## 回执

每次运行在 `.phi-acceptance/receipts/<时间>-<主机>-<run-id>.json`（已加入 `.gitignore`）写一个 JSON，主要字段：

| 字段                                                     | 内容                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ok`、`failure`                                          | 总结果；失败时的阶段、类型与原因（已脱敏）                                    |
| `host`、`runtimeRoot`、`runtimeRootCreated`              | 主机别名、服务器规范根目录、本次是否创建                                      |
| `commit`、`commitAfter`、`bundleHash`、`bundleHashAfter` | 运行前后的提交与扩展 bundle                                                   |
| `ompVersion`                                             | 桌面清单中的 OMP 版本（启动事务安装并校验）                                   |
| `cases[]`                                                | 每个用例的名称、耗时和完整断言细节                                            |
| `startup[]`                                              | 每次创建/恢复的 `PHI_REMOTE_STARTUP_DIAGNOSTICS` 画像：各步骤耗时与远程命令数 |
| `rpcStartup[]`、`remoteOperations[]`                     | stdio 打开到 attestation 的耗时；SSH 连接、上传、App 创建/恢复耗时            |
| `providerRequests`、`providerPurposes`、`tunnels`        | 请求数（按 root/child/summary）与反向隧道开关次数                             |
| `cleanup`                                                | 各项关闭/删除的确认结果和失败列表                                             |

运行成功且清理确认时删除 `.phi-acceptance/runs/<run-id>`；失败时保留以便诊断。结束时打印简短摘要。

## 前置条件与限制

- 需要本机 `ssh` 能免交互登录该别名（受管身份已加载进 ssh-agent）；身份用真实 HOME 解析后传给隔离子进程。
- 源码检出模式下 helper 按需构建（需要 Go 工具链，见 `bun run build:helper`）；可先构建以缩短首次运行。
- 每次运行都会把官方 OMP 资产下载到私有 agent 目录（运行后删除），不使用任何共享缓存。
- 自动化测试（`tests/remote-r8.test.ts`）用本地 shell 主机代替 SSH 跑同样的三个用例、清理和回执；
  SSH master 的 SIGKILL、GNU `stat`/`rm` 校验脚本由 shim 测试覆盖，真实 SSH 只能在真机上验证。
