# phi-python

Shared Python 3.12 base environment for general Python skills, the bundled Office plugin, and the default `phi-python` Notebook kernel.

Only `python=3.12` is pinned in `environment.yml`. The lock files pin every other package from `conda-forge`.

`coreutils` remains shared runtime tooling for Unix compatibility and is declared only for `darwin-arm64`, `darwin-x64`, and `linux-x64`. Heavy domain-specific bioinformatics and cheminformatics stacks (`scanpy`, `scvelo`, `rdkit`, `pysam`, `scikit-survival`) live in their respective domain plugins or skill-local environments instead of inflating this base runtime.

## Consumers

| Consumer        | Packages                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| notebooks       | `python=3.12`, `ipykernel`                                                   |
| skill-creator   | `pyyaml`                                                                     |
| data & ML core  | `numpy`, `scipy`, `pandas`, `matplotlib-base`, `seaborn`, `scikit-learn`, `networkx` |
| office (pptx)   | `python-pptx`, `nodejs`, `pptxgenjs`, `defusedxml`, `lxml`, `pillow`, `git`  |
| office (xlsx)   | `openpyxl`, `python-calamine`, `xlsxwriter`, `defusedxml`, `lxml`, `git`     |
| office (docx)   | `python-docx`, `lxml`                                                        |
| office (pdf)    | `reportlab`, `pdfplumber`, `pypdf`, `poppler`                                |
| markitdown      | `markitdown`, `requests`, `openai`, `python-dotenv`, `tesseract`             |

## Locks

Solved against the official lock baselines: macOS arm64 11.0, macOS x64 10.15, linux glibc 2.17 / linux 4.18, and Windows 10 (`win32-x64`).

Regenerate the Unix lock platforms:

```bash
bun run runtime:lock -- --spec resources/runtime/environments/phi-python/environment.yml
```

Regenerate the Windows lock:

```bash
bun run runtime:lock -- --spec resources/runtime/environments/phi-python/environment.yml --platform win32-x64
```
