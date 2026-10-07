---
name: office-workflow
description: 为 Excel、Word、PowerPoint 和 PDF 任务选择原生小改、一次性 Python/Node 脚本或常驻 notebook 内核工作流。
compatibility: Runs in phi:python@1.
phi:
  environment: phi:python@1
  scripts:
    - name: check_runtime
      description: Report the managed Office Python package versions before starting a document workflow.
      run: [python, ./scripts/check_runtime.py]
      args:
        type: object
        properties: {}
        additionalProperties: false
      approval: read
      output: ./schemas/runtime-check-result.json
    - name: extract_text
      description: Extract bounded text from a project Office or PDF file with managed markitdown.
      run: [python, ./scripts/extract_text.py]
      args:
        type: object
        properties:
          input:
            type: string
            format: input-path
        required: [input]
        additionalProperties: false
      approval: read
      output: ./schemas/extract-text-result.json
---

# Office 工作流

根据文档是否已在右侧打开、任务规模和交互次数选择路线。所有成品都保存到当前项目内的相对路径；不得为完成任务改动宿主机或用户环境。

## 选择规则

1. **原生 `phi-office`**：仅当用户已在 Phi 右侧打开一份 Office 文件，并且要做少量交互式修改时使用。没有当前打开目标、要新生成文件、需要批量处理或复杂排版时，不选这条路线。
2. **一次性 Python/Node 脚本**：生成、图表、图片、复杂格式和批量任务的默认路线。按 `xlsx`、`pptx`、`docx` 或 `pdf` 技能编写一个项目内脚本，再用 `skill_run` 通过托管环境执行。
3. **常驻 notebook 内核**：大文档、计算中间状态需要保留、或要多轮迭代时使用。通过 `notebook.*` 在 `phi-python` 内核中持有 openpyxl workbook、python-pptx presentation 或 python-docx document 对象，分步运行，在里程碑处调用文档对象的 `save(...)`。

## 路线 B：一次性托管脚本

先按对应文档技能编写 `scripts/build_report.py`，让脚本自行创建输出父目录、保存文件并执行读回检查。然后运行：

```json tool-call
{
  "tool": "skill_run",
  "arguments": {
    "skill": "office-workflow",
    "script": "run_project_script.py",
    "args": ["scripts/build_report.py", "--output", "output/report.docx"],
    "cwd": "."
  }
}
```

PptxGenJS 使用 CommonJS：把以 `require('pptxgenjs')` 开头的生成脚本保存为 `.cjs`，再用同一托管入口运行：

```json tool-call
{
  "tool": "skill_run",
  "arguments": {
    "skill": "office-workflow",
    "script": "run_project_script.py",
    "args": ["scripts/build_deck.cjs", "output/deck.pptx"],
    "cwd": "."
  }
}
```

`run_project_script.py` 只接受当前项目内现有的 `.py`、`.js`、`.cjs` 或 `.mjs` 相对路径，并由 `skill_run` 的执行审批保护。Node 分支只使用 `phi:python@1` 托管 PATH 中的 `node`，并传递托管 `node_modules`。不要在脚本里下载工具或修改环境。

## 路线 C：常驻内核最小序列

以用户已在 Phi 中创建并选用 `phi-python` 内核的 `notebooks/office-build.ipynb` 为例。先读取 notebook，并从回执中取得代码 cell 的稳定 `id`：

```json tool-call
{ "tool": "notebook.read", "arguments": { "path": "notebooks/office-build.ipynb" } }
```

将返回的 cell id 作为 `cellId`，写入第一步：

```json tool-call
{
  "tool": "notebook.update_cell",
  "arguments": {
    "path": "notebooks/office-build.ipynb",
    "cellId": "cell-id-from-notebook-read",
    "source": "from pathlib import Path\nfrom docx import Document\nPath('output').mkdir(exist_ok=True)\ndocument = Document()\ndocument.add_heading('Project report', level=1)"
  }
}
```

```json tool-call
{
  "tool": "notebook.run_cell",
  "arguments": {
    "path": "notebooks/office-build.ipynb",
    "cellId": "cell-id-from-notebook-read"
  }
}
```

再插入一个 cell；它会复用同一内核中的 `document` 对象：

```json tool-call
{
  "tool": "notebook.insert_cell",
  "arguments": {
    "path": "notebooks/office-build.ipynb",
    "afterCellId": "cell-id-from-notebook-read",
    "cellType": "code",
    "source": "document.add_paragraph('Verified content')\ndocument.save('output/report.docx')"
  }
}
```

使用插入回执里的新 `cell.id` 运行该 cell：

```json tool-call
{
  "tool": "notebook.run_cell",
  "arguments": {
    "path": "notebooks/office-build.ipynb",
    "cellId": "cell-id-from-insert-result"
  }
}
```

文档对象的 `save(...)` 保存成品；`notebook.save` 则单独保存 notebook 草稿：

```json tool-call
{ "tool": "notebook.save", "arguments": { "path": "notebooks/office-build.ipynb" } }
```

## 检查、查看与交付

- 每次生成后都要重新打开文件做结构化检查，并用托管 `extract_text.py` 对照关键文本。只能报告实际运行过的检查，不得根据脚本内容声称结果已验证。

```json tool-call
{
  "tool": "skill_run",
  "arguments": {
    "skill": "office-workflow",
    "script": "extract_text.py",
    "args": ["--input", "output/report.docx"],
    "cwd": "."
  }
}
```

- 用户可在 Phi 文件预览里打开成品。原生 Office 预览显示的是打开时的草稿副本；Python 重新生成后，需重新打开该文件才能查看新版本。
- 完成读回核对后，用 `present_files` 交付最重要的现有文件：

```json tool-call
{
  "tool": "present_files",
  "arguments": {
    "files": [{ "path": "output/report.docx", "description": "已读回核对的项目报告" }]
  }
}
```

## 本版本限制

- 不支持 PDF 转换；不得将其描述为隐式交付步骤。
- `openpyxl` 写入的公式没有缓存计算值，Python 读取这些单元格可能得到空值。Excel 打开时会重算；静态公式检查不等于计算结果验证。
- 不得安装任何东西。如果托管环境中的能力不可用，应如实说明，不得改用宿主机工具。
