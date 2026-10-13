# PhiEngine contract

The cases in `suite.ts` use only `PhiEngine` and Phi-owned values. An engine factory
supplies an engine connected to a scripted OpenAI-compatible server. The current
factory starts the actual `engine/in-process/main.ts` Bun worker; no fake worker or
OMP imports participate. A future local stdio `RpcEngine` factory can run the same
cases.

## Plan and acceptance

- Create/prompt/dispose a real session; observe start, incremental text, tool start,
  tool end, and agent end in order, and compare returned history.
- Register a real notebook host callback; verify declared arguments survive while
  undeclared fields disappear, and host failures retain `isError` in events/history.
- Abort a held SSE response, settle the prompt, then complete another turn.
- Approve, deny, and cancel a main-session notebook write; inspect callback side
  effects and tool outcomes, rather than merely observing bridge requests.
- Delegate to a Phi specialist, forward a real child tool step, and return its report.
- Read compaction defaults; set/reset per-session enabled/threshold overrides and
  read the engine's returned effective values.
- Restore a persistent session with a present/removed model and verify behavior.
- Write/list/delete a disposable API key; check OAuth capability/credential status
  and reject unsupported OAuth without contacting an identity provider. Seed one
  synthetic stored OAuth credential, verify its configured state, delete it, and
  verify deletion survives a worker restart.

All homes, caches, agent data, projects and histories live below a new temp root.
The worker receives an environment allowlist and an outbound-fetch guard (only
127.0.0.1 is permitted). No real credentials, external model or SSH server is used.
Every fixture closes worker/server and removes its temp root even after failure.

## Current boundary limits

`PhiEngine` has no arbitrary `PhiTool` registration operation, so the contract uses
its existing notebook tool and `host.register('notebookTool.execute', ...)`.
Event/state results are `unknown`; the suite narrows only the fields it observes.
There is no public global compaction write or OAuth `hasOAuth` operation. Global
settings are seeded on disk by the fixture, then only public session overrides and
snapshots are asserted. The in-process fixture seeds OAuth through the pinned
SDK SQLite schema after the real worker initializes it; the suite only observes
public engine snapshots/logout. This fixture seam may need updating with an SDK
storage change. A real OAuth browser/device exchange remains external and
is not exercised. Automatic compaction execution and RPC are later coverage.

Run: `node --import ./scripts/test-loader.mjs --test --test-timeout=90000 tests/engine-contract.test.ts`
