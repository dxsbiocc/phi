import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDesktopProjectMemoryAdapter,
  retireDesktopProjectMemoryAdapters
} from '../src/main/agent/engine/rpc/desktop-project-memory-adapter'
import { projectMemoryWorkerEnvironment } from '../src/main/agent/engine/rpc/desktop-project-memory-env'
import { buildProjectLearnTool } from '../src/main/agent/memory/learn-tool'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
test('project retirement rejects a pending old-policy memory factory before it can register', async () => {
  const creating = deferred<unknown>()
  let released = 0,
    closed = 0
  const bridge = {
    retainResourceWorker: () => ({
      signal: new AbortController().signal,
      release: () => {
        released++
      }
    }),
    async request<T>(method: string): Promise<T> {
      if (method === 'memory.desktopCreate') return (await creating.promise) as T
      if (method === 'memory.desktopClose') closed++
      return undefined as T
    }
  }
  const creation = createDesktopProjectMemoryAdapter({
    identity: {
      runtimeSessionId: 'pending-runtime',
      sessionId: 'pending-session',
      projectId: 'pending-project',
      cwd: '/srv/project'
    },
    agentDir: '/private/agent',
    resourceCwd: '/private/anchor',
    settings: { enabled: true, learn: true },
    bridge
  })
  await retireDesktopProjectMemoryAdapters('pending-project')
  creating.resolve({ memoryBlock: 'old policy snapshot' })
  await assert.rejects(creation, /generation changed/)
  assert.equal(closed, 1)
  assert.equal(released, 1)
})
test('a simultaneous memory factory cannot escape a project retirement while close is draining', async () => {
  const closing = deferred<unknown>()
  let creates = 0
  const bridge = {
    retainResourceWorker: () => ({ signal: new AbortController().signal, release: () => {} }),
    async request<T>(method: string): Promise<T> {
      if (method === 'memory.desktopCreate') {
        creates++
        return {} as T
      }
      if (method === 'memory.desktopClose') return (await closing.promise) as T
      return undefined as T
    }
  }
  const options = {
    identity: {
      runtimeSessionId: 'active-runtime',
      sessionId: 'active-session',
      projectId: 'active-project',
      cwd: '/srv/project'
    },
    agentDir: '/private/agent',
    resourceCwd: '/private/anchor',
    settings: { enabled: true, learn: true },
    bridge
  }
  await createDesktopProjectMemoryAdapter(options)
  const retirement = retireDesktopProjectMemoryAdapters('active-project')
  await assert.rejects(createDesktopProjectMemoryAdapter(options), /being retired/)
  assert.equal(creates, 1)
  closing.resolve(undefined)
  await retirement
})
test('learn observes the fifth Phi execute argument before and after its asynchronous writer', async () => {
  const saved = deferred<{ stored: number }>()
  const entered = deferred<AbortSignal | undefined>()
  const tool = buildProjectLearnTool(async (_input, signal) => {
    entered.resolve(signal)
    return saved.promise
  })
  const controller = new AbortController()
  const result = tool.execute(
    'lesson',
    { memory: 'lesson' },
    undefined,
    undefined as never,
    controller.signal
  )
  assert.equal(await entered.promise, controller.signal)
  controller.abort(new Error('binding retired'))
  saved.resolve({ stored: 1 })
  await assert.rejects(result, /binding retired/)
  let called = false
  const pre = buildProjectLearnTool(async () => {
    called = true
    return { stored: 1 }
  })
  await assert.rejects(
    pre.execute('lesson', { memory: 'lesson' }, undefined, undefined as never, controller.signal),
    /binding retired/
  )
  assert.equal(called, false)
})

test('trusted local memory worker inherits custom native auth plus proxy and CA without serializing them', () => {
  const native = {
    PHI_SYNTHETIC_CONFIGURED_MEMORY_KEY: 'synthetic-key-value',
    HTTPS_PROXY: 'http://synthetic-proxy.invalid',
    NO_PROXY: '127.0.0.1,localhost',
    NODE_EXTRA_CA_CERTS: '/private/synthetic-ca.pem',
    PATH: '/synthetic/bin'
  }
  const inherited = projectMemoryWorkerEnvironment(native)
  for (const name of Object.keys(native))
    assert.equal(inherited[name], native[name as keyof typeof native])
  assert.notEqual(inherited, native)
})
