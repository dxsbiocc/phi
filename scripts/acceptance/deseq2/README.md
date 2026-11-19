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

## Desktop acceptance

Build the current Phi checkout with `node_modules/.bin/electron-vite build`. Use the same
`PHI_PACKAGES_ROOT` and `NEXTFLOW_BIN` as the native run above. The desktop scenarios use a
fresh local Phi profile, the installed domain plugin, native R and a temporary project. A
working graphical desktop, local Python and the executables used by the wrapper's environment
check are required. No research data or provider credentials are copied from your usual profile.

For a real model run with Phi’s Moonshot provider, use the dedicated API mode on a computer
already configured for `moonshot/kimi-k3`. This sends the synthetic case’s model context to
the Moonshot China API. All plugin tools, Nextflow and DESeq2 run locally. The fresh profile
uses only the Moonshot credential for the run and releases it at shutdown.

```sh
PHI_DESKTOP_DRIVER=moonshot \
node --import ./scripts/test-loader.mjs scripts/acceptance/deseq2/desktop.mjs
```

An existing on-device OpenAI-compatible endpoint can also be selected explicitly with
`PHI_DESKTOP_DRIVER=model`, `PHI_DESKTOP_MODEL_URL` (HTTP on 127.0.0.1),
`PHI_DESKTOP_MODEL` and `PHI_DESKTOP_CONTEXT`.

For a repeatable check of the GUI, desktop runtime and scientific tools, choose the
deterministic local model fixture. Its decisions use the tool responses from the running app.
It exercises a prescribed conversation. Use the real-model run to evaluate autonomous choices.

```sh
PHI_DESKTOP_DRIVER=regression \
node --import ./scripts/test-loader.mjs scripts/acceptance/deseq2/desktop.mjs
```

Each invocation opens real project conversations and types the research question. For the
incomplete paired design the driver waits for both choices, observes that no wrapper was
launched, then submits the corrected mapping through the question card. The other session
starts with a complete paired design. The gate checks the result certificate, local job
record, plugin calls, final visible answer and retained chat events for each session.
Expected outcomes are 50 of 1,400 qualifying genes and one enrichment call for the first
case, and zero of 1,400 with an explanation and zero enrichment calls for the second.

Add `paired` or `zero` as a final argument to run one case. The runner prints the report and
screenshot directory. Set `PHI_DESKTOP_EVIDENCE` to a fresh directory to retain the evidence
elsewhere. Full workflow tables and logs stay in the isolated project and job directories.

Set `PHI_DESKTOP_LAYOUT=1` with the regression driver to also check the running parent conversation,
completed specialist cards and workspace tabs in the native Electron window. Include the paired
case to exercise the question card. The layout report includes window widths, tab and toolbar
bounds, button hit tests and screenshots. Each conversation is checked against its session ID.
A data leak marks its case failed while the driver continues observing the other scientific
decisions. Reports identify the leaking event and tool and omit raw rows.
