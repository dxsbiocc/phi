# phi-r

Shared R 4.4 environment for R notebooks and scanpy's R interop. Notebooks use IRkernel from this prefix as the `phi-r` kernel; Phi writes its kernelspec with `<prefix>/bin/R` and this environment's `environmentVariables`.

Only `r-base=4.4` is pinned in `environment.yml`. The lock files pin every other package.

Channels are `conda-forge`, then `bioconda`. `bioconductor-*` packages come from bioconda. Every other package comes from conda-forge.

## Packages

| Use               | Packages                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| notebooks         | `r-base=4.4`, `r-irkernel`                                              |
| general data work | `r-tidyverse`                                                           |
| scanpy R interop  | `bioconductor-singlecellexperiment`, `r-seurat` (with `r-seuratobject`) |
| source packages   | `GenomeInfoDbData` (see below)                                          |

### scanpy R interop without zellkonverter

`resources/skills/scanpy/references/r_interop.md` converts with `zellkonverter`. It is not installed: zellkonverter reads and writes `.h5ad` through basilisk, which creates its own Python environments at run time. An environment prefix is read-only after it is built, so that would fail (or write outside Phi's control). Use `SingleCellExperiment` and `Seurat` here, and do the `.h5ad` side in `phi-python`.

### GenomeInfoDbData

`SingleCellExperiment` loads `GenomeInfoDb`, which needs the data package `GenomeInfoDbData`. The bioconda package `bioconductor-genomeinfodbdata` contains no data: its post-link script downloads the tarball from Bioconductor at install time, which fails in a Phi build (the script cannot find `yq`, and it would fetch an unlocked file anyway). The package is therefore installed as a pinned `sourcePackages` entry from the Bioconductor GitHub mirror (version 1.2.15, commit `b5339e0`). The conda package stays in the lock as a dependency of `bioconductor-genomeinfodb`.

## Locks

Solved on 2026-10-01 against the lock baselines: macOS arm64 11.0, macOS x64 10.15, and linux glibc 2.17 / linux 4.18.

Regenerate all three platform locks:

```bash
npm run runtime:lock -- --spec resources/runtime/environments/phi-r/environment.yml
```

That writes `locks/darwin-arm64.txt`, `locks/darwin-x64.txt`, and `locks/linux-x64.txt` next to `environment.yml`.

## Known platform differences

With the macOS 10.15 baseline, `darwin-x64` resolves `r-seurat` 5.4.0 and `r-seuratobject` 5.3.0; `darwin-arm64` and `linux-x64` get 5.5.1 and 5.4.0. `r-base` is 4.4.3 on all three.
