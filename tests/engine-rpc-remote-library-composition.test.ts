import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createRpcDesktopToolScope } from '../src/main/agent/engine/rpc/desktop-tool-scope'
import { RemoteLibraryService } from '../src/main/agent/engine/rpc/remote-library-service'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import type { RpcApprovalDecision } from '../src/main/agent/engine/rpc/approval-bridge'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { createRemoteRuntimeInputExec } from '../src/main/agent/remote-runtime/input-exec'
import { createLocalShellSession } from './helpers/localShellSession'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Library approval did not arrive')
    await delay(5)
  }
}

test(
  'production remote library save approval pending/deny/stop has zero storage effects and approval commits on selected server',
  { timeout: 90000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const root = f.f.scope.projectRoot
    const sessions: ReturnType<typeof createLocalShellSession>[] = []
    const connect = async (): Promise<ReturnType<typeof createLocalShellSession>> => {
      const session = createLocalShellSession(root)
      sessions.push(session)
      return session
    }
    const host = new SshHost({ remoteRoot: root, canonicalRoot: root, connect })
    t.after(async () => {
      await host.close()
      await Promise.all(sessions.map((session) => session.close()))
    })
    const identity = {
      runtimeSessionId: f.defaults.params.sessionId,
      sessionId: f.f.scope.phiSessionId,
      projectId: f.f.scope.projectId
    }
    let invocations = 0
    const service = new RemoteLibraryService((requested) => {
      assert.deepEqual(requested, identity)
      return {
        workspace: {
          projectHost: host,
          runtimeHost: f.f.host,
          projectRoot: root,
          runtimeRoot: f.f.runtimeRoot,
          execWithInput: createRemoteRuntimeInputExec(connect)
        },
        openLockStdio: async (command) => (await connect()).openStdio!(command)
      }
    })
    const registry = new HostServiceRegistry()
    registry.register('library.execute', (params, context) => {
      invocations++
      return service.execute(params, context)
    })
    registry.register('library.cancel', (params, context) => service.cancel(params, context))
    const owner: { current?: RemoteSessionRuntime } = {}
    const scope = createRpcDesktopToolScope({
      identity: { ...identity, cwd: root },
      services: registry,
      currentRun: () => owner.current?.currentRun(),
      recentUserImages: () => [],
      allowBrowserTypeText: () => false,
      browserTextVault: new BrowserTextVault(),
      agentDir: f.f.root,
      allowedSkills: [],
      scriptTools: [],
      remoteLibrary: true
    })
    t.after(() => {
      scope.dispose()
      service.dispose()
    })
    let answer: ((decision: RpcApprovalDecision) => void) | undefined
    const runtime = await f.create({
      tools: scope.tools,
      hostApprovalFor: scope.approvalFor,
      approval: {
        shouldGate: () => true,
        requestToolApproval: (request) => {
          assert.equal(request.toolName, 'lib_save')
          assert.equal(request.sessionId, identity.sessionId)
          assert.equal(request.cwd, root)
          return new Promise((resolve) => {
            answer = resolve
          })
        }
      }
    })
    owner.current = runtime
    const index = join(root, '.phi/library/index.json')
    await f.sdk.enqueue(
      { tool: { name: 'lib_save', id: 'library-denied', args: { title: 'Denied paper' } } },
      { text: 'Denial acknowledged' }
    )
    const denied = runtime.prompt('phi-library-denied', 'Save this denied paper')
    await until(() => !!answer)
    assert.equal(invocations, 0)
    await assert.rejects(access(index))
    answer!('denied')
    assert.equal((await denied).outcome, 'failed')
    assert.equal(invocations, 0)
    await assert.rejects(access(index))
    answer = undefined
    await f.sdk.enqueue({
      tool: { name: 'lib_save', id: 'library-stopped', args: { title: 'Stopped paper' } }
    })
    const stopped = runtime.prompt('phi-library-stopped', 'Wait for library approval then stop')
    await until(() => !!answer)
    await runtime.stop()
    answer!('approved')
    assert.equal((await stopped).outcome, 'aborted')
    assert.equal(invocations, 0)
    await assert.rejects(access(index))
    answer = undefined
    await f.sdk.enqueue(
      {
        tool: {
          name: 'lib_save',
          id: 'library-approved',
          args: { title: 'Approved selected remote paper', doi: '10.5555/REMOTE' }
        }
      },
      { text: 'Paper saved' }
    )
    const approved = runtime.prompt('phi-library-approved', 'Save the selected remote paper')
    await until(() => !!answer)
    assert.equal(invocations, 0)
    answer!('approved')
    const result = await approved
    assert.equal(result.outcome, 'completed')
    assert.equal(invocations, 1)
    const saved = JSON.parse(await readFile(index, 'utf8')) as {
      papers: Array<{ canonicalId: string; revision: number }>
    }
    assert.equal(saved.papers.length, 1)
    assert.equal(saved.papers[0].canonicalId, 'doi:10.5555/remote')
    assert.equal(saved.papers[0].revision, 1)
    const toolResult = result.snapshot.messages.findLast(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'toolCallId' in message &&
        message.toolCallId === 'library-approved' &&
        'role' in message &&
        message.role === 'toolResult'
    )
    assert.equal(JSON.stringify(toolResult).includes('doi:10.5555/remote'), true)
    await runtime.close()
  }
)
