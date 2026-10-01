import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserCapabilities } from '../src/shared/browserTypes'
import type { ProjectLocation } from '../src/shared/projectLocation'
import type { BrowserEngine } from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import {
  BrowserWorkspaceRegistry,
  type BrowserEngineFactoryInput,
  type BrowserWorkspaceOwner
} from '../src/main/browser/browser-workspace-registry'

const capabilities: BrowserCapabilities = {
  presentation: 'native',
  screenshot: true,
  coordinateInput: true,
  semanticInspection: false,
  downloads: false,
  recording: false,
  persistentProfile: false
}

class CountingEngine extends InMemoryBrowserEngine {
  disposeCalls = 0

  override async dispose(): Promise<void> {
    this.disposeCalls += 1
    await super.dispose()
  }
}

function createRegistryHarness(): {
  registry: BrowserWorkspaceRegistry
  calls: BrowserEngineFactoryInput[]
  engines: CountingEngine[]
} {
  const calls: BrowserEngineFactoryInput[] = []
  const engines: CountingEngine[] = []
  const registry = new BrowserWorkspaceRegistry({
    engineFactory: (input) => {
      calls.push(input)
      const engine = new CountingEngine({ capabilities })
      engines.push(engine)
      return engine
    },
    policyContext: { applicationOrigins: ['https://phi.internal'] }
  })
  return { registry, calls, engines }
}

const ordinary: BrowserWorkspaceOwner = { kind: 'ordinary' }

function project(location: ProjectLocation): BrowserWorkspaceOwner {
  return { kind: 'project', location }
}

function local(realPath: string, path = realPath): BrowserWorkspaceOwner {
  return project({ kind: 'local', path, realPath })
}

function ssh(
  hostProfileId: string,
  canonicalRoot: string,
  remoteRoot = canonicalRoot
): BrowserWorkspaceOwner {
  return project({ kind: 'ssh', hostProfileId, canonicalRoot, remoteRoot })
}

const localA = local('/real/projects/alpha', '/display/projects/alpha')

test('creates on demand and returns the stable workspace for one Phi session', async () => {
  const { registry, calls } = createRegistryHarness()
  assert.equal(registry.get('session-1'), undefined)

  const [first, second] = await Promise.all([
    registry.getOrCreate({ sessionId: 'session-1', owner: localA }),
    registry.getOrCreate({ sessionId: 'session-1', owner: localA })
  ])

  assert.equal(first, second)
  assert.equal(registry.get('session-1'), first)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-1')
})

test('keeps different session workspaces and engines isolated while sharing a project partition', async () => {
  const { registry, calls, engines } = createRegistryHarness()
  const first = await registry.getOrCreate({ sessionId: 'session-1', owner: localA })
  const second = await registry.getOrCreate({ sessionId: 'session-2', owner: localA })

  assert.notEqual(first, second)
  assert.notEqual(engines[0], engines[1])
  assert.equal(calls[0].partition, calls[1].partition)
})

test('shares local project partitions by canonical real path and separates different paths', async () => {
  const { registry, calls } = createRegistryHarness()
  await registry.getOrCreate({ sessionId: 'session-1', owner: localA })
  await registry.getOrCreate({
    sessionId: 'session-2',
    owner: local('/real/projects/alpha', '/another/display/path')
  })
  await registry.getOrCreate({
    sessionId: 'session-3',
    owner: local('/real/projects/beta')
  })

  assert.equal(calls[0].partition, calls[1].partition)
  assert.notEqual(calls[0].partition, calls[2].partition)
})

test('normalizes lexical aliases of absolute local real paths', async () => {
  const { registry, calls } = createRegistryHarness()
  await registry.getOrCreate({
    sessionId: 'session-1',
    owner: local('/real/projects/alpha/')
  })
  await registry.getOrCreate({
    sessionId: 'session-2',
    owner: local('/real/projects/shared/../alpha')
  })

  assert.equal(calls[0].partition, calls[1].partition)
})

test('derives stable SSH partitions from host profile and canonical root', async () => {
  const { registry, calls } = createRegistryHarness()
  const owners: BrowserWorkspaceOwner[] = [
    ssh('host-a', '/srv/project', '/display/remote-a'),
    ssh('host-a', '/srv/project', '/different/remote-root'),
    ssh('host-b', '/srv/project'),
    ssh('host-a', '/srv/other')
  ]
  for (const [index, owner] of owners.entries()) {
    await registry.getOrCreate({ sessionId: `session-${index}`, owner })
  }

  assert.equal(calls[0].partition, calls[1].partition)
  assert.notEqual(calls[0].partition, calls[2].partition)
  assert.notEqual(calls[0].partition, calls[3].partition)
})

test('normalizes lexical aliases of absolute SSH canonical roots', async () => {
  const { registry, calls } = createRegistryHarness()
  await registry.getOrCreate({ sessionId: 'session-1', owner: ssh('host-a', '/srv/project/') })
  await registry.getOrCreate({
    sessionId: 'session-2',
    owner: ssh('host-a', '/srv/shared/../project')
  })

  assert.equal(calls[0].partition, calls[1].partition)
})

test('rejects invalid project identity fields before invoking the engine factory', async () => {
  const { registry, calls } = createRegistryHarness()
  const invalidOwners: BrowserWorkspaceOwner[] = [
    local('relative/project'),
    local('/real/project\nsecret'),
    local('/real/project\0secret'),
    ssh('', '/srv/project'),
    ssh('host-a\nother', '/srv/project'),
    ssh('host-a', 'relative/root'),
    ssh('host-a', '/srv/root\0secret')
  ]

  for (const [index, owner] of invalidOwners.entries()) {
    await assert.rejects(
      registry.getOrCreate({ sessionId: `invalid-${index}`, owner }),
      /invalid|absolute|empty/i
    )
  }
  assert.equal(calls.length, 0)
})

test('isolates ordinary session partitions by stable Phi session ID', async () => {
  const { registry, calls } = createRegistryHarness()
  await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  await registry.getOrCreate({ sessionId: 'session-2', owner: ordinary })

  assert.notEqual(calls[0].partition, calls[1].partition)
})

test('uses opaque non-persistent partition strings without raw owner identifiers', async () => {
  const { registry, calls } = createRegistryHarness()
  await registry.getOrCreate({
    sessionId: 'ordinary-secret-session',
    owner: ordinary
  })
  await registry.getOrCreate({
    sessionId: 'local-session',
    owner: local('/Users/private/Secret Project', '/display/private')
  })
  await registry.getOrCreate({
    sessionId: 'ssh-session',
    owner: ssh('production-host', '/secret/root', '/display/remote')
  })

  for (const { partition } of calls) {
    assert.match(partition, /^phi-browser-[a-f0-9]{64}$/)
    assert.equal(partition.startsWith('persist:'), false)
    for (const secret of [
      'ordinary-secret-session',
      '/Users/private/Secret Project',
      'production-host',
      '/secret/root'
    ]) {
      assert.equal(partition.includes(secret), false)
    }
  }
})

test('defensively copies registry policy context before workspace creation', async () => {
  const applicationOrigins = ['https://phi.internal']
  const registry = new BrowserWorkspaceRegistry({
    engineFactory: () => new CountingEngine({ capabilities }),
    policyContext: { applicationOrigins }
  })
  applicationOrigins[0] = 'https://mutated.test'

  const workspace = await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  const result = await workspace.execute(
    { kind: 'human' },
    { type: 'open', requestId: 'open-1', url: 'https://phi.internal/private' }
  )

  assert.equal(result.ok, false)
  if (result.ok) assert.fail('the original application origin must remain blocked')
  assert.equal(result.error.code, 'SCHEME_BLOCKED')
})

test('rejects reuse of one session ID with a conflicting owner identity', async () => {
  const { registry, calls } = createRegistryHarness()
  await registry.getOrCreate({ sessionId: 'session-1', owner: localA })

  await assert.rejects(
    registry.getOrCreate({
      sessionId: 'session-1',
      owner: local('/real/projects/other')
    }),
    /conflicting browser owner/
  )
  assert.equal(calls.length, 1)
})

test('removes a failed factory entry so the session can retry cleanly', async () => {
  let calls = 0
  const registry = new BrowserWorkspaceRegistry({
    engineFactory: (): BrowserEngine => {
      calls += 1
      if (calls === 1) throw new Error('factory failed')
      return new CountingEngine({ capabilities })
    }
  })

  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-1', owner: ordinary }),
    /factory failed/
  )
  assert.equal(registry.get('session-1'), undefined)
  const recovered = await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  assert.equal(registry.get('session-1'), recovered)
  assert.equal(calls, 2)
})

test('disposes one session idempotently and permits recreation after cleanup', async () => {
  const { registry, engines } = createRegistryHarness()
  const first = await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })

  await Promise.all([registry.disposeSession('session-1'), registry.disposeSession('session-1')])
  assert.equal(engines[0].disposeCalls, 1)
  assert.equal(registry.get('session-1'), undefined)

  const recreated = await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  assert.notEqual(recreated, first)
  assert.equal(engines.length, 2)
})

test('does not resurrect a session while concurrent disposal is in flight', async () => {
  let releaseDispose!: () => void
  const disposeGate = new Promise<void>((resolve) => {
    releaseDispose = resolve
  })
  class BlockingDisposeEngine extends CountingEngine {
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      await disposeGate
      await InMemoryBrowserEngine.prototype.dispose.call(this)
    }
  }
  const engine = new BlockingDisposeEngine({ capabilities })
  const registry = new BrowserWorkspaceRegistry({ engineFactory: () => engine })
  await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })

  const firstDispose = registry.disposeSession('session-1')
  const secondDispose = registry.disposeSession('session-1')
  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-1', owner: ordinary }),
    /being disposed/
  )
  assert.equal(engine.disposeCalls, 1)
  releaseDispose()
  await Promise.all([firstDispose, secondDispose])
  assert.equal(engine.disposeCalls, 1)
})

test('disposeSession wins a race with an in-flight engine factory', async () => {
  let resolveFactory!: (engine: CountingEngine) => void
  const factoryResult = new Promise<CountingEngine>((resolve) => {
    resolveFactory = resolve
  })
  const registry = new BrowserWorkspaceRegistry({ engineFactory: () => factoryResult })
  const creating = registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  const disposing = registry.disposeSession('session-1')

  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-1', owner: ordinary }),
    /being disposed/
  )
  const engine = new CountingEngine({ capabilities })
  resolveFactory(engine)
  await assert.rejects(creating, /disposed during creation/)
  await disposing
  assert.equal(engine.disposeCalls, 1)
  assert.equal(registry.get('session-1'), undefined)
})

test('retains a tombstone when pending-factory engine cleanup fails', async () => {
  class FailingDisposeEngine extends InMemoryBrowserEngine {
    disposeCalls = 0
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      throw new Error('pending cleanup failed')
    }
  }
  let resolveFactory!: (engine: FailingDisposeEngine) => void
  const factoryResult = new Promise<FailingDisposeEngine>((resolve) => {
    resolveFactory = resolve
  })
  const registry = new BrowserWorkspaceRegistry({ engineFactory: () => factoryResult })
  const creating = registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  const firstDispose = registry.disposeSession('session-1')
  const engine = new FailingDisposeEngine({ capabilities })
  resolveFactory(engine)

  await assert.rejects(creating, /disposed during creation/)
  await assert.rejects(firstDispose, /pending cleanup failed/)
  await assert.rejects(registry.disposeSession('session-1'), /pending cleanup failed/)
  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-1', owner: ordinary }),
    /being disposed/
  )
  assert.equal(engine.disposeCalls, 1)
  assert.equal(registry.get('session-1'), undefined)
})

test('propagates workspace disposal failure and prevents unsafe recreation', async () => {
  class FailingWorkspaceEngine extends InMemoryBrowserEngine {
    disposeCalls = 0
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      throw new Error('workspace cleanup failed')
    }
  }
  const engine = new FailingWorkspaceEngine({ capabilities })
  const registry = new BrowserWorkspaceRegistry({ engineFactory: () => engine })
  await registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })

  await assert.rejects(registry.disposeSession('session-1'), /workspace cleanup failed/)
  await assert.rejects(registry.disposeSession('session-1'), /workspace cleanup failed/)
  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-1', owner: ordinary }),
    /being disposed/
  )
  assert.equal(engine.disposeCalls, 1)
})

test('disposeAll cleans every workspace once and permanently closes the registry', async () => {
  const { registry, engines } = createRegistryHarness()
  await registry.getOrCreate({ sessionId: 'session-1', owner: localA })
  await registry.getOrCreate({ sessionId: 'session-2', owner: ordinary })

  await Promise.all([registry.disposeAll(), registry.disposeAll()])
  assert.deepEqual(
    engines.map((engine) => engine.disposeCalls),
    [1, 1]
  )
  assert.equal(registry.get('session-1'), undefined)
  assert.equal(registry.get('session-2'), undefined)
  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-3', owner: ordinary }),
    /registry is disposed/
  )
})

test('disposeAll also disposes engines produced by pending factories', async () => {
  let resolveFactory!: (engine: CountingEngine) => void
  const factoryResult = new Promise<CountingEngine>((resolve) => {
    resolveFactory = resolve
  })
  const registry = new BrowserWorkspaceRegistry({ engineFactory: () => factoryResult })
  const creating = registry.getOrCreate({ sessionId: 'session-1', owner: ordinary })
  const disposing = registry.disposeAll()
  const engine = new CountingEngine({ capabilities })
  resolveFactory(engine)

  await assert.rejects(creating, /disposed during creation/)
  await disposing
  assert.equal(engine.disposeCalls, 1)
  await assert.rejects(
    registry.getOrCreate({ sessionId: 'session-2', owner: ordinary }),
    /registry is disposed/
  )
})

test('disposeAll attempts every entry and reports partial cleanup failure', async () => {
  class PartialFailureEngine extends InMemoryBrowserEngine {
    disposeCalls = 0
    constructor(private readonly fail: boolean) {
      super({ capabilities })
    }
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      if (this.fail) throw new Error('partial cleanup failed')
      await super.dispose()
    }
  }
  const good = new PartialFailureEngine(false)
  const bad = new PartialFailureEngine(true)
  const registry = new BrowserWorkspaceRegistry({
    engineFactory: ({ sessionId }) => (sessionId === 'good' ? good : bad)
  })
  await registry.getOrCreate({ sessionId: 'good', owner: ordinary })
  await registry.getOrCreate({ sessionId: 'bad', owner: ordinary })

  await assert.rejects(registry.disposeAll(), /Failed to dispose 1 browser workspace/)
  await assert.rejects(registry.disposeAll(), /Failed to dispose 1 browser workspace/)
  assert.equal(good.disposeCalls, 1)
  assert.equal(bad.disposeCalls, 1)
  assert.equal(registry.get('good'), undefined)
  assert.equal(registry.get('bad'), undefined)
  await assert.rejects(
    registry.getOrCreate({ sessionId: 'new', owner: ordinary }),
    /registry is disposed/
  )
})
