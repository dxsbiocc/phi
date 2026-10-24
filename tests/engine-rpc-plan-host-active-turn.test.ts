import assert from 'node:assert/strict'
import test from 'node:test'

import { createFacadePlanReviewTool } from '../src/main/agent/engine/rpc/facade-plan-review-tool'
import { facadeRuntimeOwnerIsCurrent } from '../src/main/agent/engine/rpc/facade-session-policy'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import type { SessionRun } from '../src/main/agent/session/session-runner-registry'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

test(
  'plan host proposal remains authorized while a real remote prompt is active',
  { timeout: 90000 },
  async (t) => {
    const fixture = await runtimeCompositionFixture()
    t.after(() => fixture.close())
    const runController = new AbortController()
    const run = {
      runId: 'plan-turn-1',
      sessionId: fixture.f.scope.phiSessionId,
      signal: runController.signal
    } as SessionRun
    const owner: {
      runtime?: RemoteSessionRuntime
      attached?: ReturnType<RemoteSessionRuntime['currentSnapshot']>['reference']
      verified?: ReturnType<RemoteSessionRuntime['currentSnapshot']>['reference']
    } = {}
    let reviewed = 0
    let checkedBusySnapshot = false
    const tool = createFacadePlanReviewTool({
      runtimeSessionId: fixture.defaults.params.sessionId,
      phiSessionId: fixture.f.scope.phiSessionId,
      host: {
        invoke: async (_method, _params, context) => {
          assert.equal(context.originSessionId, fixture.defaults.params.sessionId)
          reviewed++
          return { decision: 'revise', note: 'Add acceptance evidence.' }
        }
      },
      currentRun: () => run,
      assertCurrent: () => {
        if (owner.runtime && !owner.runtime.isReady) {
          assert.throws(() => owner.runtime!.currentSnapshot(), /not ready/)
          checkedBusySnapshot = true
        }
        if (
          !facadeRuntimeOwnerIsCurrent({
            owner: () => owner.runtime,
            current: () => owner.runtime,
            epoch: 1,
            currentEpoch: () => 1,
            unavailable: () => false,
            assertPolicy: () => undefined,
            reference: () => owner.attached,
            snapshotReference: () => owner.verified!
          })
        )
          throw new Error('Plan host generation changed')
      }
    })
    const runtime = await fixture.create({
      tools: [tool],
      hostApprovalFor: () => 'read',
      promptPolicy: {
        hostAlias: fixture.f.scope.hostProfileId,
        contextRoot: fixture.f.scope.projectRoot,
        contextFiles: [],
        workMode: 'plan_execute'
      }
    })
    owner.runtime = runtime
    owner.attached = runtime.currentSnapshot().reference
    owner.verified = Object.freeze({ ...owner.attached })
    await fixture.sdk.enqueue(
      {
        tool: {
          name: 'propose_plan_steps',
          id: 'plan-host-1',
          args: {
            version: 1,
            goal: 'Review the remote plan',
            steps: [
              {
                id: 'inspect',
                title: 'Inspect',
                instructions: 'Inspect the project.',
                acceptance: 'Evidence recorded.',
                dependsOn: [],
                access: 'read'
              }
            ]
          }
        }
      },
      { text: 'Plan revision requested.' }
    )
    const completed = await runtime.prompt(
      run.runId,
      'Propose this structured plan.',
      undefined,
      runController.signal
    )
    assert.equal(completed.outcome, 'completed')
    assert.equal(reviewed, 1, JSON.stringify(completed.snapshot.messages).slice(-3000))
    assert.equal(checkedBusySnapshot, true)
  }
)
