# Plan-execute manual acceptance

Status: pending desktop and SSH validation. Automated tests do not prove model behavior or remote process cleanup.

2026-10-24 local desktop observation: In the existing `localhost:5173` development window, a new ordinary Kimi K2.6 conversation stayed selected beyond 35 seconds, produced a two-step read-only review card, accepted approval, ran both steps, and received a final agent summary. The first step verified `/Users/dengxsh/.phi/workspace`. The second step was recorded as done by the runner, but the final agent correctly reported that its `glob` result did not meet the top-level listing criterion; this remains an acceptance-quality gap. The live page revealed duplicate full plan lists during review and execution. After the fix and a development-window restart, the history card displayed a meaningful title and status with details collapsed by default; clicking “查看计划详情” revealed both original steps, and collapsing it hid them again. This post-change UI check passed.

2026-11-05 follow-up for the done-but-unmet step: a plan step whose final reply lacks a valid `<phi_agent_result>` block is now recorded as `partial` (one automatic retry, then a paused run) instead of done, on both the in-process and RPC delivery paths. Step prompts also state that `completed` requires every acceptance criterion to be verified. A model that declares `completed` while the criterion is unmet is still possible; recheck this during the Completion row below.

Use a disposable local project and a separate test conversation. Record the Phi build, model, date, and session ID before testing. Do not use production files for write steps.

## E4: Local plan-execute

| Check | Action | Expected result | Result |
| --- | --- | --- | --- |
| Review gate | Select Plan and execute; ask for two independent read steps followed by one write step | Read-only investigation produces one structured review card; no file changes before approval | Pending |
| Parallel execution | Approve the plan | Independent read steps overlap; dependent write waits for both | Pending |
| Failure recovery | Make a test step fail twice | One automatic retry, then a paused run with retry, skip, replan, and stop choices | Pending |
| Write retry | Retry a failed write step | Confirmation warns that files may already have changed | Pending |
| Replan | Choose Replan remaining steps and approve a revised plan | A new review card appears; completed steps stay fixed; only remaining work changes; execution resumes after approval | Pending |
| Replan cancellation | Cancel that review | Original run stays paused and can be recovered | Pending |
| Restart recovery | Quit Phi during a running step, then reopen the conversation | Interrupted step is visible with recovery actions; no step is silently relaunched | Pending |
| Completion | Let the plan finish | Timeline records completion once; main agent verifies and summarizes results and exact file paths | Pending |
| Session isolation | Switch to another conversation while a plan runs | The plan continues in its own session; switching does not move its approval or actions | Pending |

## E5: Remote plan-execute (keep the mode gate closed until security review passes)

| Check | Action | Expected result | Result |
| --- | --- | --- | --- |
| Trusted review | Run two remote conversations and submit a plan in each | Each review belongs to its originating session; late approval after cancellation is rejected | Pending |
| Host-start identity | Approve a remote step | Signed request ID matches one native child, one project, one session, and one generation | Pending |
| Cancellation | Cancel before and during child registration | Remote tombstone blocks late dispatch; signed quiescence arrives only after all children terminate | Pending |
| Disconnect | Drop SSH after dispatch but before receipt | Plan records UNKNOWN, retains the request ID for reconciliation, and never automatically retries or skips | Pending |
| Reconnect | Restore the same remote generation and reconcile that request | Only a signed quiescence result releases UNKNOWN; a different request ID cannot release it | Pending |
| Completion | Finish a remote plan | The main agent receives final reports, verifies remote files, and summarizes the result | Pending |

For each failed check, save a redacted timeline/export and the relevant `~/.phi/logs` entries; record whether any remote child or job remained active. Do not mark E5 passed based only on an SSH channel closing.
