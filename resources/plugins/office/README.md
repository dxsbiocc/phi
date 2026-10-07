# 办公文档插件

这个内置插件通过托管 Python 提供 `xlsx`、`pptx`、`pdf`、`docx` 和 `office-workflow` 五个技能，用于生成和处理 Excel、Word、PowerPoint 与 PDF，包括图表、图片、复杂排版和批量任务。

生成类任务默认使用本插件的 Python 路线。只有当用户已在 Phi 右侧打开一份 Office 文件，且需要少量交互式修改时，才使用原生 `phi-office` 技能。

所有脚本都在共享的内置 Python 环境 `phi:python@1`（`phi-python`）中运行，不需要宿主机额外软件或用户级配置。插件本身不声明私有环境，也不提供专属智能体。
