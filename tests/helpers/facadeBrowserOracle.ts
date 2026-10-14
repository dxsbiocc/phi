import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import type { BrowserWindow } from 'electron'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { BrowserWorkspaceRegistry } from '../../src/main/browser/browser-workspace-registry'
import { BrowserIpcCoordinator } from '../../src/main/browser/browser-ipc'
import { BrowserToolHostCoordinator } from '../../src/main/agent/browser/browser-tool-host'
import { InMemoryBrowserEngine } from '../../src/main/browser/in-memory-browser-engine'
import type { EngineTabHandle } from '../../src/main/browser/browser-engine'
import { createRunId, readSessionEvents } from '../../src/main/agent/session/session-store'
import type { ToolApprovalRequest } from '../../src/main/agent/tool-approval'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron')
      return {
        url: 'data:text/javascript,export const BrowserWindow={getFocusedWindow:()=>null,getAllWindows:()=>[]}',
        shortCircuit: true
      }
    return nextResolve(specifier, context)
  }
})
const { requestToolApproval, resolveToolApproval } =
  await import('../../src/main/agent/tool-approval')
class ApprovalWindow extends EventEmitter {
  readonly requests: ToolApprovalRequest[] = []
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, request: ToolApprovalRequest): void => {
      this.requests.push(request)
    }
  })
  isDestroyed(): boolean {
    return false
  }
}
async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    assert.ok(Date.now() - start < 15000, 'browser app boundary did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
export async function runApplicationBrowserScenario(
  f: FacadeMetadataFixture,
  mode: string
): Promise<void> {
  const proxy = (await f.createApplicationSession()).session
  const window = new ApprovalWindow()
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: { tagName: 'INPUT', inputType: 'text', editable: true, submitsForm: false }
  })
  const registry = new BrowserWorkspaceRegistry({
    engineFactory: () => engine,
    approveAgentAction: (prompt, signal) =>
      requestToolApproval({
        signal,
        getWindow: () => window as unknown as BrowserWindow,
        context: { sessionId: f.phi.sessionId, runId: prompt.runId, cwd: f.f.scope.projectRoot },
        toolCallId: prompt.toolCallId,
        browser: {
          origin: prompt.origin,
          action: prompt.action,
          consequence: prompt.consequence,
          reason: prompt.reason
        },
        onApprovalRequested: (request) =>
          f.runners.markNeedsApproval(f.phi.sessionId, request.requestId, {
            toolName: request.toolName,
            summary: request.summary
          }),
        onApprovalResolved: (request, approved) =>
          approved
            ? f.runners.markApprovalApproved(f.phi.sessionId, request.requestId)
            : f.runners.markApprovalDenied(f.phi.sessionId, request.requestId),
        onApprovalCancelled: (request) =>
          f.runners.markApprovalCancelled(f.phi.sessionId, request.requestId)
      })
  })
  const ipc = new BrowserIpcCoordinator({
    getRegistry: () => registry,
    getTrustedRenderer: () => null,
    resolveHumanSession: () => undefined,
    resolveAgentSession: (origin) =>
      origin === proxy.runtimeSessionId
        ? {
            sessionId: f.phi.sessionId,
            owner: { kind: 'project', location: f.phi.manifest.projectLocation! }
          }
        : undefined
  })
  const host = new BrowserToolHostCoordinator({
    resolveActiveRun: (origin) => {
      const run = f.runners.getActiveRun(f.phi.sessionId)
      return run && origin === proxy.runtimeSessionId
        ? { runId: run.runId, cancelled: run.signal.aborted }
        : undefined
    },
    executeAgent: async (params, signal) => {
      const result = await ipc.executeAgent(params, signal)
      if (result.ok && (params as { command?: { type?: string } }).command?.type === 'open') {
        const workspace = registry.get(f.phi.sessionId)!
        await workspace.setViewport(result.snapshot.activeTabId!, {
          x: 0,
          y: 0,
          width: 800,
          height: 600
        })
      }
      return result
    }
  })
  f.engine.host.register('browser.execute', (params) => host.execute(params))
  f.engine.host.register('browser.cancel', (params) => host.cancel(params))
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: () => {
      throw new Error('browser must use its existing coordinator approval')
    }
  })
  const run = async (prompt: string): Promise<void> => {
    const active = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt(prompt)
    })
    await active.done
  }
  const secret = 'PRIVATE_APP_BROWSER_TYPED_TEXT'
  try {
    await registry.setActiveSession(f.phi.sessionId)
    f.provider.enqueue(
      { tool: { name: 'browser', args: { action: 'open', url: 'https://example.test/form' } } },
      { tool: { name: 'browser', args: { action: 'snapshot', tabId: 'browser-tab-1' } } },
      {
        tool: {
          name: 'browser',
          args: {
            action: 'typeText',
            tabId: 'browser-tab-1',
            expectedDocumentRevision: 1,
            text: secret,
            consequence: 'write'
          }
        }
      },
      { text: 'Browser settled' }
    )
    const pending = run('Type the private fixture text after approval')
    try {
      await until(() => window.requests.length > 0)
    } catch (error) {
      console.error(
        JSON.stringify({
          messages: f.provider.requests
            .at(-1)
            ?.messages.filter((message) => message.role !== 'system'),
          state: proxy.messages
        })
      )
      throw error
    }
    const request = window.requests[0]
    assert.equal(request.sessionId, f.phi.sessionId)
    assert.equal(request.toolName, 'browser')
    assert.doesNotMatch(JSON.stringify(request), new RegExp(secret))
    if (mode === 'browser-stop') {
      f.runners.stopRun(f.phi.sessionId)
      await proxy.abort()
      assert.equal(resolveToolApproval(request.requestId, true, window.webContents), false)
    } else
      assert.equal(
        resolveToolApproval(request.requestId, mode === 'browser-flow', window.webContents),
        true
      )
    await pending
    const typed = engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter((action) => action.command.type === 'typeText')
    assert.equal(
      typed.length,
      mode === 'browser-flow' ? 1 : 0,
      JSON.stringify(
        proxy.messages.filter((message) => (message as { role?: string }).role === 'toolResult')
      )
    )
    if (typed.length) assert.equal((typed[0].command as { text: string }).text, secret)
    assert.doesNotMatch(JSON.stringify(proxy.messages), new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(f.provider.requests), new RegExp(secret))
    const events = readSessionEvents(f.phi.sessionId)
    assert.equal(events.filter((event) => event.type === 'approval_requested').length, 1)
    assert.equal(
      events.filter(
        (event) =>
          event.type ===
          (mode === 'browser-flow'
            ? 'approval_approved'
            : mode === 'browser-denied'
              ? 'approval_denied'
              : 'approval_cancelled')
      ).length,
      1
    )
  } finally {
    await proxy.dispose()
    await registry.disposeAll()
  }
}
