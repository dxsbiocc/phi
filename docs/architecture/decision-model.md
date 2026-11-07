# Decision models

Phi uses an enabled, credentialed native judgment model, including OMP's JEV catalog models, for bounded evidence-review and recovery questions. The integration uses the already locked OMP **18.10.3** public APIs; it adds no dependency or OMP version upgrade. Its scope follows the [internal-beta roadmap](../roadmap/internal-beta-implementation.md): session ownership, understandable execution controls, and a small integration boundary.

## Ownership and configuration

[`src/shared/decisionTypes.ts`](../../src/shared/decisionTypes.ts) defines the Phi-owned request, result, model selection, and model-option contracts. Application policies, IPC, and the renderer exchange these plain values. OMP judge classes, model objects, authentication storage, and response formats remain inside [`decision-backend.ts`](../../src/main/agent/engine/in-process/decision-backend.ts).

Configure JEV through the normal **Settings → Providers** authentication flow. Provider cards identify chat and decision capabilities and expose reversible provider/model enable switches. There is no separate decision-model picker. Disabling a provider or model preserves its credentials and catalog entry; enabling it makes it eligible again. Raw management catalogs include unconfigured and disabled models, while native judgment models remain excluded from ordinary chat pickers.

Phi stores disabled provider IDs and provider/model pairs in its own `model-availability.json`, separate from OMP's settings migration. All models are enabled by default. A legacy `decisionModel` setting is ignored and cannot pin automatic decision-model selection. Credentials continue to use the existing desktop provider-authentication system; they are not copied into model-availability settings, renderer state, or RPC tool arguments.

## Model selection and results

| Condition                                                                                   | Behavior                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| An enabled, credentialed native model is available                                          | Choose one deterministically, resolve its registry credentials, and call OMP `createNativeJudge`.             |
| No enabled, credentialed native model is available                                          | Use the invoking session's explicitly selected, enabled chat model through `TextJudge(chatTextBackend(...))`. |
| The chosen native model fails, times out, or produces an invalid answer                     | Fall back once to the invoking session's enabled chat model.                                                  |
| The caller is stopped or the overall deadline expires                                       | Abort the operation and discard late results; do not start fallback.                                          |
| The session has no explicit current model, that model is disabled, or chat evaluation fails | Return a bounded failure; do not substitute a different chat model.                                           |

Each invocation snapshots Phi availability and considers the current credentialed native catalog. The official TypeSafe `jev-latest` alias has priority, followed by other stable `jev-latest` aliases, TypeSafe models, other JEV models, and other native judgment models. Provider/model identifiers break ties deterministically. Disabling the preferred alias allows another eligible candidate on the next invocation. Authentication and availability changes are observed by subsequent calls; an in-flight decision retains its chosen candidate.

The backend does not resolve OMP's global judge-role chain or start/download an on-device model. Once an invocation's native candidate fails, it falls back to the current chat model rather than trying additional native candidates. The session supplies the chat-model selector; model-generated tool arguments cannot choose another session, provider, or model. Local decisions capture the SDK agent's provider-facing session ID and metadata resolver together at invocation. Native authentication, fallback authentication, and chat transport use that same identity; Phi's registry ID and the SDK journal ID remain separate. “Fall back once” describes the transition from native judgment to the session model; OMP may perform its own bounded transport or output-format retries within that chat evaluation.

Native answers must choose one of the supplied options and contain a complete finite probability distribution summing to one, with the chosen option attaining the highest probability. `source: "native"` identifies native judgment APIs, including providers other than JEV. Its optional `confidence` is the SDK's **distribution concentration between 0 and 1**, not the probability of the chosen option. `source: "model"` omits confidence because a text label does not supply a calibrated distribution. Text results report `fallbackReason: "not_configured"` when no enabled credentialed native is available, or `"unavailable"` after a native attempt fails; raw provider errors are not returned through the decision contract.

## Task control and transport

The `phi_decide` tool accepts bounded evidence, a question, an `evidence_review` or `recovery` purpose, and a fixed set of choices. It returns an advisory result. This does not replace direct evidence checks or make the tool an execution authority.

Named delegation is not a decision-model point. The main agent first decides whether work needs an agent, then chooses a matching specialist by stated remit or General when none matches; an explicit user request for an agent or delegation wins. Once the main agent calls a delegation tool, no judgment call reassesses or vetoes that choice. Deterministic approval, concurrency, cancellation, and run-state controls still apply.

Kernel-backed local and SSH sessions expose `phi_decide` to the **main agent only**. Evaluation stays in the owning worker so the text fallback uses the live session model object, provider session ID, and injected ModelAccess credential resolver; provider credentials remain behind the existing desktop broker or remote gateway. Child agents do not inherit this tool. OMP's native `task` is not offered to the main model by default. The only exception is the opt-in remote foreground-child path (`PHI_REMOTE_OMP_AGENTS`), which still hands the remote main model `task` for its compiled Phi agents; it is off by default.

Approval policy, concurrency limits, task identity, launch/stop behavior, run-state transitions, and completion evidence remain owned by Phi's existing deterministic controls. A judgment cannot grant permission, ignore a stop, manufacture completion, or automatically execute a recovery action.

Local SDK sessions receive a filtered registry view for startup, explicit model changes, and automatic recovery. Its availability snapshot refreshes at an idle prompt or model-selection boundary and stays fixed during active work. A disabled saved model retains the existing unavailable-restore state, and an existing session whose current model was disabled cannot start its next prompt until an enabled model is selected. New specialist sessions skip disabled declared candidates and cannot inherit a disabled parent model; if no eligible choice remains, creation fails. The shared raw catalog is not mutated. RPC gateway admission checks new model requests against current availability without revoking already-running streams. A new decision also takes a fresh snapshot, so disabling its current chat fallback produces a bounded decision failure rather than silently changing the parent task's model.

[`decision-client.ts`](../../src/main/agent/engine/decision-client.ts) and [`decision-jobs.ts`](../../src/main/agent/engine/decision-jobs.ts) use unique job IDs and a **45-second overall deadline**. Cancellation has a separate worker message because dropping an IPC reply alone does not stop its provider request. Cancellation arriving before dispatch is remembered for that job, and a stopped job cannot cancel a successor. Native evaluation has a separate **12-second budget**, preserving time for chat fallback. Both the worker jobs and backend reject results arriving after cancellation, even if an underlying operation ignores its signal. Closing the decision runtime aborts its active jobs.

## Accounting and validation limits

When the invoking session exists in the in-process session registry, native reported usage and individual chat attempts are appended to that session's existing off-transcript usage ledger. Chat aggregate usage is not appended again. The initiating session and branch are captured for attribution, and provider error bodies are omitted. Text fallback captures the live model, provider identity, metadata, and credential resolver before dispatch; it does not reselect credentials under Phi's logical session ID. A legacy direct decision client without an owning session still falls back to its supplied runtime identity and registry.

[`engine-decision-backend.test.ts`](../../tests/engine-decision-backend.test.ts) runs the actual locked SDK in a disposable profile against synthetic localhost native and chat providers. It covers discovery, the owning session's exact model endpoint and credential resolver, configured headers, native validation, current-model fallback, cancellation and stale replies, bounded native timing, safe failures, and individual chat-attempt accounting. The ledger sink in this fixture is synthetic. Separate lifecycle, RPC, and settings tests cover the Phi boundaries.

[`engine-automatic-model-availability.test.ts`](../../tests/engine-automatic-model-availability.test.ts) adds actual SDK checks for automatic native ordering, authentication changes, disable/re-enable behavior, in-flight selection stability, disabled current-model failure, startup/default and restored selection, active-versus-next-prompt policy, automatic error recovery, and specialist inheritance and declared alternatives.

Live paid-provider requests and a manual end-to-end remote session have not been validated by this change. Those checks remain necessary before claiming full provider or remote billing parity.

## Planned decision points (design draft)

> Status: **proposal, not implemented.** Review before code changes. Nothing in this section describes current behavior.

The current integration exposes judgment through the model-invoked `phi_decide` tool. The remaining draft points follow OMP's own pattern (auto-thinking, unexpected-stop and `find` call the judge from fixed hooks): **Phi code asks a fixed question at a fixed point and branches on calibrated probabilities**, while the main agent keeps `phi_decide` for open-ended cases. Named delegation is intentionally excluded: the main agent's routing choice is final subject only to deterministic runtime controls.

### Principles

1. **Tighten only.** A judgment may reduce retries, annotate a result or request review. It never intercepts a named delegation, grants approval, adds retries beyond the existing budget, launches work, marks a step done, or overrides a stop. This keeps every point compatible with the ownership rules above.
2. **Probability gates are native-only.** Thresholds apply to `source: "native"` answers. A `source: "model"` text answer has no calibrated distribution, so each point defines a separate, conservative text-fallback behavior (usually "keep today's behavior" or "annotate only").
3. **Fixed hooks, bounded cost.** Each point names its call site, makes at most one judgment call per event, and keeps the existing 45-second/12-second deadlines and cancellation fences.
4. **Thresholds are named constants** in `src/main/agent/decisions/`, starting with the provisional values below and recalibrated from the D6 log, not tuned per call site.
5. **Failure falls through.** If a judgment fails, times out or is cancelled, the point behaves exactly as it does today.
6. **One implementation for local and remote.** See the next section.

### Runtime placement: write once

Local and remote sessions should not get two implementations of these points. Judgment runs beside the owning OMP session for both kernel runtimes and uses the same ModelAccess binding as chat, so the decision logic itself has no project-location dependency. The rule for every point is:

- **Core (shared, written once):** question building, threshold policy, result-to-action mapping and logging live in `src/main/agent/decisions/` as pure functions plus the existing decision client. They take Phi-owned plain values and return a Phi-owned annotation or retry category. They never import local-worker or RPC types.
- **Hook (per runtime, thin):** where a runtime owns the event, a small adapter collects the plain inputs, calls the core, and applies the returned action. An adapter contains no thresholds or question text, so its tests only cover "inputs collected, action applied".

Where each point lands:

| Point | Owner of the event                                    | Local                                            | Remote                                                                                                                                                            |
| ----- | ----------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4/D5 | Plan executor via the `StepRunner` port: main process | Same code path; no adapter.                      | Same code path; no adapter.                                                                                                                                       |
| D6    | Decision runtime: owning session worker               | Shared.                                          | Shared.                                                                                                                                                           |

D4–D6 are written once, because the plan executor and `StepRunner` already run in the main process for both runtimes. Remote plan runs are blocked today by one missing engine capability, not by decision code: `session-routing-engine.ts` throws `RemoteSessionCapabilityError('agentRuns.start')` for remote sessions. Adding that capability is plan-execute stage E5. Once it exists, D4–D5 apply to remote plans without changes.

### D0 — Contract extension

`DecisionResult` gains `probabilities?: Record<string, number>`, present only for `source: "native"`. `decision-backend.ts` already validates the full distribution (`decision-backend.ts:121-141`) and then drops it, so this only stops the drop. Option ids stay the keys, and `confidence` keeps its current meaning (concentration).

Binary questions (D4) are modeled as two-option `choice` questions instead of adding OMP's `noul` type. That keeps one question shape in Phi's contract. `score` questions are out of scope.

### D4 — Completion evidence review

**Where:** plan step completion handling in `src/main/agent/plan/execution/agent-run-completions.ts`, when a run reports `completed`.

Ask one binary question: does the report text, together with the bounded list of written paths, support completion of this step's stated task? Options are `supported` and `not_supported`.

- **Phase 1 (annotate):** If native `P(not_supported) ≥ 0.70`, the step still completes as today, but the step record carries an `evidenceReview` annotation. It is shown in the plan panel and included in the summary that wakes the main agent, which must verify before reporting.
- **Phase 2 (gate, after calibration from D6):** The same signal pauses the run with a new reason, `evidence_review`, instead of completing the step. Resuming is a user action. Phase 2 needs a separate review because it changes the L1 state machine.

The text fallback only ever annotates.

### D5 — Failure classification before retry

**Where:** the plan executor, before it calls `resolvePlanStepFailure` (`src/main/agent/plan/model/failure-policy.ts`). Classification runs in the executor; L1 stays pure and receives the category as one more input.

One `choice` question over the error text and the bounded report:

| Category      | Policy when native `P ≥ 0.70`                                             |
| ------------- | ------------------------------------------------------------------------- |
| `transient`   | Existing rule (retry while `attempts < 2`).                               |
| `environment` | `step_failed` immediately, showing the category; a retry would repeat it. |
| `input`       | `needs_input`.                                                            |
| `task_defect` | `step_failed` immediately.                                                |
| `unknown`     | Existing rule.                                                            |

Below the threshold, with the text fallback, or on failure, the existing rule applies. Because each category either keeps or shortens the retry budget, this is tighten-only. A report that already has `missingInputs` skips classification (today's `needs_input`).

### D6 — Decision log and offline evaluation

Every D4–D5 decision appends one record to a per-session `decisions.jsonl` beside the session's existing local state. Records contain the point id, purpose, timestamp, source, model, option ids, probabilities and confidence, the action taken, and a link to the outcome (run id → final state/report status, or step id → final step state). The context is stored **as a hash plus length**, not as text, so task content is not duplicated into a second store. Retention follows the session's.

A `scripts/` evaluation reads these logs together with a small hand-labeled set to report precision and recall per threshold. Threshold changes ship only with that report, using the same method as the earlier db-toolchain-versus-fetch comparison.

### Deferred: OMP's built-in judge consumers

OMP's auto-thinking classifier, unexpected-stop classifier, `find` tool and TTSR question rules resolve OMP's own `judge` role chain, which this backend intentionally bypasses (see above). Enabling them for local sessions needs that chain to respect Phi's model availability and credentials. That is a separate engine-boundary change and is not part of D0 or D4–D6.

### Rollout and tests

| Order | Points     | Tests                                                                                                                                              |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | D0, D6     | Backend returns probabilities for native only; log record shape and hash-only context.                                                             |
| 2     | D5         | Each category's policy; below-threshold, failure and text fallback keep today's rule; retries never exceed today's budget; L1 functions stay pure. |
| 3     | D4 phase 1 | Annotation only; the main-agent summary includes it; step state unchanged.                                                                         |

Each point keeps the cancellation tests already required by this document: no late result changes state after a stop.

### Review decisions (recommended answers)

Each item gives a recommendation. Accepting the draft accepts these unless the reviewer marks otherwise.

- **R2. Starting thresholds. Recommended: accept 0.70 as a placeholder.** D6 ships in the first step, so data accumulates from day one. Revisit after about 200 logged decisions per point, or at the end of the internal beta, whichever comes first. Changes require the D6 evaluation report.
- **R3. D4 phase 2 (`evidence_review` pause). Recommended: annotate-only for the internal beta.** Adding a pause state touches the L1 state machine, the plan panel and persistence. Decide on phase 2 only once D6 shows that the annotation's precision justifies interrupting runs.
- **R4. Remote coverage. Recommended: no separate remote decision work.** Per Runtime placement, D4–D6 follow remote sessions automatically once E5 adds remote `agentRuns.start`; the owning worker already supplies the same session model and usage ledger boundary for local and SSH runtimes.
