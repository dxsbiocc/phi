<div align="center">
  <img src="build/icon.png" alt="Phi 应用图标" width="104" />
  <h1>Phi</h1>
  <p><strong>面向科研工作的本地优先 AI 工作台。</strong></p>
  <p>从研究问题走向代码、Notebook、可复现的运行和可检查的结果，同时保留贯穿全程的项目上下文。</p>
  <p>自动环境管理 · AI 与 Jupyter 内核协作 · 专家插件 · 可复现流程</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="https://phi.omicsagent.cn/">官网</a> ·
    <a href="https://phi.omicsagent.cn/docs">产品文档</a> ·
    <a href="https://phi.omicsagent.cn/docs/quickstart">快速开始</a> ·
    <a href="https://github.com/dxsbiocc/phi/releases">版本发布</a> ·
    <a href="https://github.com/dxsbiocc/phi/issues">问题反馈</a>
  </p>
  <p>
    <a href="#可用状态"><img alt="内部测试" src="https://img.shields.io/badge/status-internal%20beta-0f766e" /></a>
    <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  </p>
</div>

Phi 面向那些工作不会止于一条聊天回复的研究者。一个可靠的结果可能需要项目文件、Python 或 R Notebook、专业工具、外部数据源，也可能需要在服务器上运行 Nextflow。Phi 将这些环节放在同一个桌面工作区，并让权限和本地历史保持可见。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/notebook-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/notebook-light.png">
  <img alt="Phi Notebook 工作区中的科研分析" src="assets/readme/notebook-light.png" width="100%">
</picture>

<sub>Phi 桌面内测版的 Notebook 工作区。截图使用演示数据，并随 GitHub 主题切换。</sub>

## Phi 的特色

### 环境随任务自动准备

Phi 会在需要时准备有版本记录的受管 Python、R、Jupyter 和 Nextflow 环境。可执行 Skill、专家 Agent、Notebook 内核与 Wrapper 使用声明好的运行环境，不必碰运气依赖宿主机装过哪些包。已就绪的环境可以复用；运行时面板显示状态，并提供修复和清理入口。首次构建可能下载依赖，Slurm 等主机服务仍需单独管理。

### Agent 能直接与 Jupyter 内核协作

Agent 可以读取 `.ipynb`、插入或修改代码与 Markdown 单元，通过 Jupyter 运行代码单元，取得执行状态和输出摘要，再保存 Notebook。你在编辑器里看到的是同一批单元和结果；写入与运行仍遵循 Phi 的审批设置。Phi 提供受管 Python 与 R 内核，其中 Python 是默认选择；使用宿主机内核需要显式指定。

### 插件把专家和工具带到一起

一个 Phi 插件可以同时包含专门的 Agent、Skills、可调用的脚本工具和环境绑定。应用会展示这些实际能力与状态，专家完成的工作也留在主对话的上下文中。官方包目录提供可安装的插件及其他科研资源。

### 科研绘图留下可编辑的源文件

**Visualization（科研绘图）**插件就是一个实例。专属专家使用 `omics-visualization` Skill，根据结果表筛选真实模板，先展示预览供选择，再在项目内准备可编辑的 `plot.R`，通过共享的受管 R 环境输出 PNG、PDF 或 SVG。它也能修改已有图，并按要求检查标签裁切、图例缺失和可能误导读者的编码。[了解绘图插件](https://phi.omicsagent.cn/plugins)。

<p align="center"><img src="assets/readme/visualization-template.png" alt="科研绘图插件内置的聚类热图模板预览" width="72%"></p>

<sub>这是插件自带的真实热图模板预览，不是用户数据的分析结果。作为科研图表，其白色画布在 GitHub 亮暗主题中保持一致。</sub>

## 从问题到结果

1. **选择工作范围。** 开始普通对话，或把对话绑定到本地／SSH 项目。项目文件保留在原来的位置。
2. **与 Agent 协作。** 选择模型、引用相关 Skill 或专家 Agent，并按项目权限模式审查工具操作。需要时可先审阅计划，再开始执行。
3. **选择合适的工作界面。** 在 Notebook 中探索、在文件预览中检查结果，或使用打包好的 Wrapper 执行可重复的流程。
4. **随时接着做。** 切换项目或侧边面板后，对话、运行历史、审批和后台任务仍与原工作保持关联。

### 用可复现的流程代替临时命令

Wrapper 将常用工具和工作流组织成可发现的输入与运行计划。Phi 可以准备运行、显示状态与日志，并帮助检查结果文件。远程执行支持已配置的 SSH 与 Slurm 路径；在具体集群上使用前，仍需完成对应主机的验证。

在官网的[界面图库](https://phi.omicsagent.cn/#ui-shots)可以查看 Wrapper 目录及更多桌面界面。

### 连接科研资源

Skills 提供任务指导，MCP Connectors 连接外部服务，Wrappers 定义可复现的命令行运行。官方 [Phi Packages](https://github.com/dxsbiocc/phi-packages) 目录提供可安装的领域内容。Phi 会展示资源的范围和可用状态，让你在请 Agent 调用之前就知道当前配置了什么。

插件与连接器的界面预览也在[官网图库](https://phi.omicsagent.cn/#ui-shots)中。

围绕对话的工作台还提供终端、内置浏览器、文件预览和后台任务面板。查看结果或跟进长时间运行时，不必离开当前对话。

## 本地优先，边界清晰

Phi 将设置、对话、审批、日志和包状态存放在 `~/.phi`。选定的项目不会变成应用数据目录：本地项目文件仍位于原文件夹，远程项目的文件和命令操作指向选定的 SSH 主机，不会静默回退到桌面端。

本地优先不等于离线推理：模型请求会发往你配置的提供方，已启用的连接器也可能访问对应服务。项目操作遵循 Phi 中显示的权限设置。导出的会话可能包含工具输出和敏感对话内容，应作为私有数据保管。

## 开始使用

获取桌面版请查看官网的[安装指南](https://phi.omicsagent.cn/docs/install)和[快速开始](https://phi.omicsagent.cn/docs/quickstart)。[产品文档](https://phi.omicsagent.cn/docs)还介绍了 Skills、MCP 连接器、Wrappers 和常见问题。

从源码运行需要 **Bun 1.3.14+**；运行测试需要 **Node.js 22.15+ 或 24+**。首次启动时可能下载固定版本的运行时资源。

```bash
bun install
bun run dev
```

启动后在设置中配置模型提供方，再选择项目。打包前可检查源码：

```bash
bun run test
bun run lint
bun run typecheck
bun run build
```

## 可用状态

Phi 目前是**内部测试版**，还不是经过签名、公证的公开桌面发行版。macOS 是主要开发目标；Linux x64 已有打包配置，但仍需干净环境验收；Windows 分发尚未验证。远程 SSH、Jupyter 和 Slurm 工作流需要针对具体环境完成真实主机验证。内测期间更新需手动完成。

源码采用 [MIT 许可证](LICENSE)。第三方来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。功能建议与错误反馈请提交到 [GitHub Issues](https://github.com/dxsbiocc/phi/issues)。
