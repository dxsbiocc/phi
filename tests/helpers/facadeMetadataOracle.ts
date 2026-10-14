import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeReferenceError } from '../../src/main/agent/session/runtime-reference'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcCommand, RpcRequestOptions } from '../../src/main/agent/engine/rpc/types'
import { StringDecoder } from 'node:string_decoder'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { renameSession, phiOnlySessionPath } from '../../src/main/agent/session/sessions'
import {
  findPhiSessionById,
  updateSessionManifest,
  createRunId,
  createPhiSession
} from '../../src/main/agent/session/session-store'
import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'

async function cliState(channel: RemoteStdioProcess): Promise<Record<string, unknown>> {
  const id = 'metadata-oracle-' + randomUUID(),
    decoder = new StringDecoder('utf8')
  return new Promise((resolve, reject) => {
    let pending = ''
    const timeout = setTimeout(() => {
      detach()
      reject(new Error('metadata oracle state read did not return'))
    }, 5000)
    const data = (bytes: Buffer): void => {
      pending += decoder.write(bytes)
      let boundary: number
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const raw = JSON.parse(pending.slice(0, boundary))
        pending = pending.slice(boundary + 1)
        if (raw.type === 'response' && raw.id === id) {
          detach()
          if (raw.success) resolve(raw.data)
          else reject(new Error('actual CLI state rejected'))
        }
      }
    }
    const detach = (): void => {
      clearTimeout(timeout)
      channel.stdout.removeListener('data', data)
    }
    channel.stdout.on('data', data)
    channel.stdin.write(JSON.stringify({ type: 'get_state', id }) + '\n', (error) => {
      if (error) {
        detach()
        reject(error)
      }
    })
  })
}

function delayNameAck(name: string): {
  acknowledged: Promise<void>
  release(): void
  restore(): void
} {
  let acknowledged!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    acknowledged = resolve
  })
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = RpcConnection.prototype.request
  let held = false
  const mocked = mock.method(
    RpcConnection.prototype,
    'request',
    function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
      const response = original.call(this, command, options)
      if (!held && command.type === 'set_session_name' && command.name === name) {
        held = true
        return response.then(async (value) => {
          acknowledged()
          await delayed
          return value
        })
      }
      return response
    }
  )
  return { acknowledged: ready, release, restore: () => mocked.mock.restore() }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - started < 5000)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const f = await facadeMetadataFixture()
let primaryFailed = false,
  cleanupFailure: unknown
try {
  const params = f.params('unused')
  const createProxy = async (): Promise<
    Awaited<ReturnType<typeof createRuntimeAgentSession>>['session']
  > =>
    (
      await createRuntimeAgentSession({
        cwd: params.cwd,
        agentDir: params.agentDir,
        model: params.model,
        thinkingLevel: params.thinkingLevel,
        projectBound: true,
        remoteProject: params.remoteProject
      })
    ).session
  const mode = process.env.PHI_FACADE_METADATA_MODE
  let decide: ((value: 'approved' | 'denied' | 'cancelled') => void) | undefined
  let approvalSeen = false
  if (mode === 'approval')
    f.configureApproval({
      shouldGate: () => true,
      requestToolApproval: (_request, signal) =>
        new Promise((resolve) => {
          decide = resolve
          approvalSeen = true
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
    })
  const proxy = await createProxy()
  const originalRef = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
  if (mode === 'usage') {
    const actual = await cliState(f.channels[0])
    assert.deepEqual(await proxy.getContextUsage(), actual.contextUsage ?? null)
    assert.equal(f.provider.requests.length, 0)
  } else if (mode === 'busy' || mode === 'approval') {
    if (mode === 'busy') f.provider.enqueue({ text: 'stream stays active', hold: true })
    else
      f.provider.enqueue(
        {
          tool: { name: 'write', args: { path: 'approval.txt', content: 'approved exactly once' } }
        },
        { text: 'approval completed' }
      )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('explicit user submission')
    })
    await waitFor(() => (mode === 'busy' ? f.provider.requests.length === 1 : approvalSeen))
    await assert.rejects(
      renameSession(phiOnlySessionPath(f.phi.sessionId), 'must not write while busy'),
      /idle/
    )
    await assert.rejects(proxy.getContextUsage(), /idle/)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.title, undefined)
    assert.equal(run.signal.aborted, false)
    if (mode === 'busy') await proxy.abort()
    else {
      assert.equal(await f.exists(join(f.f.scope.projectRoot, 'approval.txt')), false)
      decide!('approved')
    }
    await run.done
    assert.equal(run.outcome, mode === 'busy' ? 'stopped' : 'completed')
    if (mode === 'approval')
      assert.equal(
        await readFile(join(f.f.scope.projectRoot, 'approval.txt'), 'utf8'),
        'approved exactly once'
      )
  } else if (
    mode === 'late-policy' ||
    mode === 'cancel' ||
    mode === 'disconnect' ||
    mode === 'send-failure'
  ) {
    const name = 'Owned staged title'
    const held = delayNameAck(name)
    const originalRequest = RpcConnection.prototype.request
    const ioFault =
      mode === 'send-failure'
        ? mock.method(
            RpcConnection.prototype,
            'request',
            function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
              if (command.type === 'set_session_name' && command.name === name)
                return Promise.reject(new Error('synthetic metadata write EIO'))
              return originalRequest.call(this, command, options)
            }
          )
        : undefined
    let restored = false
    const restoreMocks = (): void => {
      if (!restored) {
        restored = true
        ioFault?.mock.restore()
        held.restore()
      }
    }
    const releaseAfterFresh = mode === 'cancel' || mode === 'disconnect'
    try {
      const pending = renameSession(phiOnlySessionPath(f.phi.sessionId), name)
      const rejected = assert.rejects(pending, (error: unknown) =>
        mode === 'late-policy'
          ? error instanceof RuntimeReferenceError && error.code === 'STALE_GENERATION'
          : error instanceof Error &&
            /closed|disposed|ended|cancel|disconnect|generation|metadata|RPC|abort|EIO/.test(
              error.message
            )
      )
      if (mode === 'send-failure') await rejected
      else await held.acknowledged
      assert.equal(findPhiSessionById(f.phi.sessionId)!.title, name)
      if (mode !== 'send-failure') assert.equal((await cliState(f.channels[0])).sessionName, name)
      if (mode !== 'send-failure')
        await assert.rejects(
          renameSession(phiOnlySessionPath(f.phi.sessionId), 'concurrent name'),
          /idle/
        )
      assert.equal(findPhiSessionById(f.phi.sessionId)!.title, name)
      if (mode === 'late-policy')
        updateSessionManifest(f.phi.sessionId, { title: 'Newer desired title' })
      else if (mode === 'cancel') await proxy.dispose()
      else if (mode === 'disconnect') await f.channels[0].close()
      if (mode !== 'late-policy') await rejected
      if (!releaseAfterFresh) {
        held.release()
        await rejected
        restoreMocks()
      }
      const desired = mode === 'late-policy' ? 'Newer desired title' : name
      assert.equal(findPhiSessionById(f.phi.sessionId)!.title, desired)
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
        originalRef.ompSessionId
      )
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        originalRef.journalBasename
      )
      assert.equal(f.engine.sessions.has(proxy.runtimeSessionId), false)
      f.resume()
      const fresh = await createProxy()
      const freshRef = JSON.stringify(findPhiSessionById(f.phi.sessionId)!.runtimeRef)
      const freshPrivate = (await f.privateDirectories())[0]
      if (releaseAfterFresh) {
        await f.leases[0].closed
        await f.tunnels[0].closed
        let freshLeaseClosed = false,
          freshTunnelClosed = false
        void f.leases.at(-1)!.closed.then(() => {
          freshLeaseClosed = true
        })
        void f.tunnels.at(-1)!.closed.then(() => {
          freshTunnelClosed = true
        })
        assert.equal(f.engine.sessions.has(fresh.runtimeSessionId), true)
        held.release()
        await new Promise<void>((resolve) => setImmediate(resolve))
        restoreMocks()
        assert.equal(JSON.stringify(findPhiSessionById(f.phi.sessionId)!.runtimeRef), freshRef)
        assert.equal(f.engine.sessions.has(fresh.runtimeSessionId), true)
        assert.equal(freshLeaseClosed, false)
        assert.equal(freshTunnelClosed, false)
        assert.equal(await f.exists(freshPrivate), true)
      }
      assert.equal(f.f.session.closed, false)
      assert.equal((await cliState(f.channels.at(-1)!)).sessionName, desired)
      assert.equal(f.provider.requests.length, 0)
      await assert.rejects(
        proxy.sessionManager.setSessionName('stale driver name'),
        /idle|显式恢复/
      )
      assert.equal(findPhiSessionById(f.phi.sessionId)!.title, desired)
      await fresh.dispose()
    } finally {
      held.release()
      restoreMocks()
    }
  } else {
    const name = 'Reviewed Phi 中文 name'
    await renameSession(
      phiOnlySessionPath(f.phi.sessionId),
      ' \u0000Reviewed   Phi 中文\nname\u0085 '
    )
    assert.equal((await cliState(f.channels[0])).sessionName, name)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.title, name)
    for (const invalid of ['', '\u0000\u007f', 'x'.repeat(4097), '\ud800'])
      await assert.rejects(renameSession(phiOnlySessionPath(f.phi.sessionId), invalid), /name|UTF8/)
    assert.equal(findPhiSessionById(f.phi.sessionId)!.title, name)
    assert.equal(f.provider.requests.length, 0)
    await proxy.dispose()
    f.resume()
    const fresh = await createProxy()
    assert.equal((await cliState(f.channels.at(-1)!)).sessionName, name)
    assert.equal(
      findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
      originalRef.ompSessionId
    )
    assert.equal(
      findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
      originalRef.journalBasename
    )
    assert.equal(f.provider.requests.length, 0)
    await fresh.dispose()
    const local = createPhiSession({
      kind: 'ordinary',
      cwd: params.cwd,
      cwdRealPath: params.cwd,
      permissionMode: 'auto'
    })
    await renameSession(phiOnlySessionPath(local.sessionId), 'Legacy local name')
    assert.equal(findPhiSessionById(local.sessionId)!.title, 'Legacy local name')
  }
  await proxy.dispose()
} catch (error) {
  primaryFailed = true
  throw error
} finally {
  try {
    await f.close()
  } catch (error) {
    cleanupFailure = error
  }
}
if (!primaryFailed && cleanupFailure) throw cleanupFailure
