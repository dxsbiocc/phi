# G4 packaged-app acceptance driver

Drives a packaged Phi build over Chrome DevTools Protocol and runs the G4 user checklist.
Every run clones a HOME and an Electron user-data directory into its own run folder, so
the real `~/.phi` and app data are never touched. Evidence (results, summary, screenshots,
console log) lands in `.phi-acceptance/g4-runs/<timestamp>/`, which git ignores.

## Steps

| ID | Where | What it checks |
| --- | --- | --- |
| F1–F4 | local | Three turns, fork from the second message, fork keeps two turns, source stays whole |
| F6 | local | Forking while the source is still answering is refused with a notice |
| M1 | local | A subagent reads the run's README and returns its marker |
| M2 | local | Manual context compaction, then the conversation continues |
| M3 | local | Switching model while a reply streams, then a further reply |
| F5 | remote | A remote conversation forks from a message and keeps the source message |
| M4 | remote | The remote conversation answers |
| M5 | remote | A remote subagent runs and the conversation answers without errors |

## Running

```bash
G4_SOURCE_HOME=/path/to/home-copy \
G4_SOURCE_USERDATA=/path/to/userdata-copy \
G4_APP=/path/to/Phi.app/Contents/MacOS/Phi \
G4_APPROVE=1 \
bun scripts/acceptance/g4/run.mjs [--remote-only | --local-only | --dry-run]
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `G4_SOURCE_HOME` | HOME to clone (must contain `.phi`; a `.ssh` symlink is kept as a link) | required |
| `G4_SOURCE_USERDATA` | Electron user-data directory to clone | required |
| `G4_APP` | Packaged executable | `dist/mac-arm64/Phi.app/Contents/MacOS/Phi` |
| `G4_MODEL` | Default model: a display name (first match from a configured provider) or `provider/id` | the data copy's own default |
| `G4_REMOTE_HOST` / `G4_REMOTE_PROJECT` | SSH host alias and project name used by F5, M4, M5 | `GPU` / `software` |
| `G4_APPROVE` | `1` answers every tool approval with 批准 | off |
| `G4_SUBAGENT_PROMPT` | Replaces the remote M5 prompt | lists the project root |
| `G4_MODEL_TIMEOUT_MS` / `G4_STEP_TIMEOUT_MS` | Per-reply and per-step limits | 4 min / 13 min |
| `G4_ENGINE` | Passed as `PHI_KERNEL_ENGINE` | app default |
| `G4_RUNS_ROOT` | Where run folders go | `.phi-acceptance/g4-runs` |

A run sends at most 20 prompts; one prompt can make several model requests (subagents,
retries), so count requests against any budget, not prompts. A remote run uploads the
kernel runtime (about 250 MB) the first time a new build reaches a server.

`--dry-run` sends nothing and only checks that the home screen and composer selectors exist.
