---
name: 'pdf'
description: 'Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter; prefer visual checks by rendering pages (Poppler) and use Python tools such as `reportlab`, `pdfplumber`, and `pypdf` for generation and extraction.'
compatibility: Runs in phi:python@1.
phi:
  environment: phi:python@1
  scripts:
    - name: pdf_inspect
      description: Read a PDF and return page count, encryption state, metadata, and bounded per-page text statistics.
      run: [python, ./scripts/pdf_inspect.py]
      args:
        type: object
        properties:
          input:
            type: string
            format: input-path
          max_pages:
            type: integer
        required: [input]
        additionalProperties: false
      approval: read
      output: ./schemas/pdf-inspect-result.json
    - name: render_pages
      description: Render PDF pages to PNG files with managed Poppler for visual review.
      run: [python, ./scripts/render_pages.py]
      args:
        type: object
        properties:
          input:
            type: string
            format: input-path
          output_dir:
            type: string
            format: project-path
          dpi:
            type: integer
        required: [input, output_dir]
        additionalProperties: false
      approval: write
      output: ./schemas/pdf-render-result.json
---

# PDF Skill

## When to use

- Read or review PDF content where layout and visuals matter.
- Create PDFs programmatically with reliable formatting.
- Validate final rendering before delivery.

## Workflow

1. Prefer visual review: render PDF pages to PNGs and inspect them.
   - Run `render_pages.py` through `skill_run`; it uses the Poppler command from the managed environment.
2. Use `reportlab` to generate PDFs when creating new documents.
3. Use `pdfplumber` (or `pypdf`) for text extraction and quick checks; do not rely on it for layout fidelity.
4. After each meaningful update, re-render pages and verify alignment, spacing, and legibility.

`pdf_inspect.py` bounds metadata keys and values. If `metadataTruncated` is true, report that the metadata overview is partial rather than claiming a complete inventory.

## Temp and output conventions

- Use a new project-local, versioned render directory for every pass, such as `pdf-rendered-v1`, then `pdf-rendered-v2`. The directory must not already exist.
- Write final artifacts under `output/pdf/` when working in this repo.
- Keep the final PDF filename stable and descriptive; version only the page-render directories.

## Managed dependencies

`phi:python@1` provides `reportlab`, `pdfplumber`, `pypdf`, and Poppler. Do not modify the host or user environment.

## Environment

No environment variables are required.

## Rendering command

```json
{
  "skill": "pdf",
  "script": "render_pages.py",
  "args": ["--input", "input.pdf", "--output_dir", "pdf-rendered-v1"]
}
```

## Quality expectations

- Maintain polished visual design: consistent typography, spacing, margins, and section hierarchy.
- Avoid rendering issues: clipped text, overlapping elements, broken tables, black squares, or unreadable glyphs.
- Charts, tables, and images must be sharp, aligned, and clearly labeled.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or placeholder strings.

## Final checks

- Do not deliver until the latest PNG inspection shows zero visual or formatting defects.
- Confirm headers/footers, page numbering, and section transitions look polished.
- Keep intermediate files organized or remove them after final approval.
