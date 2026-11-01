<div align="center">
  <img src="build/icon.png" alt="Phi 应用图标" width="104" />
  <h1>Phi</h1>
  <p><strong>面向科研工作的桌面 AI 工作台。</strong></p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="https://phi.omicsagent.cn/">官网</a> ·
    <a href="https://phi.omicsagent.cn/docs">产品文档</a> ·
    <a href="https://github.com/dxsbiocc/phi-packages">资源包</a> ·
    <a href="https://github.com/dxsbiocc/phi/issues">问题反馈</a>
  </p>
  <p>
    <a href="#可用状态"><img alt="内部测试" src="https://img.shields.io/badge/status-internal%20beta-0f766e" /></a>
    <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  </p>
</div>

Phi 把 AI Agent 接到科研工作实际使用的工具上：项目文件、Jupyter Notebook、受管的 Python 和 R 环境、命令行流程，以及远程服务器。你提出分析需求，Agent 在你的项目里写代码并运行，代码和结果都以普通文件的形式留在项目中。

## 实际效果

我们让 Agent 对 scikit-learn 自带的 Wisconsin 乳腺癌诊断数据集做 PCA。它写好 Notebook 单元，在 Phi 受管的 Python 内核上运行，并连同输出一起保存。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/notebook-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/notebook-light.png">
  <img alt="Phi Notebook 中已运行的 PCA 单元，输出良性与恶性样本的散点图" src="assets/readme/notebook-light.png" width="100%">
</picture>

对话随后列出这次产出的文件，点击即可打开。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/delivery-zh-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/delivery-zh-light.png">
  <img alt="Phi 对话末尾显示 PCA 图以及 Notebook 和图片两个交付文件卡片" src="assets/readme/delivery-zh-light.png" width="100%">
</picture>

<sub>均为 Phi 0.1.0 桌面应用的截图，只缩放了尺寸，未作其他修改；模型为 DeepSeek V4 Flash。</sub>

## Phi 能做什么

- **Agent 能直接操作 Notebook。** Agent 可以读取 `.ipynb`，插入和修改单元，通过 Jupyter 运行，检查输出并保存。你在编辑器里看到的是同一批单元。Python 和 R 内核由 Phi 管理；使用宿主机内核需要显式选择。
- **受管环境。** 有版本记录的 Python、R、Jupyter 和 Nextflow 环境按需构建，工作不依赖宿主机装了什么。可以在设置中重建、删除或清理。首次构建需要下载软件包。
- **对话过程可控。** 每个对话都可以绑定项目，并使用一种模式：自动、询问、计划、规划并执行或完全访问。计划类模式会等你批准后才行动。切换到别处时，对话会在后台继续运行；也可以从之前的某条消息分叉。
- **插件、Skills、连接器和 Wrapper。** 插件把专家 Agent 与它的 Skills 和环境打包在一起。Skills 提供任务指导，MCP 连接器访问外部服务，Wrapper 描述可复现的命令行工具和流程。官方 [Phi Packages](https://github.com/dxsbiocc/phi-packages) 目录提供可安装的内容。
- **通过 SSH 使用远程项目。** 远程项目的文件和命令都在你选定的主机上执行，不会回退到桌面端。Wrapper 可以提交到 Slurm。在依赖某台主机之前，请先做实际验证。
- **围绕对话的工作台。** 终端、内置浏览器、文件预览和后台任务面板都在对话旁边。

### 可以继续修改的图表

Visualization（科研绘图）插件从目录中选择模板，把可编辑的 `plot.R` 写入项目，再用受管 R 环境渲染。下面这张热图就来自这个流程。

<p align="center"><img src="assets/readme/visualization-heatmap.png" alt="二十个样本十项细胞核均值特征的聚类热图，按诊断结果标注" width="72%"></p>

<sub>数据是同一个 scikit-learn 数据集中的二十个样本（良性、恶性各十个），只用于演示绘图，不支持任何研究结论。图例标题是之后在 `plot.R` 中手动缩短并重新渲染的。</sub>

## 你的数据

设置、对话、审批、日志和包状态都存放在 `~/.phi`。项目文件留在你选定的文件夹里，Phi 不会把应用数据存到那里。

Phi 并非离线运行。模型请求会发往你配置的提供方，已启用的连接器也可能访问对应服务。导出的会话可能包含工具输出和敏感对话内容，请作为私有数据保管。

## 可用状态

Phi 目前是**内部测试版**。主要目标平台是 Apple Silicon 上的 macOS。Linux x64 已有打包配置，但尚未通过干净环境验收；Windows 尚未验证。更新需手动完成：在“设置 → 通用 → 检查更新”中可以查看是否有新版本。

安装包目前没有签名和公证。预览版发布后会出现在 [Releases](https://github.com/dxsbiocc/phi/releases) 页面；现在还没有可下载的版本，请先从源码构建。升级时 `~/.phi` 中的数据会保留。

- **macOS**（`.dmg`、`.zip`）：把 Phi 拖到“应用程序”。首次启动时 macOS 会提示无法验证 Phi，请打开“系统设置 → 隐私与安全性”，点击“仍要打开”；每个安装版本只需操作一次。
- **Linux**（`.AppImage`、`.deb`）：运行 `sudo apt install ./phi_*.deb`，或执行 `chmod +x Phi-*.AppImage` 后运行 AppImage。

## 从源码构建

需要 [Bun](https://bun.sh) 1.3.14 或更高版本。首次启动时会下载固定版本的运行时资源。

```bash
bun install
bun run dev
```

先在设置中配置模型提供方，再选择项目。

如果要按 CI 的方式检查源码，还需要安装 Node.js 24：

```bash
bun run helper:fetch-go && bun run build:helper
bun run lint
bun run typecheck
bun run test:gate
```

`bun run build:mac` 和 `bun run build:linux` 用于打包。维护者通过 `v*` 标签发布版本，详见 [release-signing-update.md](docs/roadmap/release-signing-update.md)。

## 许可证

源码采用 [MIT 许可证](LICENSE)。第三方来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。错误反馈和功能建议请提交到 [GitHub Issues](https://github.com/dxsbiocc/phi/issues)。
