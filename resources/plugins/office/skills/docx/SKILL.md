---
name: docx
description: 用 python-docx 创建、批量编辑或检查 Word .docx 文档，适用于标题、样式、列表、表格、图片、页眉页脚和分节排版；已在右侧打开的文件只需少量交互式修改时改用原生 phi-office。
compatibility: Runs in phi:python@1.
phi:
  environment: phi:python@1
  scripts:
    - name: docx_inspect
      description: Read a DOCX file and return a bounded structural overview of its paragraphs, styles, tables, and sections.
      run: [python, ./scripts/docx_inspect.py]
      args:
        type: object
        properties:
          input:
            type: string
            format: input-path
          max_paragraphs:
            type: integer
        required: [input]
        additionalProperties: false
      approval: read
      output: ./schemas/docx-inspect-result.json
---

# DOCX

用 `python-docx` 完成生成、复杂排版和批量修改，并将成品保存到项目内的相对路径。如果用户已在 Phi 右侧打开一份 Word 文档，且只要少量交互式修改，改用原生 `phi-office`；不要为小改动重建整份文档。

## 创建与样式

优先用命名样式表达文档结构，再对个别 paragraph 或 run 做局部样式。下面是最小的可运行骨架：

```python
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

document = Document()
document.styles["Normal"].font.name = "Arial"
document.styles["Normal"].font.size = Pt(10.5)

document.add_heading("项目报告", level=1)
paragraph = document.add_paragraph()
paragraph.add_run("结论：").bold = True
paragraph.add_run("本轮交付已完成。")
document.add_paragraph("核对数据", style="List Bullet")
document.add_paragraph("复查格式", style="List Number")

table = document.add_table(rows=2, cols=2)
table.style = "Table Grid"
table.cell(0, 0).text = "项目"
table.cell(0, 1).text = "状态"
table.cell(1, 0).text = "数据检查"
table.cell(1, 1).text = "通过"

document.add_picture("assets/chart.png", width=Inches(5.8))
document.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER

section = document.sections[0]
section.top_margin = Inches(0.8)
section.bottom_margin = Inches(0.8)
section.left_margin = Inches(0.9)
section.right_margin = Inches(0.9)
section.header.paragraphs[0].text = "内部报告"
section.footer.paragraphs[0].text = "Phi"
document.add_section(WD_SECTION.NEW_PAGE)

document.save("output.docx")
```

- 标题层级使用 `add_heading(..., level=1..9)`，不要用加粗的普通段落伪装标题。
- 列表使用模板中已有的 `List Bullet` / `List Number` 样式；更复杂的多级编号需先确认模板定义。
- 表格要明确行列数、表头与列宽；合并单元格后再设文本。
- 图片使用项目内路径和明确尺寸，保留原始素材以便复现。
- 页眉、页脚、分节和 margin 是 section 属性；多分节文档需逐节检查连接关系。
- 修改现有文档时优先复用 `document.styles` 中的名称，不要把模板的全局样式替换成自定义格式。

## 读取、修改与验证

```python
from docx import Document

document = Document("existing.docx")
for paragraph in document.paragraphs:
    if paragraph.style and paragraph.style.name == "Heading 2":
        paragraph.add_run(" · 已复核").italic = True
document.save("output.docx")

checked = Document("output.docx")
assert len(checked.paragraphs) == len(document.paragraphs)
assert len(checked.tables) == len(document.tables)
```

1. 保存后必须用 `Document("output.docx")` 重新打开，核对段落数、标题样式、表格尺寸、分节数和关键文本。
2. 通过 `skill_run` 运行托管 `office-workflow/extract_text.py`，参数为 `--input output.docx`；将返回的有界 `text` 与预期提纲逐节比对。
3. 可用 `docx_inspect.py` 获取有界的段落、样式、表格和分节概览。检查 `textTruncated`、`paragraphsTruncated`、`tablesTruncated`、`sectionsTruncated` 和 `stylesTruncated`，也要检查每个段落的 `styleTruncated`；任一为 `true` 都表示输出只是部分概览。该脚本不证明视觉排版正确。
4. 请用户在 Phi 右侧文件预览中打开成品，确认分页、图片位置、页眉页脚和表格排版。

## 能力边界

`python-docx` 对普通文本、样式、列表、表格、图片和分节的支持最可预期。对 hyperlink、comments、tracked revisions、域、嵌入对象或复杂编号，先根据托管版本读回核实；如果高层 API 不支持或无法保真往返，就明确告知用户本轮不支持，不通过未验证的 XML 操作伪造成功。处理已有文档时，保留一份输入副本，不覆盖原件。
