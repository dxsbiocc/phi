# Public biological database URL fetch evaluation

Compares plain URL reading (the runtime `read` tool) on 14 structured biological-database lookups. Each arm runs as an isolated in-memory agent session with only `read`:

- `fetch` — URL `read` only
- `fetch-hints` — URL `read` plus a short list of public API base URLs

Each run appends one JSONL record (tokens, model calls, tool calls, wall time, final answer) for offline scoring. The 2026-09-29 results are in `docs/design/phi-content-distribution-design.md` Appendix A.

## Prerequisites

- `bun`
- A model provider configured in the selected `PI_CODING_AGENT_DIR`
- Network access to the public database APIs the tasks query

`cursor/*` models also need Phi's Cursor HTTP/2 bridge. Bun cannot speak that TLS leg, so start the bridge under Node and leave it running. It prints `http://127.0.0.1:PORT`.

## Run

```
node --import ./scripts/test-loader.mjs scripts/eval/cursor-bridge.mjs   # prints http://127.0.0.1:PORT, keep running
bun run eval:fetch -- --model cursor/<model> --base-url http://127.0.0.1:PORT --out eval-results/fetch.jsonl
python3 scripts/eval/db-vs-fetch-score.py eval-results/fetch.jsonl --detail
```

Other providers do not need the bridge. The default model is `moonshot/kimi-k2.6` and the default output is `eval-results/db-vs-fetch.jsonl` (created if missing, gitignored):

```
bun run eval:fetch
python3 scripts/eval/db-vs-fetch-score.py eval-results/db-vs-fetch.jsonl --detail
```

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--model` | `moonshot/kimi-k2.6` | `provider/model` from the Phi registry |
| `--base-url` | model default | Override the model base URL. Required for `cursor/*` (the bridge URL) |
| `--out` | `eval-results/db-vs-fetch.jsonl` | JSONL path. Records are appended |
| `--arms` | `fetch,fetch-hints` | Comma-separated arms |
| `--tasks` | all (`T01`–`T14`) | Comma-separated task ids |
| `--reps` | `1` | Repetitions of each task × arm |
| `--concurrency` | `4` | Parallel sessions |
| `--timeout` | `240` | Per-run timeout, in seconds |

## Scoring

`db-vs-fetch-score.py <results.jsonl> [--detail]` reads the JSONL and the `expect` lists in `db-vs-fetch-tasks.ts`. A run is correct when it did not error and every expected fact appears in the final answer. Matching ignores case, whitespace, commas, and underscores, treats `X-ray diffraction` as `X-ray`, and falls back to a hyphen-insensitive compare.

The table is one row per arm: runs, correct count, mean model calls, mean tool calls, mean failed tool calls, mean tool-result size (KB), mean seconds, and p90 seconds. `--detail` adds a per-task pass/fail line and lists incorrect runs with the missing facts.

## Limits

The published comparison used a single fast-tier model. Cursor reports input tokens as 0, so only output tokens are comparable. Tasks are simple lookups. Batch downloads, pagination, credentialed APIs, obscure databases, rate limiting, and UI result viewers are not covered.
