# 远程对齐第 1 步：Codex 任务提示词

依据：[remote-parity-implementation.md](remote-parity-implementation.md) §3、§4 第 1 步。
执行顺序：R1.1 → R1.2 → R1.3 → R1.4 → R1.5。每个任务独立提交，前一个门禁通过后才开始下一个。

## 所有任务共用的前置说明（每条提示词开头都带上）

```
项目：/Users/example/Downloads/Work/App/Phi（Electron + TypeScript，包管理与脚本一律用 bun，不用 npm）。
先读：AGENTS.md、docs/roadmap/remote-parity-implementation.md（§1 非目标、§3 设计、§4 第 1 步）。
硬约束：
- 不改变现有远程行为：审批、路径包含（remote-path-containment.ts）、冲突检查、断线语义（未知写入/命令先对账、不自动重放）、远程故障绝不回退本机执行。
- 不新增依赖，除非任务明确允许；不碰与本任务无关的文件。
- 不可变风格：返回新对象，不原地修改入参。
- 单文件尽量 <400 行，不超过 800；函数 <50 行。
- 先写测试（RED）再实现（GREEN）；新增代码覆盖率 ≥80%。
- 注释密度、命名、风格与相邻代码一致。
- 远程设置页若 WrapperRemoteSettings.tsx 已 >600 行，新增 UI 前先提取，遵守 AGENTS.md 的前端特性边界与 `bun run check:architecture`。
完成后必须运行并贴出结果：bun run test、bun run lint、bun run typecheck；涉及构建时再加 bun run build。
测试失败如实报告，不得改弱断言。
```

---

## R1.1 `WorkspaceHost` 接口与 `LocalHost`

```
目标：新增与传输无关的工作区主机抽象，并给出本地实现。

新增目录 src/main/agent/workspace-host/：
- types.ts：
  - WorkspaceHost：fs（stat、readRange、writeAtomic(path, content, {expectedHash?})、list、glob、mkdirp、remove）、
    exec（run(cmd, {cwd, env, timeoutMs, maxOutputBytes, signal}) 返回 {stdout, stderr, code, signal, truncated}；
    spawnBackground(cmd, opts) 返回可查询/终止的句柄，使用独立进程组）、
    capabilities(): HostCapabilityProfile。
  - pty / watch / forwardPort 声明为可选能力，本任务不实现。
  - HostCapabilityProfile：每项能力 {state: 'available'|'degraded'|'unavailable', reason?}，
    另含 platform、helperVersion?、probedAt、toolchain（git、nextflow、java、conda、sbatch、container runtime、module）。
  - 接口中不得出现任何 SSH、主机别名、perl、shell 命令字符串等传输专有概念。
- local-host.ts：LocalHost，基于 node:fs / node:child_process。
- tests/workspace-host-contract.ts：导出 runWorkspaceHostContract(makeHost)，覆盖：
  原子写与 expectedHash 冲突、范围读取、目录列表分页、glob、exec 超时/取消/输出截断、
  后台进程组终止无残留、路径越出根目录被拒绝、符号链接逃逸被拒绝。
- tests/workspace-host-local.test.ts：对 LocalHost 运行契约。

验收：契约测试对 LocalHost 全过；types.ts 不含传输专有概念（加一个简单的源码断言测试）；
运行 bun run test、bun run lint、bun run typecheck。
```

---

## R1.2 `SshHost`（基于现有纯 SSH，不引入 helper）

```
目标：把现有远程工作区实现封装成 WorkspaceHost，行为零变化。

依据文件：src/main/agent/wrappers/remote-ssh-session.ts（RemoteSshSession）、
src/main/agent/remote-workspace-{read,write,edit,search,bash,boundary}.ts、remote-path-containment.ts。

任务：
1. 新增 src/main/agent/workspace-host/ssh-host.ts，实现 WorkspaceHost，内部复用上述现有实现，
   不复制其逻辑；对外不泄露 RemoteSshSession。
2. 把 tests/workspace-host-contract.ts 同时对 LocalHost 与 SshHost 运行，
   SshHost 使用 tests/helpers/localShellSession.ts（本地 bash 冒充 SSH 会话）。
3. 现有所有 tests/remote-*.test.ts 与 tests/wrapper-*remote*.test.ts 不得修改断言，必须原样通过。

约束：不改审批流程、不改错误消息文本、不改超时与输出上限默认值。
验收：契约测试对两种 host 全过；上述现有测试零改动全过；bun run test / lint / typecheck 全过。
```

---

## R1.3 让现有远程工具经 host 注入

```
目标：六个远程工具改为从 WorkspaceHost 取得能力，去掉各自专有的 requestHost('remoteWorkspace.*') 路径依赖，行为与消息保持不变。

范围：src/main/agent/omp/omp-sdk-worker.ts 中 remoteRoot 分支（buildRemoteWorkspace{Edit,Write,Read,Glob,Grep,Bash}Tool 的装配处）
及主进程侧对应的 remoteWorkspace.* 处理（src/main/index.ts）。

任务：
1. 在主进程为每个远程项目会话构造一个 SshHost，worker 侧通过既有 host 请求通道使用它；
   工具构造函数签名尽量保持，仅替换后端来源。
2. 收敛 omp-sdk-worker.ts 中的 `remoteRoot ? … : …` 分支：本任务结束时不得新增此类分支，
   并在提交说明中列出被收敛掉的分支数量。
3. 核实 buildProjectDownloadTool(cwd, agentDir) 在远程项目下的行为：
   若使用本地锚点目录，则改为 host 感知，或在远程项目中禁用并返回明确提示；
   先写一个能证明当前行为的失败测试，再修复。
4. remote-project-tool-guard.ts 的"描述字符串比对"保护机制保持有效（工具描述不变，或同步更新常量）。

验收：tests/remote-*.test.ts、tests/main-integration.test.ts 原样通过；
下载工具的远程行为有测试覆盖；bun run test / lint / typecheck 全过。
```

---

## R1.4 首次连接检测与服务器能力档案

```
目标：连接远程项目时自动探测服务器环境，生成能力档案；只探测与报告，不自动安装工具链。

任务：
1. src/main/agent/workspace-host/probe.ts：
   - 探测脚本为纯 POSIX sh，经 stdin 发送（避免命令行长度限制），输出稳定的 key=value 行。
   - 探测项：uname -sm、glibc 版本或 musl、perl/python3/tar/sha256sum 是否存在、
     家目录是否可写、是否 noexec 挂载（用实际写入并尝试执行一个探针脚本判断）、磁盘配额、
     是否共享文件系统、git/nextflow/java/conda/sbatch/容器运行时/module 是否存在及版本。
   - 解析器把输出转成 HostCapabilityProfile；未知/缺失一律保守标为 unavailable 并带 reason。
   - 所有对外字段脱敏：不含用户名、主机名、家目录绝对路径。
2. 档案缓存：按「主机别名 + 项目根」为键，存放在 Phi 主机档案旁（~/.phi/ 下的独立文件，原子写，权限仅当前用户）；
   提供读取、手动重新检测、失效（helper 版本变化时）。
3. 并入现有检查：remote-doctor.ts、wrappers/remote-submit-preflight.ts、remote-nextflow-install.ts 的探测复用同一份档案，
   不保留重复探测代码；缺失工具只报告并附可复制的修复建议。
4. 设置页：显示档案摘要与"测试连接"按钮（复用现有诊断控制器与 Octicons）。
   若 WrapperRemoteSettings.tsx >600 行，先提取项目卡片/状态 hook；跑 bun run check:architecture。
5. 测试：用伪造 sh 输出覆盖——glibc 2.17 且无 perl、noexec 家目录、只读家目录、架构不支持（含 darwin），
   以及探测超时、脚本部分输出、输出被截断。

验收：上述场景档案内容各自正确；档案与日志经脱敏测试；现有 doctor/preflight 测试不降级；
bun run test / lint / typecheck / check:architecture 全过。
```

---

## R1.5 Go helper 最小骨架

```
目标：提供预编译静态 helper 及安装/降级流程。本任务不做 PTY、文件监听、端口转发。

任务：
1. 新增 helper/ 独立 Go 模块（go.mod，零外部依赖或仅纯 Go 依赖）：
   - 通信：经 stdio 的长度前缀 JSON 帧（JSON-RPC 2.0 形态），不监听任何网络端口。
   - 命令：--version、--selftest（自测 fs 写入、进程组、输出上限，打印 JSON 结果）、serve（stdio 服务）。
   - 方法：fs.stat / fs.readRange / fs.writeAtomic(expectedHash) / fs.list / exec.run / exec.cancel，
     与 WorkspaceHost 语义一一对应；项目根在启动参数中固定，所有路径在 helper 内再次校验包含关系（含符号链接）。
   - stdio 关闭即退出，并终止其启动的子进程组，不留后台进程。
   - 不使用 os/user、cgo；用户信息读环境变量与 /etc/passwd。
   - Go 单元测试覆盖协议、路径包含、取消、输出截断。
2. scripts/build-helper.mjs：CGO_ENABLED=0 交叉编译 linux-amd64 与 linux-arm64，
   输出到 resources/remote-helper/<version>/，生成 sha256 清单；
   在 package.json 加 build:helper 脚本并接入 build 之前的步骤；
   更新 check:resources 与 check:asar-unpack 以覆盖该目录。仅 Linux 两个目标，darwin 不发布。
3. src/main/agent/workspace-host/helper-installer.ts：
   按能力档案选择二进制 → 上传（只从本机，服务器不下载任何东西）→ 校验 sha256 → chmod +x → 运行 --selftest；
   路径含版本号（~/.phi/remote/<ver>/），并存不覆盖；noexec 时换备用可执行目录；失败重传一次后降级。
4. SshHost 增加 helper 传输，由能力协商决定走 helper 还是现有纯 SSH；
   两条路径都必须通过 R1.1 的同一份契约测试。降级时写入档案（原因、受影响能力）。
5. 故障测试：上传中断、哈希不符、noexec、selftest 失败、架构为 darwin——各自降级到纯 SSH 且功能不丢；
   SSH 断开后 helper 进程无残留。

验收：Go 测试与 bun run test / lint / typecheck / build 全过；helper 在 localShellSession 通道上通过契约测试；
CGO_ENABLED=0 产物 --selftest 通过；`file` 或等价手段确认为静态链接。
```

---

## 第 1 步完成后的人工验证（不交给 Codex）

在 GPU 单机与 HPC 集群各做一次：连接 → 探测 → 安装 helper（或降级）→ 能力档案内容 → 文件/命令工具回归 → 跑一次 RNA-seq 小样本 wrapper。
记录只写版本与脱敏结果，追加到 `remote-parity-implementation.md` §7。
