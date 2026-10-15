import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { hashPhiExtensionFiles } from '../../src/main/agent/engine/rpc/extension-deployment/bundle'
import type { PhiExtensionBundle } from '../../src/main/agent/engine/rpc/extension-deployment/types'

export function cursorChildBarrierPaths(directory: string): {
  ready: string
  aborted: string
  release: string
  shutdown: string
} {
  return {
    ready: join(directory, 'ready.json'),
    aborted: join(directory, 'aborted.json'),
    release: join(directory, 'release'),
    shutdown: join(directory, 'shutdown.json')
  }
}

/** Test-only public dequeue observer; the original preparer, queues and cancellation stay intact. */
export function cursorChildBarrierBundle(
  bundle: PhiExtensionBundle,
  directory: string
): PhiExtensionBundle {
  const paths = cursorChildBarrierPaths(directory)
  const observer = `
  const cursorQueuedObservers = new Map()
  pi.on('session_start', (_event, ctx) => {
    if (ctx.agent.kind !== 'sub') return
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id)
    const session = ref?.session
    if (ref?.kind !== 'sub' || session?.sessionManager !== ctx.sessionManager)
      throw new Error('Cursor dequeue observer requires its actual child')
    const agent = session.agent
    let held = false
    let owned
    const matches = (message) => message.role === 'custom' &&
      message.customType === 'cursor-stream-continuation' &&
      typeof message.details?.phiCursorRecovery === 'string'
    const detach = agent.addBeforeQueuedMessageDequeueHook(async (signal) => {
      if (held) return
      const queued = agent.peekFollowUpQueue().filter(matches)
      if (!queued.length) return
      if (queued.length !== 1 || !signal || signal.aborted)
        throw new Error('Cursor dequeue observer requires one live owned continuation')
      held = true
      owned = queued[0]
      const aborted = () => cursorWrite(${JSON.stringify(paths.aborted)}, JSON.stringify({aborted: true}), {mode: 0o600})
      signal.addEventListener('abort', aborted, {once: true})
      cursorWrite(${JSON.stringify(paths.ready)}, JSON.stringify({nativeId: ctx.agent.id, queued: true, ownedCount: queued.length}), {mode: 0o600})
      try {
        while (!cursorExists(${JSON.stringify(paths.release)}))
          await new Promise((resolve) => setTimeout(resolve, 5))
      } finally {
        signal.removeEventListener('abort', aborted)
      }
    })
    cursorQueuedObservers.set(ctx.agent.id, {session, agent, detach, remaining: () =>
      !!owned && agent.peekFollowUpQueue().some((message) => message === owned)})
  })
`
  const shutdown = `
  pi.on('session_shutdown', (_event, ctx) => {
    const state = cursorQueuedObservers.get(ctx.agent.id)
    if (!state || state.session.sessionManager !== ctx.sessionManager) return
    state.detach()
    cursorQueuedObservers.delete(ctx.agent.id)
    cursorWrite(${JSON.stringify(paths.shutdown)}, JSON.stringify({ownedRemaining: state.remaining(), detached: true}), {mode: 0o600})
  })
`
  let patched = false
  const files = bundle.files.map((file) => {
    if (file.path !== 'rpc-entry.ts') return file
    const original = file.bytes.toString('utf8')
    const start = 'const rpcExtension: ExtensionFactory = async (pi) => {'
    const end = '  if (modelMetadata) await createRpcModelSelectionExtension(modelMetadata)(pi)'
    assert.equal(original.split(start).length, 2)
    assert.equal(original.split(end).length, 2)
    const source =
      "import { existsSync as cursorExists, writeFileSync as cursorWrite } from 'node:fs'\n" +
      original.replace(start, start + observer).replace(end, shutdown + end)
    const bytes = Buffer.from(source)
    patched = true
    return { ...file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  assert.equal(patched, true)
  return { ...bundle, files, contentHash: hashPhiExtensionFiles(files) }
}
