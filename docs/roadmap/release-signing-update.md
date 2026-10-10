# 任务说明：发布、签名与更新

状态：部分实施（品牌化、内置 bun 与 Linux x64 手动构建配置已完成；签名、发布与更新未开始）。来源：与 wisp-science 的对照，以及"当前状态能否直接发安装包、点击即装"的问题。
结论先行：现在**不能**发"点击安装即用"的第一版，原因见下面的阻塞项。

路线图归属：`internal-beta-implementation.md` 明确把"公开分发、签名、公证、自动更新"列为暂缓项。
本文件是把这些暂缓项拆成可执行步骤，开工前需要用户确认是否解除暂缓。

## 现状（已核对，来自配置与代码）

| 项 | 现状 | 位置 |
|---|---|---|
| 应用标识 | 已冻结为 `appId: cn.phiscience.phi`、`productName: Phi` | `electron-builder.yml` |
| 包元数据 | 已更新为 Phi Science、`https://phiscience.cn`、版本 `0.1.0` | `package.json` |
| Linux x64 | 已配置 AppImage 与 deb、品牌/桌面元数据、内置 bun 强制检查；真实 Linux 构建与干净容器启动尚未验证 | `electron-builder.yml`、`scripts/build/after-pack.mjs` |
| 自动更新 | `publish.url: https://example.com/auto-updates`；源码里没有 `electron-updater` 或 `autoUpdater` | `electron-builder.yml`、`src/main` |
| macOS 签名 | 未配置 identity；`notarize: false` | `electron-builder.yml` |
| Windows 签名 | 未配置 | `electron-builder.yml` |
| macOS 权限声明 | 摄像头、麦克风描述是模板文案，与产品不符 | `electron-builder.yml` 的 `extendInfo` |
| CI | 新增仅 `workflow_dispatch` 的 Linux x64 构建并上传产物工作流；不发布，尚未实际触发验证 | `.github/workflows/package-linux.yml` |
| 内置运行时 | bun 已固定 `darwin-arm64`、`linux-x64`；micromamba 清单覆盖 `darwin-arm64`、`darwin-x64`、`linux-x64` | `resources/runtime/manifest.json` |
| OfficeCLI | 不再内置于任何安装包；源码与手动开发脚本保留，运行时支持 `~/.phi` 用户安装位置并在缺失/不支持时降级 | `electron-builder.yml`、`src/main/agent/office/office-runtime.ts` |
| 图标 | 有 `.icns`、`.ico`、`.png` | `build/` |

## 阻塞项与已解除项

### B1. 安装包没有内置 bun（darwin-arm64 与 linux-x64 已解除）
Phi 现在优先使用安装包内 `runtime/bun/<platform>-<arch>/` 的固定版本 bun；缺失或不可执行会让打包失败。
macOS x64 与 Windows 尚未补齐，因此该阻塞只在当前两个已配置目标上解除。

仍需在无系统 bun 的干净 Linux 环境验证打包产物能启动 OMP worker。

注意：bun 本身是外部二进制，需要随应用一起签名（macOS 的 hardened runtime 要求内嵌可执行文件都被签名）。

### B2. 默认标识与占位 URL（标识已解除，更新源仍阻塞）
`appId`、产品名、作者、主页与 Linux maintainer 已冻结为 Phi 品牌值。
`publish.url` 仍是 `example.com` 占位值，并且本任务明确不启用自动更新或发布。

公开发布前仍需要确定真实更新源，并核对 `~/.phi` 数据目录和钥匙串条目的改名兼容性。

### B3. 没有签名与公证
macOS 未签名的应用会被 Gatekeeper 拦截，用户无法"点击即开"。公证需要 Apple Developer 账号。
Windows 未签名会触发 SmartScreen 警告。证书与账号由用户提供，不能由我代办或代填。

## 任务分解

按依赖顺序。每一步独立可验证，先做 1、2，再决定后续。

### 步骤 1：品牌化与标识冻结（已完成配置）
- 修改 `electron-builder.yml`：`appId`、`productName`、`win.executableName`、`linux.maintainer`、
  `nsis`/`dmg`/`appImage` 的 `artifactName`。
- 修改 `package.json`：`name`、`author`、`homepage`、`description`、`version`。
- 把 `extendInfo` 里的摄像头、麦克风、文档目录文案改成真实用途；产品若不使用摄像头和麦克风，直接删除对应项。
- 核对 `src` 中对 `pi-desktop`、`com.electron.app` 的引用（钥匙串服务名、协议、用户数据目录）。
- 验证：`bun run build:unpack` 后启动，确认应用名、数据目录、钥匙串条目符合预期。

### 步骤 2：内置 bun（darwin-arm64 与 linux-x64 已完成配置）
- 新增脚本，参照现有 `scripts/runtime`、`scripts/office` 的 fetch 与校验方式：
  按平台和架构下载固定版本 bun，校验哈希，写入 `resources/runtime/bun/<platform>-<arch>/`。
- `electron-builder.yml` 的 `extraResources` 按 `${arch}` 带入，三个平台各自配置，
  并加入 `asarUnpack` 之外的"不进 asar"约束（可执行文件不能在 asar 内）。
- `bun-executable.ts` 的查找顺序：`PHI_BUN_PATH` → **内置 bun** → PATH → 已知目录 → 登录 shell。
  内置版本优先，避免被用户机器上的旧版 bun 影响（`Bun.Image` 需要 ≥ 1.3.14）。
- 更新 `check:asar-unpack` 或 `check:resources`，让缺少内置 bun 的构建失败。
- 测试：扩展 `bun-executable` 现有测试，覆盖"内置优先"和"内置缺失时回退"。
- 验证：在**没有安装 bun** 的干净环境（新用户或干净虚拟机）里启动打包产物，智能体能正常对话。

### 步骤 3：macOS 签名与公证（依赖用户的 Apple 开发者账号）
- 配置 `mac.identity`、`hardenedRuntime: true`、`notarize`，凭据只从环境变量读取，不入库。
- 核对 `build/entitlements.mac.plist`：现有三项（JIT、未签名可执行内存、dyld 环境变量）是否都必要；
  内置 bun、micromamba、remote-helper 都需要被签名，检查 `afterPack` 是否覆盖它们。OfficeCLI 已不再内置。
- 同时产出 arm64 与 x64 两个包，或确认只发 Apple Silicon（目前只有 `darwin-arm64` 的 micromamba）。
- 验证：`spctl --assess --type execute -vv <app>` 与 `xcrun stapler validate <dmg>` 通过；
  在另一台未装开发环境的 Mac 上从浏览器下载后双击打开，无安全警告。

### 步骤 4：Windows 与 Linux 打包
- Linux x64 配置已补齐：只构建 AppImage 与 deb，不包含 snap；内置并校验 bun 与 micromamba，OfficeCLI 不再内置；手动 GitHub Actions 只上传产物，不发布。
- Linux 仍缺真实 `ubuntu-22.04` 构建、AppImage/deb 产物检查，以及无系统 bun 的干净环境 OMP 启动验证；工作流也尚未触发。
- Windows 尚未实施。macOS x64 也尚未补齐并验证；当前 macOS 安装包仍以 arm64 为已支持目标。
- 在完成上述实机或干净虚拟机验证前，不承诺对应平台可公开分发。

### 步骤 5：自动更新
- 引入 `electron-updater`，在 `src/main` 增加更新服务：启动后检查、下载、提示重启，更新失败不影响使用。
- `publish` 指向真实的更新源（GitHub Releases 或自有静态服务器）。
- macOS 自动更新**要求应用已签名**，所以必须排在步骤 3 之后。
- 要考虑运行中的后台任务和远程 Wrapper 运行：更新重启前必须提示，不能静默中断。
  参考 `app-quit.ts` 与 `scripts/smoke-packaged-quit.mjs` 现有的退出处理。
- 设置页增加"检查更新"入口与当前版本号显示。
- 验证：用两个连续版本在测试通道上走完"检测、下载、安装、重启"，并验证签名校验失败时拒绝安装。

### 步骤 6：发布流水线
- 新增 `.github/workflows/release.yml`：打 tag 触发，按平台矩阵构建、签名、公证、上传产物与更新元数据。
- 证书和密码放仓库 secrets，日志中不得输出。
- 流水线内先跑 `bun run typecheck`、`bun run lint`、`bun run check:architecture`、测试，再打包。
- 产出 `THIRD_PARTY_NOTICES.md` 校验（仓库已有该文件，发布前确认与实际依赖一致，含新增的 bun）。
- 验证：在测试 tag 上完整跑通一次，再正式发版。

### 步骤 7：发版前清单
- 首次启动体验：没有模型凭据时的引导、`~/.phi` 的创建、无网络时的表现。
- 崩溃与日志：确认打包产物的脱敏日志路径和 14 天清理策略正常；不提供面向用户的诊断导出页。
- `~/.phi` 数据模型当前是"可重置"，公开发布后要有向后兼容或迁移策略，需用户决策。
- 许可证：确认依赖许可（尤其内置的 bun、micromamba、Pi/OMP 相关包）允许再分发；阶段 B 若分发 OfficeCLI，另行核对其许可。
- 文档：README 里"内测、手动更新、Gatekeeper 警告"的描述要同步改写。

## 需要用户提供或决策

1. 真实更新源地址（产品名、`appId`、发布方和主页已冻结）。
2. Apple Developer 账号与证书（以及是否上 Windows 签名证书）。
3. 首发平台范围（建议先只发 macOS Apple Silicon）。
4. 是否解除路线图中"公开分发暂缓"的限制，还是先做小范围、签名但不公开的内测包。
5. `~/.phi` 数据兼容策略。

## 建议的最小可发布路径

若走最小公开路径，仍建议先发 macOS Apple Silicon：步骤 3 → 6（仅 macOS）；步骤 5 可放到第二个版本。
Linux x64 当前只到手动构建配置阶段，完成真实构建与干净环境启动验证后再决定是否纳入公开首发。

## 范围外

- 应用商店上架（Mac App Store、Microsoft Store、Snap Store）。
- Windows/Linux 的实机适配，除非用户明确选入首发范围。
- 远程 helper 的发布方式变更（已随安装包内置两个 Linux 二进制）。

## 未核实的内容

- `afterPack` 脚本实际会不会对内嵌可执行文件做签名处理，我只看到了它的路径与注释，没有读脚本。
- `~/.phi` 与钥匙串条目是否依赖 `productName`，需要在步骤 1 里实际 grep 确认。
- 内置 bun 的再分发许可，我没有查证。
