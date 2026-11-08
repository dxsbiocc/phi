# Plan-execute manual acceptance

Status: pending desktop and SSH validation. Automated tests do not prove model behavior or remote process cleanup.

2026-10-24 local desktop observation: In the existing `localhost:5173` development window, a new ordinary Kimi K2.6 conversation stayed selected beyond 35 seconds, produced a two-step read-only review card, accepted approval, ran both steps, and received a final agent summary. The first step verified `/Users/dengxsh/.phi/workspace`. The second step was recorded as done by the runner, but the final agent correctly reported that its `glob` result did not meet the top-level listing criterion; this remains an acceptance-quality gap. The live page revealed duplicate full plan lists during review and execution. After the fix and a development-window restart, the history card displayed a meaningful title and status with details collapsed by default; clicking “查看计划详情” revealed both original steps, and collapsing it hid them again. This post-change UI check passed.

2026-11-05 follow-up for the done-but-unmet step: a plan step whose final reply lacks a valid `<phi_agent_result>` block is now recorded as `partial` (one automatic retry, then a paused run) instead of done, on both the in-process and RPC delivery paths. Step prompts also state that `completed` requires every acceptance criterion to be verified. A model that declares `completed` while the criterion is unmet is still possible; recheck this during the Completion row below.

Use a disposable local project and a separate test conversation. Record the Phi build, model, date, and session ID before testing. Do not use production files for write steps.

## E4: Local plan-execute

2026-11-08 run: packaged app (`build:unpack`, branch `fix/plan-execute-kernel-prompt`), kimi-k3, isolated HOME clone, about 53 model requests in total.

| Check | Action | Expected result | Result |
| --- | --- | --- | --- |
| Review gate | Select Plan and execute; ask for two independent read steps followed by one write step | Read-only investigation produces one structured review card; no file changes before approval | Pass 2026-11-08 (after `2575ef23`; before it kimi-k3 followed OMP's markdown plan prompt and looped on `write` without content) |
| Parallel execution | Approve the plan | Independent read steps overlap; dependent write waits for both | Pass 2026-11-08: both reads started 5 ms apart; the write started after both finished |
| Failure recovery | Make a test step fail twice | One automatic retry, then a paused run with retry, skip, replan, and stop choices | Pass 2026-11-08: write into a read-only dir failed twice (attempts 2), run paused with retry/skip/replan/stop |
| Write retry | Retry a failed write step | Confirmation warns that files may already have changed | Pass 2026-11-08: dialog warns the step may already have changed files |
| Replan | Choose Replan remaining steps and approve a revised plan | A new review card appears; completed steps stay fixed; only remaining work changes; execution resumes after approval | Pass 2026-11-08: done step kept, failed step became skipped, new step wrote `out/count.txt`, run completed. kimi-k3 first tried to edit the started step and change the goal; both were rejected and it corrected itself |
| Replan cancellation | Cancel that review | Original run stays paused and can be recovered | Pass 2026-11-08 after `d1981945` (stopping the review left an uncancellable replan before). Rechecked 2026-11-08 after `9d702f9f`: stopping the replan turn leaves the run paused with its recovery actions and shows no error note |
| Restart recovery | Quit Phi during a running step, then reopen the conversation | Interrupted step is visible with recovery actions; no step is silently relaunched | Pass 2026-11-08 after `75bd06e3` and `7a60b6be`: the run shows on reopen; the step running at quit became interrupted with retry, skip, replan and stop; nothing was relaunched (`slow.txt` absent, no orphan `sleep`). Rechecked 2026-11-08 after `9d702f9f` (packaged, kimi-k3): quitting 20 s into the step left it interrupted with attempts 1 and finishedAt at quit time (duration 19 s), no relaunch, no orphan `sleep`, `slow2.txt` absent |
| Completion | Let the plan finish | Timeline records completion once; main agent verifies and summarizes results and exact file paths | Pass 2026-11-08: completion recorded once; the main agent verified and summarized `summary.md` with its path and content |
| Session isolation | Switch to another conversation while a plan runs | The plan continues in its own session; switching does not move its approval or actions | Pass 2026-11-08: another conversation showed no review or plan actions while the plan kept running |

## E5: Remote plan-execute (keep the mode gate closed until security review passes)

| Check | Action | Expected result | Result |
| --- | --- | --- | --- |
| Trusted review | Run two remote conversations and submit a plan in each | Each review belongs to its originating session; late approval after cancellation is rejected | Partial 2026-11-08 (dev app, GPU): two remote conversations each showed only their own review card; approving B left A's review pending, and A was approved separately later. Late approval after cancellation was not exercised |
| Host-start identity | Approve a remote step | Signed request ID matches one native child, one project, one session, and one generation | Pass 2026-11-08 (dev app, GPU): each approved step launched once (`attempts` 1) with one request ID bound to one kernel agent run in its own session. The unified kernel replaces the signed-request design with agent-run receipts |
| Cancellation | Cancel before and during child registration | Remote tombstone blocks late dispatch; signed quiescence arrives only after all children terminate | Pass 2026-11-08 (dev app, GPU, after `fae2b53e`/`bf73ef61`): the remote session showed the plan panel; Stop → Confirm cancelled step 1 after 24 s (`attempts` 1) with no error, step 2 stayed pending, and its output never appeared after the command's scheduled end. A plan without explicit agents was accepted on the first submission and ran PlanStep. Packaged recheck (`2b169ec8`) passed the same way at 11:14 |
| Disconnect | Drop SSH after dispatch but before receipt | Plan records UNKNOWN, retains the request ID for reconciliation, and never automatically retries or skips | Pass 2026-11-08 (dev app, GPU): killing the SSH master while step 1 ran reconnected in 2 s to the same detached remote kernel process; the step stayed running with `attempts` 1, no retry or skip. The kernel keeps the plan on the server, so UNKNOWN is not entered |
| Reconnect | Restore the same remote generation and reconcile that request | Only a signed quiescence result releases UNKNOWN; a different request ID cannot release it | Pass 2026-11-08 (dev app, GPU): the reattached kernel reported the same run and step state, and a later stop applied to that same run |
| Completion | Finish a remote plan | The main agent receives final reports, verifies remote files, and summarizes the result | Pass 2026-11-08: completion recorded once; the main agent verified and summarized `summary.md` with its path and content |

For each failed check, save a redacted timeline/export and the relevant `~/.phi/logs` entries; record whether any remote child or job remained active. Do not mark E5 passed based only on an SSH channel closing.
