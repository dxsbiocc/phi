# Remote path constraint audit (2026-10-17)

Scope: the RPC path for remote projects (OMP runs on the server), per `omp-decoupling-upgrade-plan.md` M1–M8, R1–R9 and the code on branch `fix/t16-local`. Read-only review; nothing has been changed yet. Every item is decided by the user.

Recommendation key: **keep** = needed and cheap; **simplify** = the goal is right but the implementation is too heavy; **remove** = cost exceeds benefit.

## A. Security and correctness constraints

| # | Constraint | Why it exists | Cost | Recommendation |
|---|---|---|---|---|
| A1 | Model keys never go to the server; the model proxy goes back to the desktop through a reverse tunnel, and every session uses a random token (M6) | On shared login nodes other users can reach 127.0.0.1 ports | One tunnel plus one token file; the cost is small | **keep** |
| A2 | Server-side OMP uses an isolated `HOME` / `PI_CODING_AGENT_DIR` and does not read the user's `~/.omp` or `~/.claude` | Prevents the user's own config and plugins from silently changing Phi's behaviour | Almost none | **keep** |
| A3 | `--trusted-extension` loads only the Phi extension; project MCP and ambient extensions are disabled in the private config | Same as above; already enforced by OMP itself | Almost none | **keep** |
| A4 | Before startup, scan the project for plugin tools (`project_plugin_guard`, about 20 commands) | Prevents project plugins from injecting tools | 20 remote commands | **simplify**: A3 already disables them at the OMP layer; keep only a single-command check, or drop it |
| A5 | Every launch is attested with a one-time nonce (bootstrap/runtime attestation) | Confirms the process at the other end is the Phi extension just launched, not a leftover process | Done over the RPC channel, no extra SSH commands | **keep** |
| A6 | Every startup fully re-verifies the installed OMP, extension and helper (hash + lock + per-file check) | Detect tampering | About 120+ commands; re-checking cannot stop tampering that happens after the check | **simplify** (in progress): full check once at install time + a ready marker; startup only compares the marker |
| A7 | Every few-KB config file goes through the resumable large-file transfer path | Reused the existing upload path | About 20–25 commands per file, about 140 for six files | **simplify** (in progress): write them in one go from the startup script |
| A8 | Journal identity/binding checks on resume (three points) | Prevents a session record from being swapped or bound to the wrong project | About 170 commands today | **keep the checks, change the execution** (in progress): before launch inside the startup script, after launch through the extension over RPC |
| A9 | When the remote side fails, never fall back to local execution | Prevents a remote request from changing local files | None | **keep** |
| A10 | After a disconnect, never re-send the request automatically; recovery must be explicit | Prevents duplicate writes/execution | None | **keep** |
| A11 | Server must have `flock`; locks are released on disconnect | Concurrent deploys do not corrupt each other | A precondition only | **keep** |
| A12 | Phi never downloads the OMP binary on the server; it is verified on the desktop and uploaded | Login nodes are often offline; the server cannot reach the network | One upload at install time | **keep** |

2026-10-21 UX clarification for A10: selecting a remote conversation is an explicit user action
that may attach to its verified original journal. It does not re-send an interrupted prompt or job.
Background disconnects still must not trigger an automatic replay.

## B. Sub-agents (T14)

| # | Constraint | Why it exists | Cost | Recommendation |
|---|---|---|---|---|
| B1 | A child may launch only names in Phi's trusted list | Prevents a project's own agent from being launched with Phi's permissions | None | **keep** |
| B2 | At dispatch, OMP's own discovery logic verifies the definition that actually resolved is the one Phi published (775c510b) | The only real-world way a project's `.omp/agents` can shadow a Phi agent | One local read per dispatch, no SSH | **keep** |
| B3 | Same-name conflict detection + startup dialog + in-chat question + rename script + Phi alias persistence (775c510b, about 1000 lines) | Let the user resolve name clashes | About 1000 lines, a detector run on every connection; Phi's native names are hashes like `phi_<hash>_0_fg`, so this practically never fires | **simplify**: keep B2's refusal (the message names the file); remove detection/dialog/rename script/alias, or turn them off by default |

## C. Process constraints

| # | Constraint | Why it exists | Cost | Recommendation |
|---|---|---|---|---|
| C1 | Real-host test scripts live in `.omx`; every run freezes HEAD/tree plus hashes of 2700+ files, and every commit must be rebound | Proves "what ran is exactly what was reviewed" | A rebind before every server run; the scripts are scattered outside the repo; this caused several "same command again" detours | **simplify**: move into the repo as `scripts/t16-r8.ts --host GPU|node3`; the receipt records commit + bundle hash only; drop the per-file freeze |
| C2 | Every acceptance needs a pile of evidence (freeze, receipt, ledger, separate "this does not stand in for that" statements) | Prevents passing results from being overstated | Status documents are almost unreadable (`omp-remote-acceptance.md` is 383 lines, mostly qualifiers) | **simplify**: one status table per R item (pass/fail/not run + commit + date); keep the details in the receipt |
| C3 | Engine boundary allowlist may only shrink | OMP upgrades only touch `engine/` | Small | **keep**; add a rule for test-only SDK oracle entries |
| C4 | Full test suite only at milestones, fixed version | Saves time | — | **keep**; plus: run the full suite before merging to main (missed earlier) |
| C5 | New: per-step remote command ceiling tests | Prevents the "500 commands" problem from coming back | Small | **add** (included in the current startup redesign) |

## D. Gates for switching the default to RPC

| # | Constraint | Recommendation |
|---|---|---|
| D1 | R1–R8 all pass, including real provider/OAuth, Notebook/Wrapper, manual UI and Finder | **simplify into an explicit list**: GPU+node3 R8 three cases (in progress) + one real-provider conversation + one Notebook or Wrapper + one manual UI pass; write it as a single checklist rather than spreading it across several documents |
| D2 | T18 removes the old implementation only after one upgrade cycle | **keep** |

## Expected effect

- Startup: 500+ commands → about 3 (A4, A6, A7, A8; mostly in progress).
- Code: B3 drops about 1000 lines.
- Server test turnaround: C1 removes the rebind before every run.
- Documents: C2 makes the status readable at a glance.

## User decisions (2026-10-17)

| Item | Decision | Follow-up |
|---|---|---|
| B3 | Keep only the dispatch-time refusal (B2); remove detection, dialog, in-conversation question, rename script and alias | Codex task after the startup redesign |
| A4 | Move the project plugin check into the single startup script | Added to the startup redesign |
| C1/C2 | Simplify both: real-host scripts move into the repo (`scripts/t16-r8.ts --host`), receipts record commit + bundle hash only; status becomes one row per R item | C1 Codex task after the startup redesign; C2 written by Claude when merging |
| D1 | Explicit checklist: GPU + node3 R8 three cases, one real-provider conversation, one Notebook or Wrapper, one manual UI pass | Written into the plan by Claude when merging |
