import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import type { RpcApprovalDecision } from '../src/main/agent/engine/rpc/approval-bridge'
import { NotebookToolHostRouter } from '../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolRequest } from '../src/main/agent/notebook/notebook-tools'
import { desktopToolsFixture, PNG } from './helpers/rpcDesktopToolsFixture'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Actual desktop composition did not reach its expected state')
    await delay(5)
  }
}

test(
  'production runtime uses genuine desktop builders/coordinators and gates real notebook writes before service effects',
  { timeout: 90000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const owner: { current?: RemoteSessionRuntime } = {}
    const desktop = desktopToolsFixture({
      cwd: f.f.scope.projectRoot,
      identity: {
        runtimeSessionId: f.defaults.params.sessionId,
        sessionId: f.f.scope.phiSessionId,
        projectId: f.f.scope.projectId
      },
      currentRun: () => owner.current?.currentRun()
    })
    t.after(() => desktop.close())
    let notebookEffects = 0
    const router = new NotebookToolHostRouter({
      local: async () => {
        throw new Error('Local notebook fallback forbidden')
      },
      isRemoteCwd: () => true,
      resolveRemote: async (identity) => {
        assert.deepEqual(identity, {
          runtimeSessionId: f.defaults.params.sessionId,
          sessionId: f.f.scope.phiSessionId,
          projectId: f.f.scope.projectId
        })
        return {
          projectCwd: f.f.scope.projectRoot,
          execute: async (request) => {
            assert.equal(request.action, 'save')
            assert.equal(request.cwd, f.f.scope.projectRoot)
            notebookEffects++
            return { summary: 'selected remote notebook saved', path: request.params.path }
          }
        }
      }
    })
    desktop.services.register('notebookTool.execute', (params, context) => {
      assert.equal(context.originSessionId, f.defaults.params.sessionId)
      assert.ok(context.toolCallId)
      return router.execute(params as NotebookToolRequest)
    })
    let answer: ((decision: RpcApprovalDecision) => void) | undefined
    let genericDialogs = 0
    const runtime = await f.create({
      tools: desktop.scope.tools,
      hostApprovalFor: desktop.scope.approvalFor,
      recentUserImages: desktop.scope.recentUserImages,
      approval: {
        shouldGate: () => true,
        requestToolApproval: (request) => {
          genericDialogs++
          assert.equal(request.sessionId, f.f.scope.phiSessionId)
          assert.equal(request.toolName, 'notebook_save')
          return new Promise((resolve) => {
            answer = resolve
          })
        }
      }
    })
    owner.current = runtime
    await f.sdk.enqueue(
      {
        tool: {
          name: 'browser',
          args: { action: 'snapshot', tabId: 'tab-1' },
          id: 'composition-browser'
        }
      },
      { text: 'Desktop browser snapshot received' }
    )
    const browser = await runtime.prompt(
      'phi-browser-real-scope',
      'Take the selected browser snapshot'
    )
    assert.equal(browser.outcome, 'completed')
    assert.equal(genericDialogs, 0)
    assert.equal(desktop.observed.length, 1)
    assert.deepEqual(desktop.observed[0].context, {
      originSessionId: f.defaults.params.sessionId,
      toolCallId: 'composition-browser'
    })
    const savedImage = browser.snapshot.messages.findLast(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'toolCallId' in message &&
        message.toolCallId === 'composition-browser' &&
        'role' in message &&
        message.role === 'toolResult'
    )
    assert.equal(JSON.stringify(savedImage).includes(PNG), true)
    await f.sdk.enqueue(
      { tool: { name: 'notebook_save', args: { path: 'selected.ipynb' }, id: 'composition-save' } },
      { text: 'Notebook save acknowledged' }
    )
    const pending = runtime.prompt('phi-notebook-scope-write', 'Save the selected notebook')
    await until(() => !!answer)
    assert.equal(notebookEffects, 0)
    answer!('approved')
    assert.equal((await pending).outcome, 'completed')
    assert.equal(notebookEffects, 1)
    answer = undefined
    await f.sdk.enqueue(
      { tool: { name: 'notebook_save', args: { path: 'denied.ipynb' }, id: 'composition-denied' } },
      { text: 'Denied notebook save acknowledged' }
    )
    const denied = runtime.prompt('phi-notebook-scope-denied', 'Save a denied notebook')
    await until(() => !!answer)
    assert.equal(notebookEffects, 1)
    answer!('denied')
    assert.equal((await denied).outcome, 'failed')
    assert.equal(notebookEffects, 1)
    await runtime.close()
  }
)
