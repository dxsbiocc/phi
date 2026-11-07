# K5-2 legacy main-session removal inventory

Date: 2026-11-07  
Baseline: `main` / `8a333348`  
Acceptance: K5-2, G5, A22

This inventory is the pre-change boundary for K5-2. The five-working-day K5-1 trial is
complete and the product owner approved removal on 2026-11-07. The change removes desktop
main-session execution alternatives; it does not replace or redesign kernel business behavior.

## Behavior lock

Before production edits, the following kernel-route and main-process contracts passed:

```text
node --import ./scripts/test-loader.mjs --test --test-timeout=300000 --test-force-exit \
  tests/engine-kernel-routing-contract.test.ts tests/main-integration.test.ts

422 passed, 0 failed
```

The narrower session/plan routing set also passed 92/92, and `node scripts/test-main.mjs`
passed 386/386. The only diagnostics were non-fatal sandbox `EPERM` warnings while the test
loader attempted to write its transpile cache under `node_modules`.

The current loader still forced `PHI_KERNEL_ENGINE=off` for much of the main integration
fixture. K5-2 will remove that override and then rerun the affected contracts on the kernel
route.

## Entry points checked

| Entry | Main-process path checked | K5-2 disposition |
| --- | --- | --- |
| Create | prompt IPC -> `AgentSessionCreationService.coordinateAgentSessionCreation` -> `createRuntimeAgentSession` -> `SessionRoutingEngine.sessions.create` | Non-`noTools` sessions must require `KernelSessionFactory`; only explicit auxiliary `noTools` calls may use the desktop in-process worker. |
| Resume/open | sessions IPC and lazy creation -> `KernelSessionFactory.historyOpen` / history planner / `KernelSessionFactory.create` | Kernel journals and verified adoption stay. Pre-kernel SSH history is browse-only and cannot create or attach an executable runtime. |
| Prompt | `RuntimeAgentSessionProxy.prompt` -> `SessionRoutingEngine.sessions.prompt` | Main sessions dispatch only to `KernelRoutedSessionDriver.prompt`; the legacy delegate is allowed only for a tracked auxiliary session. |
| Plan run | prompt admission/work-mode control -> plan mode and plan-run IPC | Remove rollback-only SSH plan restrictions and the desktop plan-run owner; kernel `planRuns` is the sole main-session owner. |
| Subagent | agent-run IPC/plan execution -> `PhiEngine.agentRuns` | Remove desktop/facade run fallbacks; kernel driver `agentRuns` is the sole owner. |
| Approval | routed sink -> `PhiEngine.events.respondToolApproval` | Remove legacy approval fallback for main sessions; kernel driver answers the request. |
| Stop | stop IPC -> prompt-run stop -> session/agent/plan abort | Remove legacy session, facade child, and desktop plan stop paths; kernel driver owns all main-session stops. |

## Delete or narrow

### Switch and route selection

| File | Symbols/branches | Reason |
| --- | --- | --- |
| `src/main/agent/engine/kernel-engine-switch.ts` | `KernelEngineMode`, `parseKernelEngineSwitch`, `PHI_KERNEL_ENGINE_MODE`, `kernelEngineHandles` | The rollback switch and `off/local/remote/both` modes are expired. Delete the file. |
| `src/main/agent/engine/kernel-session-support.ts` | switch re-exports and `KernelSessionFactoryOptions.mode` | The installed factory always owns main sessions on both hosts. |
| `src/main/agent/engine/kernel-session-factory.ts` | `handles` and all mode checks | Main-session ownership is unconditional; history read-only policy remains identity-based. |
| `src/main/session-runtime/agent-session-creation.ts` | `resolveSessionCreationRoute`, `useRpc` branches | Main-session creation always prepares the existing kernel route. |
| `src/main/session-runtime/prompt-run-admission.ts` | rollback-only remote plan rejection | Kernel supports plan mode on local and SSH. |
| `src/main/session-runtime/session-resolution.ts` | `kernelHandlesRemote` and old-RPC change rejection | Live kernel sessions support model/thinking changes on either host. |
| `src/main/agent/plan/work-mode-control.ts` | `kernelHandlesRemote` and old-RPC remote plan rejection | Same plan contract on both hosts. |
| `src/main/agent/runtime/runtime-session-resources.ts` | conditional `trustedKernelSessionIdentity` | Preserve a supplied trusted Phi identity without consulting a route switch. |
| `src/main/agent/remote-session-routing.ts` | legacy RPC factory installation and switch-dependent install/uninstall branches | Install the kernel launchers unconditionally. Keep only the options/helpers needed by kernel launch and desktop host services. |
| `src/main/agent/engine/in-process-engine.ts` | `remoteFactory`, `installRemoteSessionRouting`, E5 factory routing, main-session route selection | The desktop worker remains a host/auxiliary service, not a main-session owner. |
| `src/main/agent/engine/session-routing-engine.ts` | legacy main-session create/prompt/abort/model/plan/approval/agent-run/shell-job fallbacks | Replace the implicit fallback with an explicit, tracked `noTools` auxiliary exception; all other sessions require the kernel factory/driver. |

### Legacy remote/facade execution

The following files implement the retired desktop-to-remote OMP main-session owner and will be
deleted once their small shared types/utilities are detached:

- `src/main/agent/engine/rpc/facade-agent-run-tools.ts`
- `src/main/agent/engine/rpc/facade-child-approval.ts`
- `src/main/agent/engine/rpc/facade-child-completion.ts`
- `src/main/agent/engine/rpc/facade-child-tool-scopes.ts`
- `src/main/agent/engine/rpc/facade-desktop-tool-scope.ts`
- `src/main/agent/engine/rpc/facade-event-projection.ts`
- `src/main/agent/engine/rpc/facade-extension-message-projection.ts`
- `src/main/agent/engine/rpc/facade-host-child-start.ts`
- `src/main/agent/engine/rpc/facade-maintenance-projection.ts`
- `src/main/agent/engine/rpc/facade-plan-review-tool.ts`
- `src/main/agent/engine/rpc/facade-session-driver.ts`
- `src/main/agent/engine/rpc/facade-session-policy.ts`
- `src/main/agent/engine/rpc/facade-session-run-control.ts`
- `src/main/agent/engine/rpc/remote-session-runtime.ts`
- `src/main/agent/engine/rpc/rpc-session-backend.ts`
- `src/main/agent/engine/rpc/ssh-stdio-factory.ts`
- `src/main/agent/engine/rpc/turn-failure.ts`

The old facade closure may reveal additional orphaned helpers during typecheck/static reachability.
Any such deletion will be added to this inventory before its deletion commit. Shared deployment,
transport, history, credential, MCP, memory, web-search, and remote-library helpers are not deleted
merely because they currently live under `engine/rpc/`.

### Recovery and plan surfaces

| File/area | Symbols/behavior | Reason |
| --- | --- | --- |
| `src/main/agent/session/runtime-recovery-control.ts` and `runtime-recovery-ipc.ts` plus IPC/preload/renderer callers | Explicit RPC-era executable recovery | Pre-kernel SSH records become browse-only; current kernel history adoption remains in `engine/kernel-history/**`. |
| plan ownership and plan-run IPC wiring | Desktop plan-run alternative and dual router | The kernel owns plan runs for every main session. |
| `src/main/agent/remote-runtime/app-remote-agent-environment.ts` | facade child environment resolution | Kernel subagents resolve their environment in the kernel route. |
| `src/main/agent/remote-runtime/app-remote-agent-resources.ts` | facade child skill snapshot | Kernel resource loading replaces the facade child copy. |
| `src/main/agent/remote-runtime/app-remote-prompt-context.ts` | facade prompt-context snapshot | Kernel session creation already loads trusted project/persona context. |

### Scripts and tests

| File/area | Disposition |
| --- | --- |
| `scripts/test-loader.mjs` | Remove the default `PHI_KERNEL_ENGINE=off`; tests exercise kernel routing or pure units. |
| `scripts/acceptance/g4/lib/runtime.mjs`, `scripts/acceptance/g4/README.md` | Remove `G4_ENGINE` / `PHI_KERNEL_ENGINE` forwarding and documentation. |
| `scripts/kernel-candidate-evidence.ts` | Remove obsolete switch assignments/printed commands; kernel is unconditional. |
| `tests/main-integration.test.ts` | Remove environment forcing and synchronize module/IPC registration lists after deletions. |
| switch/rollback tests in `tests/engine-kernel-session-factory.test.ts`, `tests/kernel-candidate-rollback-drill.test.ts`, and facade/RPC-only suites | Rewrite tests that protect retained history/host behavior; delete only tests whose sole subject is the removed execution owner. |
| kernel route, main integration, session, plan, approval, stop, remote history, and auxiliary helper suites | Keep and run as the regression surface. |

## Keep

| Item | Files/symbols | One-line reason |
| --- | --- | --- |
| Unified kernel route | `src/kernel/**`, `kernel-session-factory.ts`, `kernel-routed-session-driver.ts`, `kernel-execution-host.ts`, `kernel-history/**` | Sole main-session business route for local and SSH, including verified history adoption. |
| Shared kernel business runtime | `engine/in-process/session-creation.ts`, `session-runtime.ts`, `session-factory.ts`, `agent-run-start.ts`, `subagents.ts`, tool/extension modules | The kernel imports these modules directly; their `in-process` directory name does not make them a desktop legacy route. |
| Auxiliary no-tools calls | session title generation, persona generation, Notebook code generation, terminal draft/explanation, and their `noTools` session support | Controlled independent helpers without main-session identity or state ownership (P05/O02). |
| Legacy SSH reader | `session/legacy-remote-session.ts`, Phi timeline/history readers, read-only UI state | Required for browsing old history; no continue, resume, prompt, subagent, approval, or stop entry (H05). |
| Desktop model and credential owner | `OmpBridge`, model runtime/catalog/login, model gateway and credential worker | Kernel calls the desktop owner without moving credentials into the kernel/remote host. |
| Desktop MCP broker | MCP configuration/OAuth/API-key IPC and `kernel-host/desktop-mcp-broker.ts` plus adapter types | UI/authentication remains a host service; the kernel owns session execution (C01). |
| Project memory | the sole desktop memory backend and `kernel-host/desktop-services-broker.ts` | Kernel host capability, not a second session owner (ME01). |
| Web search | settings/credential worker and kernel host execution adapter | Preserve one host service while removing facade session-shape copying (O01). |
| Decisions | `phi_decide` decision backend and kernel desktop service registration | One kernel-owned session service backed by the desktop model/credential owner (M06). |
| Filesystem, approvals UI, Notebook, Wrapper, Library, browser, environment and deliverable services | existing host registries and `app-kernel-desktop-services.ts` | Kernel calls these desktop services through bounded host capabilities. |
| SSH/helper transport and kernel deployment | remote workspace binding, SSH transport, remote helper, kernel client/deployment/cache modules | Required to launch and serve the remote kernel; not the retired RPC session owner. |
| Shared RPC-era compatibility utilities | runtime-reference parsing, kernel history probe/adoption, remote deletion, neutral binding hash, runtime deployment and storage readers | Required to recognize, browse, adopt, or delete old records safely without executing them through the old route. |

## Verification planned

- Static search: no `PHI_KERNEL_ENGINE`, `KernelEngineMode`, `kernelEngineHandles`, switch mode,
  `installRemoteSessionRouting`, facade factory, or legacy main-session fallbacks.
- Entry-point review for create, resume, prompt, plan, subagent, approval, and stop.
- Targeted route/main/session/plan/remote-history/auxiliary tests.
- `bun run typecheck`, `bun run check:architecture`, engine/main boundary checks, and ESLint on
  changed files.
- Independent review of A22 reachability and retained-service reasons.

Actual added/deleted lines and final evidence will be recorded in
`phi-kernel-implementation.md` and the K5-2 ledger rows after the deletion commits.

## Continuation progress

- Verified stopped commit `581df05a`: node/web/scripts typecheck passed; routed-history,
  prompt-admission, and prompt-stop suites passed 11/11.
- Replaced implicit desktop session fallbacks with a tracked `noTools` helper set. Unknown or
  retired main-session identities can no longer prompt, start/control child runs, answer tool
  approvals, or cancel shell jobs through the desktop worker.
- Removed the desktop plan-run IPC/review owner. Plan controls and work-mode activity now resolve
  through the live kernel driver; the shared plan service/store remain because the kernel
  coordinator imports them.
- Deleted the remaining RPC main-session closure (`RemoteSessionRuntime`, `RpcSessionBackend`,
  SSH stdio factory, facade-era child/approval/tool/deployment wiring) and its owner-only tests.
  The remote desktop resource loader now retains only the MCP broker used by the kernel; project
  memory uses the dedicated kernel host service and its packaged worker remains in the bundle.
- `tests/engine-rpc-child-host-controls.test.ts` remains deleted because it covered only the removed `RpcChildAuthority` host-control owner.
- `tests/engine-rpc-cursor-native-shell.test.ts` remains deleted because it covered only the removed facade runtime and extension-deployment route.
- `tests/engine-rpc-runtime-composition.test.ts` remains deleted because it covered only `RemoteSessionRuntime` and legacy extension deployment/resume.
- `tests/engine-rpc-runtime-composition-image.test.ts` remains deleted because it covered only the legacy runtime image-resume route.
- `tests/engine-rpc-runtime-composition-shake.test.ts` remains deleted because it covered only the legacy runtime/session-verification shake-resume route.
- `tests/engine-rpc-native-wire-composition.test.ts` remains deleted because its only case required the removed runtime-composition owner.

- `tests/runtime-session-recovery.test.ts`: removed four cases that created main sessions on the in-process worker and checked worker-death recreation; main sessions now only run through the kernel. The two auxiliary-session cases remain.
