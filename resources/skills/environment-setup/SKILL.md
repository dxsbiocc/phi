---
name: environment-setup
description: Built-in Phi environment troubleshooting and guided remediation playbook. Use when a user asks to fix, set up, or diagnose Phi runtime environments (Windows WSL2, Nextflow, R, Python, plugin environments, or remote Linux/HPC execution), or when a workflow fails with an environment/WSL2/profile blocker.
metadata: {"version": "1.0"}
---

# Phi Environment Setup & Guided Remediation

Your goal is to **solve environment blockers for the user through Phi's controlled tools** instead of handing non-technical researchers long manual command-line instructions.

## Core Principles

1. **Diagnose first, never guess.** Always call the read-only `env_diagnose` tool before recommending any action so you act on real OS, WSL2, managed-environment, and saved remote-host state.
2. **Automate everything Phi can safely do.** Prefer Phi's controlled tools (`env_build`, `env_request`, `env_setup_wsl`, or switching execution parameters) over asking the user to open a terminal.
3. **Never touch the host via `bash`.** Never run `conda`, `pip`, `micromamba`, `wsl --install`, or shell-profile edits through `bash`. All system changes must go through Phi's confirmation-gated built-in tools.
4. **Always respect "no WSL2" preference.** If a Windows user does not want to install WSL2, immediately offer the remote Linux / Slurm execution path (using already-configured SSH hosts first, or guiding them to Settings -> Remote Hosts).

## Decision Tree

### 1. Missing Python or R packages inside a project
- Use `env_request` to extend the active environment into a project-scoped override. The user only clicks confirm.

### 2. Managed environment is `absent`, `failed`, or `drifted`
- Examples: `phi:python@1`, `phi:r@1`, `phi:nextflow@1`, `plugin:viz`, `plugin:seurat`, `plugin:scanpy`.
- On Windows, note that `phi:python@1`, `phi:jupyter@1`, and `phi:r@1` all run **natively** without WSL2.
- Call `env_build` with the target `ref` (and `reason`). Phi handles the in-chat confirmation card and background build progress automatically.

### 3. Windows Nextflow container profile error (`docker` / `singularity`)
- Local Windows Nextflow runs inside WSL2 and only supports the `conda` profile.
- Check `env_diagnose(topic="nextflow", profile=...)`:
  - If a remote Linux / HPC host is already configured (`remoteHosts` non-empty), ask the user whether to run on that remote host (`target="remote"`) or switch locally to `profile="conda"`.
  - Otherwise, if WSL2 is `ready`, switch to `profile="conda"` (building `phi:nextflow@1` via `env_build` first if needed) and retry the wrapper.

### 4. Windows WSL2 is missing, has no Linux distro, or is WSL 1
- Present two simple choices clearly (one sentence each):
  - **Option A — Let Phi set up WSL2 automatically**: If the user agrees, call `env_setup_wsl` with the exact action matching `env_diagnose`:
    - `wsl.status === "missing"` -> `action: "install_wsl"`
    - `wsl.status === "no-distro"` -> `action: "install_ubuntu"`
    - `wsl.status === "not-version-2"` -> `action: "upgrade_to_wsl2"` (with `distro`)
    - Tell the user they only need to click **Allow** on the Phi confirmation card and the Windows UAC prompt. If `env_setup_wsl` reports `needs_reboot_or_init`, tell them concisely to restart Windows (if first-time WSL install) and open Ubuntu once, then come back and say "继续".
  - **Option B — Skip WSL2 and use a remote Linux / HPC server**: If `remoteHosts` already has entries, name them and offer to run remotely; otherwise point them to **Settings -> Remote Hosts** to add an SSH / Slurm server.

### 5. After remediation succeeds
- Once `env_build`, `env_request`, or `env_setup_wsl` returns ready/completed, immediately resume the user's original scientific task without asking them to repeat their request.
