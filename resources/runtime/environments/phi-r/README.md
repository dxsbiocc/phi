# phi-r

Lightweight shared R 4.4 base environment for the default `phi-r` Notebook kernel and general statistical/tidyverse workflows.

Only `r-base=4.4` is pinned in `environment.yml`. Every package comes from `conda-forge` with zero `bioconda` or compiled `sourcePackages` requirements.

Domain-specific R stacks live in their own plugin environments:
- **Scientific template plotting (`visualization`)**: `plugin:viz` (`resources/plugins/visualization/environments/viz/` in `phi-packages`).
- **Single-cell Seurat (`single-cell`)**: `plugin:seurat`.
- **Chromatin profiling (`chromatin-profiling`)**: `plugin:chip`.

## Packages

| Use               | Packages                                                                          |
| ----------------- | --------------------------------------------------------------------------------- |
| R notebook kernel | `r-base=4.4`, `r-irkernel`                                                        |
| tidy data & plots | `r-tidyverse`, `r-patchwork`, `r-ggrepel`, `r-scales`, `r-rcolorbrewer`           |
| serialization     | `r-jsonlite`, `r-yaml`                                                            |

## Locks

Solved against the official lock baselines: macOS arm64 11.0, macOS x64 10.15, linux glibc 2.17 / linux 4.18, and Windows 10 (`win32-x64`).

Regenerate the Unix lock platforms:

```bash
bun run runtime:lock -- --spec resources/runtime/environments/phi-r/environment.yml
```

Regenerate the Windows lock:

```bash
bun run runtime:lock -- --spec resources/runtime/environments/phi-r/environment.yml --platform win32-x64
```
