# Dependency inventory

Date: 2026-10-07
Updated: 2026-10-07 — visualization dependencies consolidated into `phi-r`.

Input for the `phi-python`, `phi-r`, `phi-nextflow`, and `phi-jupyter` specs
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

The Office plugin ships `xlsx`, `pptx`, `pdf`, `docx`, and
`office-workflow`. All five skills select `phi:python@1`; the plugin does not
create a second Python environment. The `docx` skill uses conda-forge
`python-docx`, not the unrelated npm `docx` package. `scvi-tools` remains
excluded because it pulls PyTorch.

### `phi-python`

Python 3.12 or newer. scanpy 1.12 requires it
(`resources/skills/scanpy/SKILL.md` line 17).

Union of non-visualization skill needs, plus the tools named in step 3.2.
Packages already pulled in by `scanpy` or `markitdown` on conda-forge are
still listed when a skill imports or documents them.

| Conda package                                            | Why it is in the union                                                            | Channel                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| `python` (>=3.12), `ipykernel`                           | interpreter; step 5.3 default Python kernel                                       | conda-forge, all three              |
| `coreutils`                                              | shared runtime compatibility; not an Office-skill dependency                      | conda-forge, all three              |
| `nodejs`                                                 | `pptx` JS generation via `pptxgenjs` (that package depends on `nodejs`)           | conda-forge, all three              |
| `poppler`                                                | PDF page rendering documented by the `pdf` skill                                  | conda-forge, all three              |
| `tesseract`                                              | markitdown SKILL.md OCR troubleshooting                                           | conda-forge and bioconda, all three |
| `git`                                                    | `pptx` and `xlsx` redlining validators (`scripts/office/validators/redlining.py`) | conda-forge, all three              |
| `defusedxml`, `lxml`, `openpyxl`, `pillow`               | OOXML validation/editing shared by xlsx, pptx, and docx                           | conda-forge, all three              |
| `python-docx`, `python-pptx`, `xlsxwriter`               | managed Python creation/editing for docx, pptx, and xlsx                          | conda-forge, all three              |
| `markitdown`, `requests`, `openai`, `python-dotenv`      | markitdown scripts                                                                | conda-forge, all three              |
| `numpy`, `scipy`, `pandas`, `matplotlib`, `scikit-learn` | matplotlib, scikit-learn, scanpy, scvelo scripts                                  | conda-forge, all three              |
| `rdkit`                                                  | rdkit scripts                                                                     | conda-forge, all three              |
| `scanpy`, `scvelo`                                       | scanpy and scvelo scripts                                                         | both channels, all three            |
| `leidenalg`, `python-igraph`                             | scanpy Leiden extra; not a direct import                                          | conda-forge, all three              |
| `harmonypy`, `bbknn`                                     | scanpy batch-correction methods; not direct imports                               | bioconda only, all three            |
| `reportlab`, `pdfplumber`, `pypdf`                       | PDF generation/extraction; `pdf_inspect.py` imports `pypdf`                       | conda-forge, all three              |
| `python-calamine`                                        | xlsx SKILL.md, marked optional there                                              | conda-forge, all three              |
| `anndata`                                                | anndata skill; also a scanpy dependency                                           | both channels, all three            |
| `seaborn`                                                | seaborn skill; also a scanpy dependency                                           | conda-forge, all three              |
| `networkx`                                               | networkx skill; also a scanpy dependency                                          | conda-forge, all three              |
| `shap`                                                   | shap skill                                                                        | conda-forge, all three              |
| `pysam`                                                  | pysam skill                                                                       | bioconda only, all three            |
| `scikit-survival`                                        | scikit-survival skill (`import sksurv`)                                           | conda-forge, all three              |

`pandoc` is not in the union. The current `docx` workflow does not require it.

conda-forge `markitdown` 0.1.8 (noarch) already depends on `requests`,
`pandas`, `lxml`, `openpyxl`, `defusedxml`, `beautifulsoup4`, `python-pptx`,
`pdfplumber`, `pdfminer.six`, and `mammoth`. It does not depend on `openai`,
`python-dotenv`, or `tesseract`.

`python-pptx` and `xlsxwriter` were already present transitively in the old
locks. They are now direct declarations because Office skills rely on them;
`python-docx` is a new direct package.

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

### `phi-r`

The shared R environment serves IRkernel notebooks, scanpy R interoperability,
and the bundled visualization plugin. It contains the packages loaded by the
159 visualization R scripts and Python 3.12 for the plugin's standard-library
scripts; those scripts have no third-party Python import. The visualization
plugin and its agent both reference this environment as `phi:r@1` and declare
no private environment.

| Conda package                                                 | Used by / purpose            | Notes                                                                                                                      |
| ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `python` (3.12)                                               | visualization Python scripts | standard library only                                                                                                      |
| `r-base` (4.4)                                                | every render (`Rscript`)     | includes `grid`, `stats`, `grDevices`, `graphics`, `tools`                                                                 |
| `r-irkernel`                                                  | managed R notebook kernel    | keeps the step 5.3 notebook use case                                                                                       |
| `r-tidyverse`                                                 | general R data work          | existing `phi-r` dependency                                                                                                |
| `bioconductor-singlecellexperiment`, `r-seurat`               | scanpy R interoperability    | `SeuratObject` arrives transitively through Seurat                                                                         |
| `r-readr`                                                     | 154                          |                                                                                                                            |
| `r-ggplot2`                                                   | 146                          |                                                                                                                            |
| `r-ggprism`                                                   | 115                          |                                                                                                                            |
| `r-ggraph`, `r-tidygraph`                                     | 18 each                      |                                                                                                                            |
| `r-ggrepel`                                                   | 14                           |                                                                                                                            |
| `r-patchwork`                                                 | 14                           | 10 plot scripts plus 3 layout compose scripts and `::`                                                                     |
| `r-circlize`                                                  | 12                           |                                                                                                                            |
| `bioconductor-complexheatmap`                                 | 11                           | Bioconductor. bioconda, all three                                                                                          |
| `r-ggforce`, `r-ggpubr`                                       | 9 each                       |                                                                                                                            |
| `r-ggnewscale`, `r-scales`                                    | 6 each                       |                                                                                                                            |
| `r-jsonlite`                                                  | 6                            | helpers and layout compose, not plot templates                                                                             |
| `r-geomtextpath`, `r-gghalves`, `r-ggsignif`, `r-gtable`      | 3 each                       |                                                                                                                            |
| `r-aplot`, `r-ggbeeswarm`, `r-ggh4x`                          | 2 each                       |                                                                                                                            |
| `r-cli`                                                       | 1                            | only the ggideogram compatibility patch                                                                                    |
| `r-ggextra`                                                   | 1                            | import name `ggExtra`                                                                                                      |
| `r-ggridges`, `r-ggtern`, `r-ggvenn`, `r-graphlayouts`        | 1 each                       |                                                                                                                            |
| `r-hexbin`, `r-quantreg`, `r-sf`, `r-survival`, `r-survminer` | 1 each                       |                                                                                                                            |
| `r-waffle`                                                    | removed                      | Removed: `r-extrafont` depends on `r-rttf2pt1`, which has no osx-arm64 build; `scripts/bar/waffle/plot.R` is ggplot2 only. |
| `r-yaml`                                                      | 1                            | `layouts/validate_layouts.R` only                                                                                          |

All of those conda names were found on all three platforms. `r-survival` is
the split-out recommended package; the other base packages in the `::` list
(`grid` 28 files, `stats` 33, `grDevices` 28, `graphics` 10, `tools` 15) ship
inside `r-base`.

These R packages are loaded by scripts and had **no** `r-<lowercase>` (or
bioconda) build on any of the three platforms:

| Package      | Files | Example                                   |
| ------------ | ----- | ----------------------------------------- |
| `gground`    | 7     | `scripts/pie/doughnut_round/plot.R:70`    |
| `ggideogram` | 5     | `scripts/ideogram/karyotype/plot.R:76`    |
| `ggcor`      | 4     | `scripts/heatmap/two_shape/plot.R:73`     |
| `linkET`     | 3     | `scripts/heatmap/shape/plot.R:67`         |
| `ggsankey`   | 2     | `scripts/sankey/basic/plot.R:70`          |
| `ggsvg`      | 2     | `scripts/scatter/svg/plot.R:86`           |
| `ggmagnify`  | 1     | `scripts/scatter/volcano_inset/plot.R:86` |

The merged `phi-r` has nine pinned GitHub `sourcePackages` in dependency order:
its existing `GenomeInfoDbData`, then `gground`, `ggideogram`, `ggcor`,
`linkET`, `ggsankey`, `ggsvg`, `gridGeometry`, and `ggmagnify`.
`gridGeometry` is installed before `ggmagnify`, which imports it; the other
seven visualization packages are direct template dependencies.

The spec also declares the source-package dependency closure explicitly even
when templates do not load a package directly: `r-ade4`, `r-deldir`,
`r-digest`, `r-dplyr`, `r-forcats`, `r-glue`, `r-gridextra`, `r-igraph`,
`r-magrittr`, `r-polyclip`, `r-purrr`, `r-rcolorbrewer`, `r-rlang`, `r-rsvg`,
`r-stringr`, `r-tibble`, `r-tidyr`, `r-vctrs`, and `r-vegan`. The environment
spec remains the canonical declaration; lock files carry their transitive
closure.

The visualization workload does not need LibreOffice, pandoc, poppler, or
tesseract.

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
  conda-forge for all three platforms. The shared `phi-r` inventory above
  includes this kernel alongside the visualization and scanpy dependencies.

### Host dependencies

Declared in environment specs or wrapper profiles (§3.2). Checked, not
installed. Office skills have no host-tool dependency; the remaining entries
belong to workflow execution.

| Executable                   | Where                         | Conda on the three platforms                                                                        |
| ---------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Docker daemon                | wrapper profile `docker`      | conda-forge `docker-cli` exists on all three and does not provide a daemon. Host, per §9 decision 4 |
| `singularity` or `apptainer` | wrapper profile `singularity` | both names exist on linux-64 only. Host, per §9 decision 4                                          |

### Open questions

1. **`docx`.** Resolved on 2026-10-07 with `python-docx` in the shared
   `phi-python` environment. `pptxgenjs` remains distinct: its conda-forge
   package is noarch, depends on `nodejs`, and is available on all three
   platforms.
2. **Visualization R packages without conda builds.** Resolved by pinning the
   seven direct packages in the table plus the `gridGeometry` dependency as
   ordered GitHub `sourcePackages` in `phi-r`. `gridGeometry` precedes
   `ggmagnify`. The compatibility patch in `scripts/lib/common.R` handles the
   ggideogram call removed by ggplot2 4.x, so `r-ggplot2` stays deliberately
   unpinned apart from the explicit lock.
3. **`scvi-tools` in the shared env.** Resolved on 2026-09-29 by removing
   the skill. It pulls PyTorch. It may return later in its own environment.
4. **Scanpy R interop is partially shipped in `phi-r`.**
   `resources/skills/scanpy/references/r_interop.md` tells the agent to
   `Rscript` a conversion that needs `zellkonverter`, `SingleCellExperiment`,
   `Seurat`, and `SeuratObject`. Those four conda names
   (`bioconductor-zellkonverter`, `bioconductor-singlecellexperiment`,
   `r-seurat`, `r-seuratobject`) exist on all three platforms.
   `phi-r` declares `bioconductor-singlecellexperiment` and `r-seurat`
   (`SeuratObject` is transitive), plus pinned `GenomeInfoDbData` needed by
   the Bioconductor stack. `zellkonverter` remains absent because its basilisk
   backend creates Python environments at run time, which is incompatible
   with a read-only prefix. `SeuratDisk` is not declared. No
   `convert_rds_to_h5ad.R` is in the tree.
5. **Tesseract language data** was not checked. The `tesseract` package is
   present; whether `eng.traineddata` is inside it is unverified.
6. **`nf-core` and `nf-test`** are noarch on bioconda and solve on osx-arm64
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

Script-bearing skill directories (67 Python files and 159 R files across the
bundled skill and plugin trees):

| Skill             | Python | R   |
| ----------------- | ------ | --- |
| `docx`            | 1      | 0   |
| `markitdown`      | 5      | 0   |
| `matplotlib`      | 2      | 0   |
| `office-workflow` | 3      | 0   |
| `pdf`             | 2      | 0   |
| `pptx`            | 14     | 0   |
| `rdkit`           | 3      | 0   |
| `scanpy`          | 16     | 0   |
| `scikit-learn`    | 2      | 0   |
| `scvelo`          | 1      | 0   |
| `visualization`   | 6      | 159 |
| `xlsx`            | 12     | 0   |

The other bundled skill directories (`anndata`, `create-wrapper`,
`networkx`, `nextflow`, `phi-office`, `pysam`, `scikit-survival`, `seaborn`,
and `shap`) contain no Python or R scripts. Their documented packages are in
the last section where applicable.

Python import lines, R package lines, and the raw counts:

```text
rg -g '*.py' '^[[:space:]]*(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_\.]*' resources/skills resources/plugins/office/skills resources/plugins/visualization | wc -l
# 359

rg -o -g '*.py' '^[[:space:]]*(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_\.]*' resources/skills resources/plugins/office/skills resources/plugins/visualization | sed -E 's#^[^:]+:##; s/^[[:space:]]*//' | sort -u | wc -l
# 69

rg -g '*.R' 'library[[:space:]]*\([^)]*\)' resources/plugins/visualization | wc -l
# 6

rg -g '*.R' 'require[[:space:]]*\([^)]*\)' resources/plugins/visualization | wc -l
# 0

rg -g '*.R' 'requireNamespace[[:space:]]*\([^)]*\)' resources/plugins/visualization | wc -l
# 2

rg -o -g '*.R' '[A-Za-z][A-Za-z0-9.]*::' resources/plugins/visualization | wc -l
# 1188

rg -g '*.R' 'load_packages[[:space:]]*\(' resources/plugins/visualization | wc -l
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

### `pptx` (14 Python files)

Located at `resources/plugins/office/skills/pptx`. The skill uses managed
`python-pptx` and retains `pptxgenjs` for JavaScript generation. OOXML
utilities import `defusedxml` and `lxml`; image work uses `pillow`, and the
redlining validator calls managed `git`. Structure checks reopen generated
files and can use managed `markitdown` for text extraction. There is no host
executable dependency.

### `xlsx` (12 Python files)

Located at `resources/plugins/office/skills/xlsx`. Python workflows use
`openpyxl`, `python-calamine`, and `xlsxwriter`; OOXML utilities share
`defusedxml`, `lxml`, and managed `git`. `scripts/check_formulas.py` performs
static formula checks with `openpyxl`. Formula caches are deliberately not
generated: spreadsheet applications recalculate on open, while Python sees
an empty cached value until that recalculation has occurred.

### `docx` (1 Python file)

Located at `resources/plugins/office/skills/docx`. Creation, editing, and
readback use `python-docx` (import name `docx`, with `lxml` underneath).
Managed `markitdown` provides an independent text-extraction check, and
`scripts/docx_inspect.py` reports structure without an external converter.

### `pdf` (2 Python files)

Located at `resources/plugins/office/skills/pdf`. The skill explicitly
selects `phi:python@1`. `scripts/pdf_inspect.py` uses `pypdf`, while
`scripts/render_pages.py` uses Poppler from that managed environment. Skill
workflows also use managed `reportlab` and `pdfplumber`; they do not direct
the user or agent to install host packages.

### `office-workflow` (3 Python files)

Located at `resources/plugins/office/skills/office-workflow`. Its helpers
verify the managed runtime, run a project-local script under the selected
environment, and extract Office text with managed Python libraries. They add
no third-party dependency beyond `phi:python@1`.

### `markitdown` (5 Python files)

**Python:**

| Import       | Conda name      | Evidence                                                                                           |
| ------------ | --------------- | -------------------------------------------------------------------------------------------------- |
| `markitdown` | `markitdown`    | `scripts/batch_convert.py:12`, `scripts/convert_literature.py:15`, `scripts/convert_with_ai.py:13` |
| `openai`     | `openai`        | `scripts/convert_with_ai.py:14`                                                                    |
| `requests`   | `requests`      | `scripts/generate_schematic_ai.py:31`                                                              |
| `dotenv`     | `python-dotenv` | `scripts/generate_schematic_ai.py:40`                                                              |

`scripts/generate_schematic.py:112` subprocesses `sys.executable` on the
sibling script. That is not an external tool.

**Documented, not spawned:** SKILL.md lines 455–461, install `tesseract` /
`tesseract-ocr` when OCR fails. conda-forge `tesseract` is on all three
platforms. Language data: unverified.

### `matplotlib` (2 Python files)

| Import       | Conda name   | Evidence                                                          |
| ------------ | ------------ | ----------------------------------------------------------------- |
| `numpy`      | `numpy`      | `scripts/plot_template.py:15`, `scripts/style_configurator.py:16` |
| `matplotlib` | `matplotlib` | `scripts/plot_template.py:16`, `scripts/style_configurator.py:17` |
| `scipy`      | `scipy`      | `scripts/plot_template.py:161` `from scipy.stats import norm`     |

No external commands.

### `rdkit` (3 Python files)

`rdkit` in all three scripts. Example: `scripts/molecular_properties.py:18`
`from rdkit import Chem`. conda-forge `rdkit`, all three. SKILL.md lines
33–37 say to prefer the conda package over a mixed PyPI install. No external
commands.

### `scikit-learn` (2 Python files)

| Import       | Conda name     | Evidence                                                                      |
| ------------ | -------------- | ----------------------------------------------------------------------------- |
| `numpy`      | `numpy`        | `scripts/clustering_analysis.py:5`                                            |
| `pandas`     | `pandas`       | `scripts/clustering_analysis.py:6`                                            |
| `matplotlib` | `matplotlib`   | `scripts/clustering_analysis.py:7`                                            |
| `sklearn`    | `scikit-learn` | `scripts/clustering_analysis.py:8` and `scripts/classification_pipeline.py:8` |

No external commands. SKILL.md lines 24–30 also install `seaborn`. Reference
docs mention optional `category-encoders`, `umap-learn`, and
`imbalanced-learn`; those are example installs, not script imports.
`umap-learn` is a conda-forge dependency of `scanpy` anyway.

### `scanpy` (16 Python files)

**Imported by scripts:**

| Import       | Conda name   | Evidence                                                                                                                                            |
| ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scanpy`     | `scanpy`     | `scripts/_common.py:29`; `assets/analysis_template.py:11`                                                                                           |
| `pandas`     | `pandas`     | `scripts/annotate.py:33`, `scripts/find_markers.py:59`, `scripts/pseudobulk.py:50`, `scripts/run_pipeline.py:165`, `assets/analysis_template.py:12` |
| `numpy`      | `numpy`      | `scripts/inspect_data.py:17`, `assets/analysis_template.py:13`                                                                                      |
| `matplotlib` | `matplotlib` | `assets/analysis_template.py:14`                                                                                                                    |

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

| Package          | Files | Conda name                       | Bioconductor | Example                                                                              |
| ---------------- | ----- | -------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `readr`          | 154   | `r-readr`                        | no           | `scripts/tree/dendrogram/plot.R:76`                                                  |
| `ggplot2`        | 146   | `r-ggplot2`                      | no           | `scripts/tree/dendrogram/plot.R:76`                                                  |
| `ggprism`        | 115   | `r-ggprism`                      | no           | `scripts/tree/dendrogram/plot.R:76`                                                  |
| `stats`          | 33    | in `r-base`                      | no           | `scripts/tree/dendrogram/plot.R:114` `stats::`                                       |
| `grDevices`      | 28    | in `r-base`                      | no           | `scripts/graph/chord/plot.R:151`                                                     |
| `grid`           | 28    | in `r-base`                      | no           | `scripts/ideogram/circos/plot.R:112` (also passed to `load_packages` in 8 files)     |
| `ggraph`         | 18    | `r-ggraph`                       | no           | `scripts/tree/dendrogram/plot.R:76`                                                  |
| `tidygraph`      | 18    | `r-tidygraph`                    | no           | `scripts/tree/dendrogram/plot.R:76`                                                  |
| `tools`          | 15    | in `r-base`                      | no           | `scripts/graph/chord/plot.R:173` `tools::`                                           |
| `ggrepel`        | 14    | `r-ggrepel`                      | no           | `scripts/tree/enrichment_ring/plot.R:91`                                             |
| `patchwork`      | 14    | `r-patchwork`                    | no           | `scripts/tree/enrichment_ring/plot.R:91`; layouts via `load_layout_packages()`       |
| `circlize`       | 12    | `r-circlize`                     | no           | `scripts/graph/chord/plot.R:78`                                                      |
| `ComplexHeatmap` | 11    | `bioconductor-complexheatmap`    | yes          | `scripts/ideogram/circos/plot.R:112`                                                 |
| `graphics`       | 10    | in `r-base`                      | no           | `scripts/graph/chord/plot.R:193`                                                     |
| `ggforce`        | 9     | `r-ggforce`                      | no           | `scripts/sankey/parallel_sets/plot.R:75`                                             |
| `ggpubr`         | 9     | `r-ggpubr`                       | no           | `scripts/boxplot/differential_facet/plot.R:73`                                       |
| `gground`        | 7     | none found                       | no           | `scripts/pie/doughnut_round/plot.R:70`                                               |
| `ggnewscale`     | 6     | `r-ggnewscale`                   | no           | `scripts/boxplot/polar_heatmap/plot.R:74`                                            |
| `jsonlite`       | 6     | `r-jsonlite`                     | no           | `scripts/lib/common.R:157` `requireNamespace("jsonlite")`                            |
| `scales`         | 6     | `r-scales`                       | no           | `scripts/scatter/ternary/plot.R:84`                                                  |
| `ggideogram`     | 5     | none found                       | no           | `scripts/ideogram/karyotype/plot.R:76`; also `requireNamespace` at `common.R:250`    |
| `ggcor`          | 4     | none found                       | no           | `scripts/heatmap/two_shape/plot.R:73`                                                |
| `geomtextpath`   | 3     | `r-geomtextpath`                 | no           | `scripts/boxplot/polar/plot.R:69`                                                    |
| `gghalves`       | 3     | `r-gghalves`                     | no           | `scripts/boxplot/raincloud/plot.R:69`                                                |
| `ggsignif`       | 3     | `r-ggsignif`                     | no           | `scripts/boxplot/differential_expression/plot.R:71`                                  |
| `gtable`         | 3     | `r-gtable`                       | no           | `scripts/ideogram/coverage/plot.R:97`                                                |
| `linkET`         | 3     | none found (`r-linket` searched) | no           | `scripts/heatmap/shape/plot.R:67`                                                    |
| `aplot`          | 2     | `r-aplot`                        | no           | `scripts/heatmap/mutation_energy/plot.R:77`                                          |
| `ggbeeswarm`     | 2     | `r-ggbeeswarm`                   | no           | `scripts/scatter/beeswarm_group/plot.R:77`                                           |
| `ggh4x`          | 2     | `r-ggh4x`                        | no           | `scripts/ideogram/coverage/plot.R:97`                                                |
| `ggsankey`       | 2     | none found                       | no           | `scripts/sankey/basic/plot.R:70`                                                     |
| `ggsvg`          | 2     | none found                       | no           | `scripts/scatter/svg/plot.R:86`                                                      |
| `cli`            | 1     | `r-cli`                          | no           | `scripts/lib/common.R:260` `cli::cli_warning`                                        |
| `ggExtra`        | 1     | `r-ggextra`                      | no           | `scripts/scatter/marginal/plot.R:71`                                                 |
| `ggmagnify`      | 1     | none found                       | no           | `scripts/scatter/volcano_inset/plot.R:86`                                            |
| `ggridges`       | 1     | `r-ggridges`                     | no           | `scripts/line/ridge/plot.R:81`                                                       |
| `ggtern`         | 1     | `r-ggtern`                       | no           | `scripts/scatter/ternary/plot.R:84`                                                  |
| `ggvenn`         | 1     | `r-ggvenn`                       | no           | `scripts/bar/venn/plot.R:80`                                                         |
| `graphlayouts`   | 1     | `r-graphlayouts`                 | no           | `scripts/graph/stress/plot.R:80`                                                     |
| `hexbin`         | 1     | `r-hexbin`                       | no           | `scripts/scatter/hex/plot.R:70`                                                      |
| `quantreg`       | 1     | `r-quantreg`                     | no           | `scripts/boxplot/raincloud_differential/plot.R:74`                                   |
| `sf`             | 1     | `r-sf`                           | no           | `scripts/heatmap/corr_rotate/plot.R:112`                                             |
| `survival`       | 1     | `r-survival`                     | no           | `scripts/line/survival/plot.R:73`                                                    |
| `survminer`      | 1     | `r-survminer`                    | no           | `scripts/line/survival/plot.R:73`                                                    |
| `waffle`         | 1     | `r-waffle`                       | no           | `scripts/bar/waffle/plot.R:73`                                                       |
| `yaml`           | 1     | `r-yaml`                         | no           | `scripts/layouts/validate_layouts.R:8` `library(yaml)`; `yaml::read_yaml` at line 28 |

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

## Visualization plugin runtime

### `resources/plugins/visualization/skills/omics-visualization/scripts/`

The declared script tools start `python ./scripts/viz.py <subcommand>` in
`phi:r@1`. The CLI launches two programs from the same managed prefix:

| Command          | Calls                                | Evidence                    |
| ---------------- | ------------------------------------ | --------------------------- |
| `sys.executable` | `scripts/route_template.py`          | `viz.py` `command_route()`  |
| `Rscript`        | the selected `plot.R` or `compose.R` | `viz.py` `command_render()` |
| `sys.executable` | `scripts/qa_single_plot.py`          | `viz.py` `command_render()` |

The Python programs use only the standard library. `python` and `Rscript`
both come from the `phi-r` prefix; execution does not fall back to host
interpreters. The CLI fails closed if either executable is unavailable.

## Engine components

### `src/main/agent/notebook/`

| Executable            | How                                                                | Evidence                                                                                                                                  | Conda                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jupyter`             | `jupyter server ...`                                               | `analysis-jupyter-server.ts:98` `spawn('jupyter', jupyterServerArgs(...))`; args at lines 83–94 (`server`, `--no-browser`, `ServerApp.*`) | `jupyter_server` (depends on `jupyter_core`), all three                                                                                                  |
| `jupyter`             | `jupyter server --version`                                         | `analysis-kernels.ts:127`                                                                                                                 | same                                                                                                                                                     |
| `jupyter`             | `jupyter kernelspec list --json`                                   | `analysis-kernels.ts:145`                                                                                                                 | same. Looks for a kernel named `python3`, then any Python kernel, then any R kernel (lines 110–115, 151–158). Does not install `ipykernel` or `irkernel` |
| `ruff`                | `ruff format ...`                                                  | `analysis-notebook-formatting.ts:102`                                                                                                     | conda-forge `ruff`, all three. Optional: the formatter walks on to black                                                                                 |
| `python`              | `python -m black`                                                  | `analysis-notebook-formatting.ts:107`                                                                                                     | conda-forge `black`, all three. Optional                                                                                                                 |
| `python3`             | `python3 -m black`                                                 | `analysis-notebook-formatting.ts:112`                                                                                                     | same                                                                                                                                                     |
| `python` or `python3` | project `.venv` first, then those names, to list installed modules | `analysis-python-packages.ts:88`                                                                                                          | the analysis env's interpreter, not a notebook-only package                                                                                              |

The notebook never spawns `Rscript`. An R kernel is detected if a host
kernelspec advertises language `r`. Step 5.3 moves the server into
`phi-jupyter` and the default kernels into `phi-python` (`ipykernel`) and
`phi-r` (`r-irkernel`).

### `src/main/agent/wrappers/composition/executor.ts`

| Executable          | Role                                                                                                                                                                                     | Evidence                                                                                 | Conda                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `nextflow`          | the process that is spawned                                                                                                                                                              | `executor.ts:185` `findNextflowBinary()`, `executor.ts:217` `spawn(nextflowBin, args)`   | bioconda `nextflow`, noarch, all three. Depends on `openjdk >=17,<26`, `coreutils`, `curl`     |
| `java`              | not spawned by Phi. Nextflow's JVM is why the process group is killed                                                                                                                    | `executor.ts:133`                                                                        | conda-forge `openjdk`, all three. Pulled in by `nextflow`                                      |
| `which`             | `which nextflow`                                                                                                                                                                         | `executor.ts:60`                                                                         | system `/usr/bin/which`, not a conda package                                                   |
| `conda` or `mamba`  | not spawned here. If the chosen `nextflow` binary lives in `.../envs/<name>/bin`, the executor prepends that install's `condabin` and `bin` so Nextflow's `-profile conda` can find them | `executor.ts:71`–76, `executor.ts:196`–199                                               | today this is the user's conda. Step 5.2 points `-profile conda` at bundled micromamba instead |
| Docker, Singularity | not spawned here. The profile is an argument                                                                                                                                             | `executor.ts:11` profiles `docker`, `singularity`, `conda`; `executor.ts:208` `-profile` | host daemons / binaries. See summary                                                           |

Lookup order for Nextflow (`executor.ts:53`–67): `NEXTFLOW_BIN`, then
`~/.phi/environment.json` via `getActiveToolPath('nextflow')`, then
`which nextflow`, then `nextflow` under `~/miniconda3|anaconda3|miniforge3/envs/*/bin`.

## Skills with no bundled scripts

Primary packages only. Optional extras in references are not in the
`phi-python` union except where the summary says they ride in via `scanpy`
or `markitdown`.

| Skill                                         | Evidence                                                                              | Conda name                          | Platforms                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------- |
| `anndata`                                     | `SKILL.md:32` `uv pip install "anndata==0.12.16"`                                     | `anndata`                           | all three (conda-forge and bioconda)  |
| `networkx`                                    | `SKILL.md:266` commented `uv pip install networkx`                                    | `networkx`                          | all three                             |
| `seaborn`                                     | `SKILL.md:6` and line 22, `seaborn==0.13.2`                                           | `seaborn`                           | all three                             |
| `shap`                                        | `SKILL.md:542` `uv pip install shap`                                                  | `shap`                              | all three                             |
| `pysam`                                       | `SKILL.md:30` `uv pip install pysam`                                                  | `pysam`                             | all three, bioconda only              |
| `scikit-survival`                             | examples `from sksurv...` (`SKILL.md:90`). No install line                            | `scikit-survival` (import `sksurv`) | all three                             |
| `nextflow`                                    | `SKILL.md:48` `pip install nf-core` or `conda install -c bioconda nf-core`            | `nf-core`, `nf-test`                | all three. Proposed in `phi-nextflow` |
| `create-database-connector`, `create-wrapper` | authoring docs for this repository (`node`, `npm`, `git`). Not skill runtime packages | —                                   | —                                     |

`create-wrapper` also documents host `nextflow`, Java 17+, and a Docker
daemon (`SKILL.md` around lines 196–200). That matches the executor, not a
second runtime.
