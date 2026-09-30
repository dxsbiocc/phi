# viz

R 4.4 and Python 3.12 for the omics-visualization templates. The three Python scripts use the standard library only. Plots run under `Rscript`.

No host executables. LibreOffice, pandoc, poppler, and tesseract are not part of this environment.

Only `python=3.12` and `r-base=4.4` are pinned. `r-ggplot2` is intentionally unpinned: `scripts/lib/common.R` patches ggideogram 0.1.0 for ggplot2 4.x.

Channels are `conda-forge`, then `bioconda`. `bioconductor-complexheatmap` is the only bioconda package.

## Template packages

Counts are R files out of 159, from the dependency inventory. `python` is the three standard-library scripts. `r-base` supplies `Rscript` plus `grid`, `stats`, `grDevices`, `graphics`, and `tools`.

| Package | Files |
| --- | --- |
| `r-readr` | 154 |
| `r-ggplot2` | 146 |
| `r-ggprism` | 115 |
| `r-ggraph` | 18 |
| `r-tidygraph` | 18 |
| `r-ggrepel` | 14 |
| `r-patchwork` | 14 |
| `r-circlize` | 12 |
| `bioconductor-complexheatmap` | 11 |
| `r-ggforce` | 9 |
| `r-ggpubr` | 9 |
| `r-ggnewscale` | 6 |
| `r-scales` | 6 |
| `r-jsonlite` | 6 |
| `r-geomtextpath` | 3 |
| `r-gghalves` | 3 |
| `r-ggsignif` | 3 |
| `r-gtable` | 3 |
| `r-aplot` | 2 |
| `r-ggbeeswarm` | 2 |
| `r-ggh4x` | 2 |
| `r-cli` | 1 |
| `r-ggextra` | 1 |
| `r-ggridges` | 1 |
| `r-ggtern` | 1 |
| `r-ggvenn` | 1 |
| `r-graphlayouts` | 1 |
| `r-hexbin` | 1 |
| `r-quantreg` | 1 |
| `r-sf` | 1 |
| `r-survival` | 1 |
| `r-survminer` | 1 |
| `r-yaml` | 1 |

`r-ggextra` is imported as `ggExtra`. `bioconductor-complexheatmap` is imported as `ComplexHeatmap`. `r-deldir` is not loaded by a template; `ggforce` voronoi stats call `check_installed("deldir")`.

## Source packages

None of the seven template packages are on CRAN (the CRAN `PACKAGES` index on 2026-09-30 has `ggrounded` and `ggsankeyfier`, which are different packages). Archives were downloaded with the installer URL `https://codeload.github.com/<repo>/tar.gz/<sha>` and hashed as those bytes.

| Package | Repo | Ref | Why this repo |
| --- | --- | --- | --- |
| `gground` | `dxsbiocc/gground` | `524dc93dfb34cfd267a6a829ce796c1a8aa694f7` | Not on CRAN. `Junjunlab/gground` 404s. This repo exports `geom_round_col`, `geom_round_rect`, and `geom_round_boxplot`. |
| `ggideogram` | `dxsbiocc/ggideogram` | `57867ec3a570e5091fdbeb194c1e02bf519cf9b3` | Not on CRAN. The plot headers name this repo. Version 0.1.0 matches the ggplot2 4.x patch in `common.R`. |
| `ggcor` | `yoyobattle/ggcor` | `0d60364b873e2c871e8da9641e103203c2eed2f1` | Not on CRAN. `houyunhuang/ggcor` 404s (account closed). This fork is that package at 0.9.5 and still exports `quickcor`, `as_cor_tbl`, `geom_star`, `geom_ring`, `geom_square`, `geom_circle2`, `geom_cross`, `geom_shade`, `geom_diag_label`, `geom_mark`, and `get_data`. `Hy4m/ggcor` is a rewrite (`qcorrplot`, `ggplot2 >= 4`) and does not. |
| `linkET` | `Hy4m/linkET` | `fa26a874b59cffad730f8fadc860d3750f59c37b` | Not on CRAN (`r-linket` is not a conda package either). Exports `geom_couple`, `geom_shaping`, and `as_md_tbl`. |
| `ggsankey` | `davidsjoberg/ggsankey` | `b675d0d5144b1b5758d3b2b41e86ceee66a1e071` | Not on CRAN. Templates call `geom_sankey` and `geom_sankey_text`. CRAN `ggsankeyfier` is a different API. |
| `ggsvg` | `coolbutuseless/ggsvg` | `340fd565fa9d6d832f44e8a07dc5ceed04cec5c5` | Not on CRAN. Exports `geom_point_svg`, `scale_svg_fill_manual`, `css`, and `svg_to_rasterGrob`. |
| `ggmagnify` | `hughjonesd/ggmagnify` | `c5da7ddec923f1c717c4fe2e2f730a0528bdf9bf` | Not on CRAN (the install docs point at r-universe, which tracks this repo). Exports `geom_magnify`. Version 0.4.2. |

`ggmagnify` Imports `gridGeometry`, which has no conda package on conda-forge or bioconda. CRAN's current release is `0.4-0`, but `packageVersion()` prints that as `0.4.0` while the archive name is `gridGeometry_0.4-0.tar.gz`, so a `source: cran` ref cannot satisfy both the installer URL and the version check. It is installed from the upstream repo named in that DESCRIPTION, `pmur002/gridgeometry`, at `70486784531119c4ee93aa90b94c1a47a21a9c92` (version 0.4-1, still exports `polyclipGrob`). It is ordered immediately before `ggmagnify`. The other source packages do not depend on each other.

## Conda packages added for those Imports / Depends

Not loaded by a template. `grid`, `grDevices`, `stats`, `utils`, and `graphics` come from `r-base`.

| Package | Needed by |
| --- | --- |
| `r-ade4` | ggcor |
| `r-digest` | ggcor, linkET |
| `r-dplyr` | ggideogram, ggcor, linkET, ggsankey |
| `r-forcats` | ggsankey |
| `r-glue` | linkET, ggsvg |
| `r-gridextra` | ggmagnify |
| `r-igraph` | ggcor |
| `r-magrittr` | ggideogram, linkET, ggsankey |
| `r-polyclip` | gridGeometry |
| `r-purrr` | ggcor, linkET, ggsankey |
| `r-rcolorbrewer` | ggcor |
| `r-rlang` | gground, ggideogram, linkET, ggsvg, ggmagnify |
| `r-rsvg` | ggsvg |
| `r-stringr` | ggsankey, ggsvg |
| `r-tibble` | ggcor, linkET |
| `r-tidyr` | ggsankey |
| `r-vctrs` | gground |
| `r-vegan` | ggcor |

`r-cli`, `r-ggforce`, `r-gtable`, `r-scales`, and `r-tidygraph` are already in the template table and also satisfy source-package imports.

## Locks

Solved on 2026-09-30 with micromamba 2.9.0. All three platforms solve. `r-waffle` is not in the spec: it depends on `r-extrafont`, which depends on `r-rttf2pt1`, and conda-forge has no `osx-arm64` build of `r-rttf2pt1`. `scripts/bar/waffle/plot.R` draws that chart with ggplot2.

| Platform | Packages | Download bytes | lockSha256 (12) |
| --- | --- | --- | --- |
| `darwin-arm64` | 382 | 575285898 | `5847f8f5ffa3` |
| `darwin-x64` | 383 | 512655528 | `179c2180230b` |
| `linux-x64` | 383 | 643327697 | `ca7a89ba9d0f` |

Regenerate all three platform locks:

```bash
npm run runtime:lock -- --spec resources/plugins/visualization/environments/viz/environment.yml
```

That writes `locks/darwin-arm64.txt`, `locks/darwin-x64.txt`, and `locks/linux-x64.txt` next to `environment.yml`, including `download-bytes`.

## Smoke

```bash
npm run runtime:smoke:viz
```

Builds `viz` for the current platform with `ensureEnvironment` (runtime root `PHI_TEST_RUNTIME_ROOT`, otherwise a temp directory) and renders every template under `resources/skills/omics-visualization/scripts` that has a `plot.R` example. Ran on `darwin-arm64` on 2026-09-30: 154 ok, 0 failed. Build 54.4s, render 232.7s.
