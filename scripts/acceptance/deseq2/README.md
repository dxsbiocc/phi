# Local DESeq2 acceptance

Run from the Phi checkout with its Node dependencies installed. Set `PHI_PACKAGES_ROOT` to the matching Phi-packages checkout and `NEXTFLOW_BIN` to an absolute path to a working Nextflow 25.04 or newer. Both repositories must include the DESeq2 QC changes. Use a local machine with enough free space for the run artifacts.

The native run requires Python 3 on `PATH` as `python3`, and an `Rscript` installation with DESeq2, BiocParallel, limma and ashr. It binds a temporary Phi skill environment to the real Python interpreter and disables containers for the installed workflow. BiocParallel needs permission to open a local port.

```sh
export PHI_PACKAGES_ROOT=/absolute/path/to/phi-packages
export NEXTFLOW_BIN=/absolute/path/to/nextflow
PHI_QC_NATIVE=1 node --import ./scripts/test-loader.mjs scripts/acceptance/deseq2/run.mjs
```

To use the wrapper's Docker profile, set `PHI_QC_RUNTIME_ROOT` to a Phi runtime that already contains the current platform's ready `phi:python@1` environment. Leave `PHI_QC_NATIVE` unset. This mode also requires a working Docker daemon, the adapter's declared DESeq2 image available locally and host `Rscript` to generate the fixtures.

The script installs the wrapper and domain plugin in a fresh temporary directory, generates 1,400 synthetic genes across twelve samples, and dispatches the registered tools. It checks 50 hits and one enrichment output for paired counts, zero hits with enrichment skipped, and a result corrupted after successful process exit. It also exercises the data-design question through the real question tool before wrapper launch and verifies that the wrapper itself asks for a mapping if invoked directly. The test supplies the approved scope and captures the question at the interaction boundary. Each run prints the absolute path to its `acceptance.json`, with the job records, local outputs and logs in the same temporary workspace.
