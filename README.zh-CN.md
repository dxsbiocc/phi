<div align="center">
  <img src="build/icon.png" alt="Phi 应用图标" width="104" />
  <h1>Phi</h1>
  <p>面向科研 AI 工作流的本地优先桌面工作台。</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#主要能力">主要能力</a> ·
    <a href="#项目文档">项目文档</a> ·
    <a href="https://github.com/dxsbiocc/phi/issues">反馈问题</a> ·
    <a href="LICENSE">许可证</a>
  </p>
  <p>
    <a href="#项目状态"><img alt="状态：内部测试" src="https://img.shields.io/badge/status-internal%20beta-0f766e" /></a>
    <a href="package.json"><img alt="版本：0.1.0" src="https://img.shields.io/badge/version-0.1.0-526579" /></a>
    <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  </p>
</div>

Phi 将项目对话、文件、Notebook、终端、浏览器和可复现的工具运行放在同一个 Electron 应用中。桌面端管理凭据、审批与会话历史；本地项目保留在用户选定的目录，远程项目的文件和命令操作则指向选定的 SSH 主机。

## 主要能力

| 领域       | 当前能力                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话       | 多个项目会话、后台运行、逐会话模型选择、权限审批、可恢复历史和会话导出。                                                                            |
| 项目工作区 | 本地与 SSH 项目的文件浏览、预览、编辑，以及显式下载远程文件。                                                                                       |
| 分析       | 编辑 `.ipynb` 单元、执行 Jupyter、查看输出，并使用 AI 辅助 Notebook 工作。远程 Jupyter 已有代码实现，仍需完成真实服务器的全面验收。                 |
| 工具与内容 | Skills、专家 Agent、MCP Connectors、Phi Plugins 和 Wrappers。官方领域内容来自独立的 [phi-packages 目录](https://github.com/dxsbiocc/phi-packages)。 |
| 工作台     | 与对话并列的集成终端、内置浏览器、后台任务面板和文件预览。                                                                                          |
| 可复现运行 | Wrapper 计划与运行；在正确配置主机后可使用 Nextflow 和远程／Slurm 路径。                                                                            |

Phi 的界面由 React 和 TypeScript 构建，渲染进程通过类型化 preload 桥接访问 Electron 主进程。Agent 引擎集成 `@oh-my-pi/pi-coding-agent`，本地与远程执行有不同的运行边界。会话历史和设置等应用数据存放在 `~/.phi`；从 Phi 移除项目不会删除项目源码目录。

## 快速开始

本仓库当前面向内部开发和测试。需要 **Bun 1.3.14 或更新版本**；运行测试需要 **Node.js 22.15+ 或 24+**。首次启动开发版时可能下载固定版本的运行时资源。

```bash
bun install
bun run dev
```

启动后先在设置中配置模型提供方，再开始普通对话或选择本地项目。创建 SSH 项目前，先配置主机和可写的远程绝对路径。Phi 不会将远程项目数据复制到本地会话目录。

本地构建并预览：

```bash
bun run build
bun run start
```

## 项目状态

Phi 仍处于**内部测试**阶段，尚无经过签名的公开发行版。macOS 构建未公证；Linux x64 的 AppImage/deb 打包配置已有，但仍需在干净环境中验证；Windows 分发尚未验证。更新需手动完成。远程能力除自动化测试外还需真实主机验收；在特定 SSH 或 Slurm 环境中使用前，请查看[远程验证计划](docs/roadmap/remote-parity-implementation.md)。

Phi 将会话、凭据、日志、运行时和包状态存于 `~/.phi`。该目录应作为私有数据保管；删除它会重置整个内测数据，并非普通更新步骤。会话导出可能包含工具输出和敏感对话内容。

## 开发检查

```bash
bun run test
bun run lint
bun run typecheck
bun run build
```

自动化测试用本地夹具替代外部模型与 Electron 行为，不能证明真实提供方认证、SSH／Slurm 验收或签名安装包已经就绪。

## 项目文档

- [内部测试路线图](docs/roadmap/internal-beta-implementation.md)：最初的产品范围与优先级。
- [当前 Agent 引擎计划](docs/roadmap/omp-decoupling-upgrade-plan.md)及[升级手册](docs/runtime/omp-upgrade-runbook.md)：OMP 集成和验收边界。
- [远程能力计划](docs/roadmap/remote-parity-implementation.md)及[人工检查清单](docs/roadmap/remote-parity-manual-checklist.md)：SSH 功能与待完成的验收。
- [官方内容来源](docs/decisions/official-content-source.md)及[包契约](docs/contracts/package.md)：可安装领域内容的来源。
- [Wrapper 编写指南](docs/design/phi-wrapper-authoring-guide.md)及[终端使用说明](docs/design/terminal-v1-usage.md)。

部分设计和路线图记录的是特定日期的决策。判断当前行为时，应以现行源码和最新验收记录为准。

## 许可证

Phi 使用 [MIT 许可证](LICENSE)。改写的第三方代码及其声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
