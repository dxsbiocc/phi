# Dependency inventory

Date: 2026-09-29

Input for the `phi-python`, `viz`, `phi-nextflow`, and `phi-jupyter` specs
([runtime foundation](../design/phi-runtime-foundation.md) §3, §3.2, §5, §10;
[implementation plan](../roadmap/content-distribution-implementation.md) step
0.5 and steps 3–5). This file only records what the scripts and the listed
engine components actually use. It does not create environments.

Conda availability was checked on 2026-09-29 with micromamba 2.1.1:

```text
micromamba search --no-rc --override-channels -c conda-forge -c bioconda \
  --platform <osx-arm64|osx-64|linux-64> --json <package>...
```

Those three conda subdirs are the platforms in §2.1 (`darwin-arm64`,
`darwin-x64`, `linux-x64`). "All three" below means the package name was
returned for osx-arm64, osx-64, and linux-64. A package is not listed as
available unless that search returned it. Channel is conda-forge unless the
row says bioconda.

## Summary

The `docx` and `scvi-tools` skills were removed on 2026-09-29 (`docx`: npm
`docx` has no conda package; `scvi-tools`: pulls PyTorch) and may return
later with their own environments.

### `phi-python`

Python 3.12 or newer. scanpy 1.12 requires it
(`resources/skills/scanpy/SKILL.md` line 17).

Union of non-visualization skill needs, plus the tools named in step 3.2.
Packages already pulled in by `scanpy` or `markitdown` on conda-forge are
still listed when a skill imports or documents them.

| Conda package | Why it is in the union | Channel |
|---|---|---|
| `python` (>=3.12), `ipykernel` | interpreter; step 5.3 default Python kernel | conda-forge, all three |
| `nodejs` | `pptx` JS generation via `pptxgenjs` (that package depends on `nodejs`) | conda-forge, all three |
| `poppler` | `pdftoppm` (pptx script; pdf SKILL.md) | conda-forge, all three |
| `tesseract` | markitdown SKILL.md OCR troubleshooting | conda-forge and bioconda, all three |
| `git` | `pptx` and `xlsx` redlining validators (`scripts/office/validators/redlining.py`) | conda-forge, all three |
| `coreutils` | `timeout` / `gtimeout` in `xlsx` recalc. Binary names unverified | conda-forge, all three |
| `defusedxml`, `lxml`, `openpyxl`, `pillow` | pptx (`defusedxml`, `lxml`, `pillow`) and xlsx (`defusedxml`, `lxml`, `openpyxl`) | conda-forge, all three |
| `markitdown`, `requests`, `openai`, `python-dotenv` | markitdown scripts | conda-forge, all three |
| `numpy`, `scipy`, `pandas`, `matplotlib`, `scikit-learn` | matplotlib, scikit-learn, scanpy, scvelo scripts | conda-forge, all three |
| `rdkit` | rdkit scripts | conda-forge, all three |
| `scanpy`, `scvelo` | scanpy and scvelo scripts | both channels, all three |
| `leidenalg`, `python-igraph` | scanpy Leiden extra; not a direct import | conda-forge, all three |
| `harmonypy`, `bbknn` | scanpy batch-correction methods; not direct imports | bioconda only, all three |
| `reportlab`, `pdfplumber`, `pypdf` | pdf SKILL.md (no bundled script) | conda-forge, all three |
| `python-calamine` | xlsx SKILL.md, marked optional there | conda-forge, all three |
| `anndata` | anndata skill; also a scanpy dependency | both channels, all three |
| `seaborn` | seaborn skill; also a scanpy dependency | conda-forge, all three |
| `networkx` | networkx skill; also a scanpy dependency | conda-forge, all three |
| `shap` | shap skill | conda-forge, all three |
| `pysam` | pysam skill | bioconda only, all three |
| `scikit-survival` | scikit-survival skill (`import sksurv`) | conda-forge, all three |

`pandoc` is not in the union. Only the removed `docx` skill documented it.

conda-forge `markitdown` 0.1.8 (noarch) already depends on `requests`,
`pandas`, `lxml`, `openpyxl`, `defusedxml`, `beautifulsoup4`, `python-pptx`,
`pdfplumber`, `pdfminer.six`, and `mammoth`. It does not depend on `openai`,
`python-dotenv`, or `tesseract`.

conda-forge `scanpy` 1.12.4 (noarch) already depends on `anndata`, `numpy`,
`scipy`, `pandas`, `matplotlib-base`, `seaborn`, `scikit-learn`, `networkx`,
`h5py`, `numba`, `umap-learn`, and `statsmodels`. It does not depend on
`leidenalg`, `python-igraph`, `harmonypy`, or `bbknn`.

Not proposed for `phi-python`: `anndata[dask,lazy]`,
`scanpy` plus `dask`, `rapids-singlecell`, and example-only installs in skill
references (`category-encoders`, `imbalanced-learn`, a direct `umap-learn`
install, `geopandas`, `momepy`, `plotly`, `pyvis`). `umap-learn` still arrives
transitively through `scanpy`. Notebook formatters `ruff` and `black` exist
on conda-forge for all three platforms; the notebook treats them as optional
(see Notebook).

### `viz`

R plus the packages the 159 R scripts load, and a Python interpreter for the
three standard-library scripts. No third-party Python import.

| Conda package | Used by (of 159 R files) | Notes |
|---|---|---|
| `python` | 3 Python scripts | standard library only |
| `r-base` | every render (`Rscript`) | includes `grid`, `stats`, `grDevices`, `graphics`, `tools` |
| `r-readr` | 154 | |
| `r-ggplot2` | 146 | |
| `r-ggprism` | 115 | |
| `r-ggraph`, `r-tidygraph` | 18 each | |
| `r-ggrepel` | 14 | |
| `r-patchwork` | 14 | 10 plot scripts plus 3 layout compose scripts and `::` |
| `r-circlize` | 12 | |
| `bioconductor-complexheatmap` | 11 | Bioconductor. bioconda, all three |
| `r-ggforce`, `r-ggpubr` | 9 each | |
| `r-ggnewscale`, `r-scales` | 6 each | |
| `r-jsonlite` | 6 | helpers and layout compose, not plot templates |
| `r-geomtextpath`, `r-gghalves`, `r-ggsignif`, `r-gtable` | 3 each | |
| `r-aplot`, `r-ggbeeswarm`, `r-ggh4x` | 2 each | |
| `r-cli` | 1 | only the ggideogram compatibility patch |
| `r-ggextra` | 1 | import name `ggExtra` |
| `r-ggridges`, `r-ggtern`, `r-ggvenn`, `r-graphlayouts` | 1 each | |
| `r-hexbin`, `r-quantreg`, `r-sf`, `r-survival`, `r-survminer`, `r-waffle` | 1 each | |
| `r-yaml` | 1 | `layouts/validate_layouts.R` only |

All of those conda names were found on all three platforms. `r-survival` is
the split-out recommended package; the other base packages in the `::` list
(`grid` 28 files, `stats` 33, `grDevices` 28, `graphics` 10, `tools` 15) ship
inside `r-base`.

These R packages are loaded by scripts and had **no** `r-<lowercase>` (or
bioconda) build on any of the three platforms:

| Package | Files | Example |
|---|---|---|
| `gground` | 7 | `scripts/pie/doughnut_round/plot.R:70` |
| `ggideogram` | 5 | `scripts/ideogram/karyotype/plot.R:76` |
| `ggcor` | 4 | `scripts/heatmap/two_shape/plot.R:73` |
| `linkET` | 3 | `scripts/heatmap/shape/plot.R:67` |
| `ggsankey` | 2 | `scripts/sankey/basic/plot.R:70` |
| `ggsvg` | 2 | `scripts/scatter/svg/plot.R:86` |
| `ggmagnify` | 1 | `scripts/scatter/volcano_inset/plot.R:86` |

`viz` does not need LibreOffice, pandoc, poppler, or tesseract.

### `phi-nextflow` and `phi-jupyter`

Current executables, not a full lock:

- `phi-nextflow`: bioconda `nextflow` (noarch, all three). The 26.04.6 build
  depends on `openjdk >=17,<26`, `coreutils`, and `curl`. The executor spawns
  `nextflow`, not `java`; Java is required because Nextflow is a JVM program
  (`executor.ts` lines 133–135). Proposed in the same environment: bioconda
  `nf-core` 4.1.0 and `nf-test` 0.9.5 (noarch). They solve on osx-arm64 with
  `nextflow` 26.04.6: 167 packages, 378 MB total download, versus 19 packages
  / 261 MB for `nextflow` alone. The nextflow skill documents both
  (`SKILL.md` lines 43–49; nf-test in `references/testing.md`), and wrapper
  module tests (`tests/main.nf.test`) are nf-test suites.
- `phi-jupyter`: conda-forge `jupyter_server` (noarch, all three). It depends
  on `jupyter_core`, which provides the `jupyter` command the notebook
  spawns. Kernels stay in the analysis environments: `ipykernel` in
  `phi-python`, `r-irkernel` in `phi-r` (step 5.3). `r-irkernel` is on
  conda-forge for all three platforms. This inventory did not enumerate
  `phi-r` beyond that and the scanpy interop note below.

### Host dependencies

Declared in the spec `host:` section (§3.2). Checked, not installed.

| Executable | Where | Conda on the three platforms |
|---|---|---|
| `soffice` (LibreOffice) | docx, pptx, xlsx scripts and SKILL.md | `libreoffice` / `libreoffice-still` not found on any platform. Host, per §9 decision 4 |
| Docker daemon | wrapper profile `docker` | conda-forge `docker-cli` exists on all three and does not provide a daemon. Host, per §9 decision 4 |
| `singularity` or `apptainer` | wrapper profile `singularity` | both names exist on linux-64 only. Host, per §9 decision 4 |
| `gcc` | `office/soffice.py` socket shim, only when `AF_UNIX` is blocked | conda-forge `gcc` exists on osx-64 and linux-64, not osx-arm64. The shim command is a Linux shared library (`-shared -fPIC -ldl`). Treat as a host tool for that Linux path, not as a `phi-python` package |

`gtimeout` is optional on Darwin (`xlsx/scripts/recalc.py`). If the
`coreutils` package's macOS binary is named `gtimeout`, it is an env
package; that filename was not verified by listing the archive.

### Open questions

1. **`docx` (docx-js).** Resolved on 2026-09-29 by removing the skill. npm
   `docx` has no conda package. The skill may return later in its own
   environment. `pptxgenjs` is different: conda-forge `pptxgenjs` 4.0.1 is
   noarch, depends on `nodejs`, and is on all three platforms
   (`resources/skills/pptx/SKILL.md` line 231).
2. **Seven R packages have no conda build** (table above). A `viz` lock
   cannot cover those templates until they are packaged or vendored.
   `scripts/lib/common.R` lines 246–248 also say ggideogram 0.1.0 calls a
   ggplot2 internal that ggplot2 4.x removed. conda-forge `r-ggplot2` latest
   on the day of this search was 4.0.3.
3. **`scvi-tools` in the shared env.** Resolved on 2026-09-29 by removing
   the skill. It pulls PyTorch. It may return later in its own environment.
4. **Scanpy R interop is documented, not shipped.**
   `resources/skills/scanpy/references/r_interop.md` tells the agent to
   `Rscript` a conversion that needs `zellkonverter`, `SingleCellExperiment`,
   `Seurat`, and `SeuratObject`. Those four conda names
   (`bioconductor-zellkonverter`, `bioconductor-singlecellexperiment`,
   `r-seurat`, `r-seuratobject`) exist on all three platforms.
   `SeuratDisk` is installed from GitHub in that note. This belongs with
   `phi-r`, not `phi-python`. No `convert_rds_to_h5ad.R` is in the tree.
5. **Tesseract language data** was not checked. The `tesseract` package is
   present; whether `eng.traineddata` is inside it is unverified.
6. **`coreutils` binary names** on macOS (`timeout` vs `gtimeout`) are
   unverified.
7. **`nf-core` and `nf-test`** are noarch on bioconda and solve on osx-arm64
   together with `nextflow` 26.04.6. micromamba 2.1.1 requires a target
   prefix (`-p`); the solve is otherwise the command below. Result: 167
   packages, 378 MB total download, versus 19 packages / 261 MB for
   `nextflow` alone. Versions: `nf-core` 4.1.0, `nf-test` 0.9.5. Proposed
   contents of `phi-nextflow`, not `phi-python`. The nextflow skill and
   wrapper module tests (`tests/main.nf.test`) use them.

   ```text
   micromamba create --no-rc --override-channels -c conda-forge -c bioconda \
     --platform osx-arm64 --dry-run -p <prefix> nextflow nf-core nf-test
   ```

## How the counts were produced

Script-bearing skill directories (76 Python files, 159 R files, no `.sh`,
`.js`, `.mjs`, or `.ts` under `resources/skills/`):

| Skill | Python | R |
|---|---|---|
| `docx` | 15 | 0 |
| `markitdown` | 5 | 0 |
| `matplotlib` | 2 | 0 |
| `omics-visualization` | 3 | 159 |
| `pptx` | 16 | 0 |
| `rdkit` | 3 | 0 |
| `scanpy` | 16 | 0 |
| `scikit-learn` | 2 | 0 |
| `scvelo` | 1 | 0 |
| `xlsx` | 13 | 0 |

The other skill directories (`anndata`, `create-database-connector`,
`create-wrapper`, `networkx`, `nextflow`, `pdf`, `pysam`, `scikit-survival`,
`scvi-tools`, `seaborn`, `shap`) contain no files of those extensions. Their
documented installs are in the last section, because step 3 still points
undeclared skills at `phi-python`.

Python import lines, R package lines, and the raw counts:

```text
grep -rhE --include='*.py' '^[[:space:]]*(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_\.]*' resources/skills | wc -l
# 384

grep -rhoE --include='*.py' '^[[:space:]]*(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_\.]*' resources/skills | sed -E 's/^[[:space:]]*//' | sort -u | wc -l
# 63

grep -rhoE --include='*.R' 'library[[:space:]]*\([^)]*\)' resources/skills | wc -l
# 6

grep -rhoE --include='*.R' 'require[[:space:]]*\([^)]*\)' resources/skills | wc -l
# 0

grep -rhoE --include='*.R' 'requireNamespace[[:space:]]*\([^)]*\)' resources/skills | wc -l
# 2

grep -rhoE --include='*.R' '[A-Za-z][A-Za-z0-9.]*::' resources/skills | wc -l
# 1188

grep -rhE --include='*.R' 'load_packages[[:space:]]*\(' resources/skills | wc -l
# 154
```

The `library(` count of 6 is not six packages. Two matches are
`load_palette_library()` in `scripts/lib/common.R` (lines 166 and 198). The
four real calls are dynamic loads plus two literals:

- `scripts/lib/common.R:23` — `library(pkg, character.only = TRUE)` inside
  `load_packages()`
- `scripts/layouts/lib/layout_common.R:22` — `library(package, character.only = TRUE)`
- `scripts/layouts/validate_layouts.R:7` — `library(jsonlite)`
- `scripts/layouts/validate_layouts.R:8` — `library(yaml)`

`requireNamespace(` is `scripts/lib/common.R:157` (`jsonlite`) and line 250
(`ggideogram`). `require(` does not occur. `require_columns()` is a local
helper, not `require()`.

Of the 154 `load_packages(` lines, 153 are calls in `plot.R` and one is the
error string `load_packages()` in `scripts/lib/common.R:7`. Plot scripts do
not call `library()` themselves. They call `load_packages(c(...))`, and
`common.R` attaches those names. Package file counts below are the union of
`load_packages` string literals, `load_layout_packages()` (ggplot2,
patchwork, jsonlite), literal `library` / `requireNamespace`, and `pkg::`
on non-comment lines. The 1188 `::` count is the raw grep, comments included.

The 159 R files are 153 `plot.R` templates, 3 `compose.R` layout scripts,
and 3 helpers (`scripts/lib/common.R`, `scripts/layouts/lib/layout_common.R`,
`scripts/layouts/validate_layouts.R`).

Standard-library imports and a skill's own modules are omitted below
(`office`, `helpers`, `validators`, relative imports, scanpy `_common`,
`route_template`).

## Skills

### `pptx` (16 Python files)

**Python:** `defusedxml`, `lxml` (same office tree as docx), `pillow`.

- `scripts/thumbnail.py:27` — `from PIL import Image, ImageDraw, ImageFont`
  (conda name `pillow`)

**External commands:**

| Command | Evidence | Conda |
|---|---|---|
| `soffice` | `scripts/thumbnail.py:163`; `scripts/office/soffice.py:37` | host |
| `pdftoppm` | `scripts/thumbnail.py:180` | `poppler` provides `pdftoppm`, all three |
| `gcc` | `scripts/office/soffice.py:60` | host |
| `git` | `scripts/office/validators/redlining.py:140` | `git`, all three |

**Node:** SKILL.md line 231, `npm install -g pptxgenjs`. conda-forge
`pptxgenjs` 4.0.1, noarch, depends on `nodejs`, all three platforms. No
`.js` file in the skill.

**Also documented:** SKILL.md line 229, `pip install "markitdown[pptx]"`
(the markitdown skill's package, not imported here).

### `xlsx` (13 Python files)

**Python:** `defusedxml`, `lxml` (same office tree), `openpyxl`.

- `scripts/recalc.py:18` — `from openpyxl import load_workbook`

Scripts do not import `pandas` or `python-calamine`. SKILL.md lines 78–84
tell the agent to install both; `python-calamine` is labeled optional.

**External commands:**

| Command | Evidence | Conda |
|---|---|---|
| `soffice` | `scripts/recalc.py:59` and line 83; `scripts/office/soffice.py:59` | host |
| `gcc` | `scripts/office/soffice.py:91` | host |
| `git` | `scripts/office/validators/redlining.py:140` | `git`, all three |
| `timeout` | `scripts/recalc.py:91`, Linux only | `coreutils` package exists on all three; the `timeout` filename was not listed out of the archive |
| `gtimeout` | `scripts/recalc.py:38` and line 93, Darwin, optional | same caveat |

SKILL.md lines 99–105 state LibreOffice and this conditional `gcc` use.

### `pdf` (no scripts)

SKILL.md is the whole interface. Included because step 3.6 migrates it into
`phi-python`.

- Lines 32 and 36: `reportlab`, `pdfplumber`, `pypdf`
- Lines 40–44 and 54: `pdftoppm` from Poppler (`brew install poppler` /
  `apt-get install poppler-utils`). conda-forge `poppler` is on all three
  platforms and ships `pdftoppm`.

No tesseract, pandoc, or `soffice` in this SKILL.md.

### `markitdown` (5 Python files)

**Python:**

| Import | Conda name | Evidence |
|---|---|---|
| `markitdown` | `markitdown` | `scripts/batch_convert.py:12`, `scripts/convert_literature.py:15`, `scripts/convert_with_ai.py:13` |
| `openai` | `openai` | `scripts/convert_with_ai.py:14` |
| `requests` | `requests` | `scripts/generate_schematic_ai.py:31` |
| `dotenv` | `python-dotenv` | `scripts/generate_schematic_ai.py:40` |

`scripts/generate_schematic.py:112` subprocesses `sys.executable` on the
sibling script. That is not an external tool.

**Documented, not spawned:** SKILL.md lines 455–461, install `tesseract` /
`tesseract-ocr` when OCR fails. conda-forge `tesseract` is on all three
platforms. Language data: unverified.

### `matplotlib` (2 Python files)

| Import | Conda name | Evidence |
|---|---|---|
| `numpy` | `numpy` | `scripts/plot_template.py:15`, `scripts/style_configurator.py:16` |
| `matplotlib` | `matplotlib` | `scripts/plot_template.py:16`, `scripts/style_configurator.py:17` |
| `scipy` | `scipy` | `scripts/plot_template.py:161` `from scipy.stats import norm` |

No external commands.

### `rdkit` (3 Python files)

`rdkit` in all three scripts. Example: `scripts/molecular_properties.py:18`
`from rdkit import Chem`. conda-forge `rdkit`, all three. SKILL.md lines
33–37 say to prefer the conda package over a mixed PyPI install. No external
commands.

### `scikit-learn` (2 Python files)

| Import | Conda name | Evidence |
|---|---|---|
| `numpy` | `numpy` | `scripts/clustering_analysis.py:5` |
| `pandas` | `pandas` | `scripts/clustering_analysis.py:6` |
| `matplotlib` | `matplotlib` | `scripts/clustering_analysis.py:7` |
| `sklearn` | `scikit-learn` | `scripts/clustering_analysis.py:8` and `scripts/classification_pipeline.py:8` |

No external commands. SKILL.md lines 24–30 also install `seaborn`. Reference
docs mention optional `category-encoders`, `umap-learn`, and
`imbalanced-learn`; those are example installs, not script imports.
`umap-learn` is a conda-forge dependency of `scanpy` anyway.

### `scanpy` (16 Python files)

**Imported by scripts:**

| Import | Conda name | Evidence |
|---|---|---|
| `scanpy` | `scanpy` | `scripts/_common.py:29`; `assets/analysis_template.py:11` |
| `pandas` | `pandas` | `scripts/annotate.py:33`, `scripts/find_markers.py:59`, `scripts/pseudobulk.py:50`, `scripts/run_pipeline.py:165`, `assets/analysis_template.py:12` |
| `numpy` | `numpy` | `scripts/inspect_data.py:17`, `assets/analysis_template.py:13` |
| `matplotlib` | `matplotlib` | `assets/analysis_template.py:14` |

Every CLI script imports `_common`. `_common.configure_scanpy` calls
`_import_scanpy()`, so a missing `scanpy` aborts the toolkit. The failure
text asks for `scanpy[leiden]` (`scripts/_common.py:32`). SKILL.md lines
19–22 say that extra is `python-igraph` and `leidenalg`. `scripts/cluster.py`
calls `sc.tl.leiden`. Neither package is imported by name in the skill.

**Called through scanpy, not imported here:**

- `harmonypy` — `scripts/batch_correct.py:43`, `sc.external.pp.harmony_integrate`.
  Default `--method` is `harmony` (line 30). bioconda, all three.
- `bbknn` — `scripts/batch_correct.py:52`, `sc.external.pp.bbknn`. bioconda,
  all three.

**Documented R path, no script in the tree:** SKILL.md line 131,
`Rscript convert_rds_to_h5ad.R`. The script body lives only as a markdown
example in `references/r_interop.md`. See open question 4.

### `scvelo` (1 Python file)

`scripts/rna_velocity_workflow.py`:

- line 12 `import scvelo` → conda `scvelo` (conda-forge and bioconda, all three)
- line 13 `import scanpy`
- line 14 `import numpy`
- line 15 `import matplotlib`

No external commands. SKILL.md line 14: `pip install scvelo`.

### `omics-visualization`

#### Python (3 files)

No third-party imports.

- `scripts/qa_single_plot.py` — `argparse`, `json`, `re`, `struct`, `sys`,
  `xml.etree.ElementTree`, `pathlib`, `typing`
- `scripts/route_template.py` — `argparse`, `csv`, `json`, `math`, `re`,
  `sys`, `pathlib`, `typing`
- `scripts/validate_template_contracts.py` — same stdlib set, plus
  `from route_template import DEFAULT_CONTRACTS, ROLE_HINTS` (local module)

No subprocess calls.

#### R

`load_packages()` is the loader for 153 `plot.R` files. Counts are files,
out of 159.

| Package | Files | Conda name | Bioconductor | Example |
|---|---|---|---|---|
| `readr` | 154 | `r-readr` | no | `scripts/tree/dendrogram/plot.R:76` |
| `ggplot2` | 146 | `r-ggplot2` | no | `scripts/tree/dendrogram/plot.R:76` |
| `ggprism` | 115 | `r-ggprism` | no | `scripts/tree/dendrogram/plot.R:76` |
| `stats` | 33 | in `r-base` | no | `scripts/tree/dendrogram/plot.R:114` `stats::` |
| `grDevices` | 28 | in `r-base` | no | `scripts/graph/chord/plot.R:151` |
| `grid` | 28 | in `r-base` | no | `scripts/ideogram/circos/plot.R:112` (also passed to `load_packages` in 8 files) |
| `ggraph` | 18 | `r-ggraph` | no | `scripts/tree/dendrogram/plot.R:76` |
| `tidygraph` | 18 | `r-tidygraph` | no | `scripts/tree/dendrogram/plot.R:76` |
| `tools` | 15 | in `r-base` | no | `scripts/graph/chord/plot.R:173` `tools::` |
| `ggrepel` | 14 | `r-ggrepel` | no | `scripts/tree/enrichment_ring/plot.R:91` |
| `patchwork` | 14 | `r-patchwork` | no | `scripts/tree/enrichment_ring/plot.R:91`; layouts via `load_layout_packages()` |
| `circlize` | 12 | `r-circlize` | no | `scripts/graph/chord/plot.R:78` |
| `ComplexHeatmap` | 11 | `bioconductor-complexheatmap` | yes | `scripts/ideogram/circos/plot.R:112` |
| `graphics` | 10 | in `r-base` | no | `scripts/graph/chord/plot.R:193` |
| `ggforce` | 9 | `r-ggforce` | no | `scripts/sankey/parallel_sets/plot.R:75` |
| `ggpubr` | 9 | `r-ggpubr` | no | `scripts/boxplot/differential_facet/plot.R:73` |
| `gground` | 7 | none found | no | `scripts/pie/doughnut_round/plot.R:70` |
| `ggnewscale` | 6 | `r-ggnewscale` | no | `scripts/boxplot/polar_heatmap/plot.R:74` |
| `jsonlite` | 6 | `r-jsonlite` | no | `scripts/lib/common.R:157` `requireNamespace("jsonlite")` |
| `scales` | 6 | `r-scales` | no | `scripts/scatter/ternary/plot.R:84` |
| `ggideogram` | 5 | none found | no | `scripts/ideogram/karyotype/plot.R:76`; also `requireNamespace` at `common.R:250` |
| `ggcor` | 4 | none found | no | `scripts/heatmap/two_shape/plot.R:73` |
| `geomtextpath` | 3 | `r-geomtextpath` | no | `scripts/boxplot/polar/plot.R:69` |
| `gghalves` | 3 | `r-gghalves` | no | `scripts/boxplot/raincloud/plot.R:69` |
| `ggsignif` | 3 | `r-ggsignif` | no | `scripts/boxplot/differential_expression/plot.R:71` |
| `gtable` | 3 | `r-gtable` | no | `scripts/ideogram/coverage/plot.R:97` |
| `linkET` | 3 | none found (`r-linket` searched) | no | `scripts/heatmap/shape/plot.R:67` |
| `aplot` | 2 | `r-aplot` | no | `scripts/heatmap/mutation_energy/plot.R:77` |
| `ggbeeswarm` | 2 | `r-ggbeeswarm` | no | `scripts/scatter/beeswarm_group/plot.R:77` |
| `ggh4x` | 2 | `r-ggh4x` | no | `scripts/ideogram/coverage/plot.R:97` |
| `ggsankey` | 2 | none found | no | `scripts/sankey/basic/plot.R:70` |
| `ggsvg` | 2 | none found | no | `scripts/scatter/svg/plot.R:86` |
| `cli` | 1 | `r-cli` | no | `scripts/lib/common.R:260` `cli::cli_warning` |
| `ggExtra` | 1 | `r-ggextra` | no | `scripts/scatter/marginal/plot.R:71` |
| `ggmagnify` | 1 | none found | no | `scripts/scatter/volcano_inset/plot.R:86` |
| `ggridges` | 1 | `r-ggridges` | no | `scripts/line/ridge/plot.R:81` |
| `ggtern` | 1 | `r-ggtern` | no | `scripts/scatter/ternary/plot.R:84` |
| `ggvenn` | 1 | `r-ggvenn` | no | `scripts/bar/venn/plot.R:80` |
| `graphlayouts` | 1 | `r-graphlayouts` | no | `scripts/graph/stress/plot.R:80` |
| `hexbin` | 1 | `r-hexbin` | no | `scripts/scatter/hex/plot.R:70` |
| `quantreg` | 1 | `r-quantreg` | no | `scripts/boxplot/raincloud_differential/plot.R:74` |
| `sf` | 1 | `r-sf` | no | `scripts/heatmap/corr_rotate/plot.R:112` |
| `survival` | 1 | `r-survival` | no | `scripts/line/survival/plot.R:73` |
| `survminer` | 1 | `r-survminer` | no | `scripts/line/survival/plot.R:73` |
| `waffle` | 1 | `r-waffle` | no | `scripts/bar/waffle/plot.R:73` |
| `yaml` | 1 | `r-yaml` | no | `scripts/layouts/validate_layouts.R:8` `library(yaml)`; `yaml::read_yaml` at line 28 |

`readr` is one file above the 153 plot scripts because `scripts/lib/common.R`
calls `readr::read_delim` (`common.R` around the `read_table_auto` helper).
The five R files that do not reference `readr` are the three layout
`compose.R` scripts, `layout_common.R`, and `validate_layouts.R`.

`jsonlite` is used by `common.R` (palette JSON), `layout_common.R`
(`load_layout_packages` plus `jsonlite::write_json`), `validate_layouts.R`,
and the three `compose.R` scripts that call `load_layout_packages()`.

**External commands:**

- `Rscript`, from the template header example and from
  `scripts/layouts/validate_layouts.R:74` `system2("Rscript", ...)`.
  conda-forge `r-base` provides `Rscript` on all three platforms.
- No `system()`, shell backticks, or other binaries in the R tree. A grep
  for `system2?(` hits `system2(` only in `validate_layouts.R`.

**Node:** none.

## Engine components

### `src/main/agent/visualization/`

Spawns two host executables. It does not import Python or R packages itself.

| Command | Calls | Evidence |
|---|---|---|
| `python3` | `scripts/route_template.py` | `route.ts:140` `run('python3', args)` with `args` starting at `route.ts:128` |
| `Rscript` | the template `plot.R` (or `compose.R`) passed in the request | `render.ts:141` `run('Rscript', [script.path, ...request.inputs, output.path])` |
| `python3` | `scripts/qa_single_plot.py` | `render.ts:161` |

`prepare.ts:112` returns the string `` Rscript ${script} ... `` to the agent.
It does not spawn it. `examples.ts` does not spawn.

Both Python programs are the standard-library scripts above. Rendering fails
closed when `Rscript` or `python3` is missing (`render.ts:149`,
`route.ts:144`). After step 4 these become programs inside `viz`, so `viz`
must provide `Rscript` and `python3` on its own prefix `bin`.

### `src/main/agent/notebook/`

| Executable | How | Evidence | Conda |
|---|---|---|---|
| `jupyter` | `jupyter server ...` | `analysis-jupyter-server.ts:98` `spawn('jupyter', jupyterServerArgs(...))`; args at lines 83–94 (`server`, `--no-browser`, `ServerApp.*`) | `jupyter_server` (depends on `jupyter_core`), all three |
| `jupyter` | `jupyter server --version` | `analysis-kernels.ts:127` | same |
| `jupyter` | `jupyter kernelspec list --json` | `analysis-kernels.ts:145` | same. Looks for a kernel named `python3`, then any Python kernel, then any R kernel (lines 110–115, 151–158). Does not install `ipykernel` or `irkernel` |
| `ruff` | `ruff format ...` | `analysis-notebook-formatting.ts:102` | conda-forge `ruff`, all three. Optional: the formatter walks on to black |
| `python` | `python -m black` | `analysis-notebook-formatting.ts:107` | conda-forge `black`, all three. Optional |
| `python3` | `python3 -m black` | `analysis-notebook-formatting.ts:112` | same |
| `python` or `python3` | project `.venv` first, then those names, to list installed modules | `analysis-python-packages.ts:88` | the analysis env's interpreter, not a notebook-only package |

The notebook never spawns `Rscript`. An R kernel is detected if a host
kernelspec advertises language `r`. Step 5.3 moves the server into
`phi-jupyter` and the default kernels into `phi-python` (`ipykernel`) and
`phi-r` (`r-irkernel`).

### `src/main/agent/wrappers/composition/executor.ts`

| Executable | Role | Evidence | Conda |
|---|---|---|---|
| `nextflow` | the process that is spawned | `executor.ts:185` `findNextflowBinary()`, `executor.ts:217` `spawn(nextflowBin, args)` | bioconda `nextflow`, noarch, all three. Depends on `openjdk >=17,<26`, `coreutils`, `curl` |
| `java` | not spawned by Phi. Nextflow's JVM is why the process group is killed | `executor.ts:133` | conda-forge `openjdk`, all three. Pulled in by `nextflow` |
| `which` | `which nextflow` | `executor.ts:60` | system `/usr/bin/which`, not a conda package |
| `conda` or `mamba` | not spawned here. If the chosen `nextflow` binary lives in `.../envs/<name>/bin`, the executor prepends that install's `condabin` and `bin` so Nextflow's `-profile conda` can find them | `executor.ts:71`–76, `executor.ts:196`–199 | today this is the user's conda. Step 5.2 points `-profile conda` at bundled micromamba instead |
| Docker, Singularity | not spawned here. The profile is an argument | `executor.ts:11` profiles `docker`, `singularity`, `conda`; `executor.ts:208` `-profile` | host daemons / binaries. See summary |

Lookup order for Nextflow (`executor.ts:53`–67): `NEXTFLOW_BIN`, then
`~/.phi/environment.json` via `getActiveToolPath('nextflow')`, then
`which nextflow`, then `nextflow` under `~/miniconda3|anaconda3|miniforge3/envs/*/bin`.

## Skills with no bundled scripts

Primary packages only. Optional extras in references are not in the
`phi-python` union except where the summary says they ride in via `scanpy`
or `markitdown`.

| Skill | Evidence | Conda name | Platforms |
|---|---|---|---|
| `anndata` | `SKILL.md:32` `uv pip install "anndata==0.12.16"` | `anndata` | all three (conda-forge and bioconda) |
| `networkx` | `SKILL.md:266` commented `uv pip install networkx` | `networkx` | all three |
| `seaborn` | `SKILL.md:6` and line 22, `seaborn==0.13.2` | `seaborn` | all three |
| `shap` | `SKILL.md:542` `uv pip install shap` | `shap` | all three |
| `pysam` | `SKILL.md:30` `uv pip install pysam` | `pysam` | all three, bioconda only |
| `scikit-survival` | examples `from sksurv...` (`SKILL.md:90`). No install line | `scikit-survival` (import `sksurv`) | all three |
| `nextflow` | `SKILL.md:48` `pip install nf-core` or `conda install -c bioconda nf-core` | `nf-core`, `nf-test` | all three. Proposed in `phi-nextflow` |
| `pdf` | see the pdf section | `reportlab`, `pdfplumber`, `pypdf`, `poppler` | all three |
| `create-database-connector`, `create-wrapper` | authoring docs for this repository (`node`, `npm`, `git`). Not skill runtime packages | — | — |

`create-wrapper` also documents host `nextflow`, Java 17+, and a Docker
daemon (`SKILL.md` around lines 196–200). That matches the executor, not a
second runtime.
