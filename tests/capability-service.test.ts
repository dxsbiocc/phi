import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { isEnabled, setEnabled } from '../src/main/agent/enablement'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  createCapabilityService,
  type CapabilityApprovalRequest,
  type CapabilityServiceDependencies
} from '../src/main/agent/packages/capability-service'
import {
  installPackages,
  listInstalledPackages,
  planInstall,
  type LocalRegistry,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'
import { runPackageMutation } from '../src/main/agent/packages/mutation-queue'

const context = { originSessionId: 'session-a', agentRunId: 'run-a', toolCallId: 'call-a' }
const session = { runtimeSessionId: 'session-a' }
const silentLogger = { info: (): void => undefined, warn: (): void => undefined }

function fixture(): {
  root: string
  agentDir: string
  registry: LocalRegistry
  deps: CapabilityServiceDependencies
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-capability-service-'))
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  mkdirSync(registryDir)
  const registry: LocalRegistry = {
    id: registryDir,
    dir: registryDir,
    trust: 'imported',
    schemaVersion: 1,
    generatedAt: '2026-10-16T00:00:00.000Z',
    packages: []
  }
  const deps: CapabilityServiceDependencies = {
    agentDir,
    appVersion: '0.1.0',
    loadRegistries: async () => ({ registries: [registry], errors: [] }),
    confirm: async () => true
  }
  return {
    root,
    agentDir,
    registry,
    deps,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function metadata(
  type: RegistryPackageEntry['type'],
  id: string,
  version = '1.0.0'
): RegistryPackageEntry {
  return {
    type,
    id,
    version,
    title: `${id} analysis`,
    summary: 'Analyze scientific data',
    archive: `${id}-${version}.tar.gz`,
    sha256: '0'.repeat(64),
    size: 100,
    dependsOn: []
  }
}

function skill(
  registry: LocalRegistry,
  id: string,
  dependsOn: RegistryPackageEntry['dependsOn'] = []
): RegistryPackageEntry {
  const entry = { ...metadata('skill', id), dependsOn }
  const files = new Map([
    [
      'SKILL.md',
      Buffer.from(`---\nname: ${id}\ndescription: Analyze scientific data\n---\n\n# ${id}\n`)
    ],
    [
      'phi-package.yaml',
      Buffer.from(
        stringifyYaml({
          schemaVersion: 1,
          id,
          type: 'skill',
          version: entry.version,
          title: entry.title,
          summary: entry.summary,
          dependsOn,
          files: 'files.json'
        })
      )
    ]
  ])
  const archive = createDeterministicTarGz([
    ...[...files].map(([path, data]) => ({ path, data })),
    {
      path: 'files.json',
      data: Buffer.from(
        JSON.stringify({
          version: 1,
          files: [...files].map(([path, data]) => ({ path, size: data.length, sha256: hash(data) }))
        })
      )
    }
  ])
  entry.sha256 = hash(archive)
  entry.size = archive.length
  writeFileSync(join(registry.dir, entry.archive), archive)
  registry.packages.push(entry)
  return entry
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('search exposes all four package types, prefers official sources and their highest version', async () => {
  const f = fixture()
  try {
    const official: LocalRegistry = {
      ...f.registry,
      id: 'phi-official',
      trust: 'official',
      label: 'Phi Packages',
      packages: []
    }
    for (const type of ['wrapper', 'mcp', 'plugin', 'skill'] as const) {
      f.registry.packages.push(metadata(type, `analysis-${type}`, '9.0.0'))
      official.packages.push(
        metadata(type, `analysis-${type}`, '1.0.0'),
        metadata(type, `analysis-${type}`, '2.0.0')
      )
    }
    const service = createCapabilityService({
      ...f.deps,
      loadRegistries: async () => ({ registries: [f.registry, official], errors: [] })
    })
    const result = await service.search({ ...session, query: 'scientific data' }, context)
    assert.equal(result.candidates.length, 4)
    assert.deepEqual(
      new Set(result.candidates.map((item) => item.type)),
      new Set(['wrapper', 'mcp', 'plugin', 'skill'])
    )
    assert(
      result.candidates.every(
        (item) =>
          item.trust === 'official' && item.version === '2.0.0' && !item.installed && !item.enabled
      )
    )
    assert(!existsSync(f.agentDir), 'search must not create application state')
  } finally {
    f.cleanup()
  }
})

test('search forwards the requested package type so MCP discovery can skip other providers', async () => {
  const f = fixture()
  try {
    const loadedTypes: Array<RegistryPackageEntry['type'] | undefined> = []
    const service = createCapabilityService({
      ...f.deps,
      loadRegistries: async (type) => {
        loadedTypes.push(type)
        return { registries: [], errors: [] }
      }
    })
    await service.search({ ...session, query: 'analysis', type: 'mcp' }, context)
    await service.search({ ...session, query: 'analysis', type: 'skill' }, context)
    await service.search({ ...session, query: 'analysis' }, context)
    assert.deepEqual(loadedTypes, ['mcp', 'skill', undefined])
  } finally {
    f.cleanup()
  }
})

test('official API is consulted first and matches signed grouped wrappers while retaining other app matches', async () => {
  const f = fixture()
  try {
    f.registry.trust = 'official'
    f.registry.packages.push(metadata('wrapper', 'module-local-rnaseq'), {
      ...metadata('skill', 'rna-report'),
      summary: 'rna analysis'
    })
    const calls: string[] = []
    const service = createCapabilityService({
      ...f.deps,
      searchOfficial: async () => {
        calls.push('api')
        return { available: true, matches: [{ type: 'wrapper', id: 'module-local-rnaseq-align' }] }
      },
      loadRegistries: async () => {
        calls.push('registry')
        return { registries: [f.registry], errors: [] }
      }
    })
    const result = await service.search({ ...session, query: 'rna' }, context)
    assert.deepEqual(calls, ['api', 'registry'])
    assert.deepEqual(
      result.candidates.map((item) => item.id),
      ['module-local-rnaseq', 'rna-report']
    )
  } finally {
    f.cleanup()
  }
})

test('the fixed website source wins over user sources and accepts semantic API matches without claiming signed trust', async () => {
  const f = fixture()
  try {
    const website: LocalRegistry = {
      ...f.registry,
      id: 'phi-packages',
      kind: 'official',
      label: 'Phi 官网',
      packages: []
    }
    for (const type of ['wrapper', 'mcp', 'plugin', 'skill'] as const) {
      f.registry.packages.push(metadata(type, `analysis-${type}`, '9.0.0'))
      website.packages.push(
        metadata(type, `analysis-${type}`, '1.2.0'),
        metadata(type, `analysis-${type}`, '1.3.0')
      )
    }
    let approval: CapabilityApprovalRequest | undefined
    const service = createCapabilityService({
      ...f.deps,
      confirm: async (request) => {
        approval = request
        return false
      },
      searchOfficial: async () => ({
        available: true,
        matches: website.packages.map(({ type, id }) => ({ type, id }))
      }),
      loadRegistries: async () => ({ registries: [f.registry, website], errors: [] })
    })
    const result = await service.search({ ...session, query: 'Explain protein evolution' }, context)
    assert.equal(result.candidates.length, 4)
    assert(
      result.candidates.every(
        (candidate) =>
          candidate.version === '1.3.0' &&
          candidate.trust === 'imported' &&
          candidate.source === 'Phi 官网'
      )
    )
    assert.equal(result.canFindExternal, false)
    await service.install(
      {
        ...session,
        candidateId: result.candidates[0].candidateId,
        reason: 'Need the website module'
      },
      context
    )
    assert.equal(approval?.trust, 'imported')
    assert.equal(approval?.source, 'Phi 官网')
    assert(!existsSync(f.agentDir))
  } finally {
    f.cleanup()
  }
})

test('website identity requires both the fixed id and official kind for API matching and external fallback', async () => {
  const f = fixture()
  try {
    f.registry.packages.push(metadata('skill', 'analysis-skill'))
    const service = createCapabilityService({
      ...f.deps,
      searchOfficial: async () => ({
        available: true,
        matches: [{ type: 'skill', id: 'analysis-skill' }]
      })
    })
    for (const identity of [
      { id: f.registry.dir, kind: 'official' },
      { id: 'phi-packages', kind: 'directory' }
    ] as const) {
      Object.assign(f.registry, identity)
      const result = await service.search({ ...session, query: 'Protein evolution' }, context)
      assert.equal(result.candidates.length, 0)
      assert.equal(result.canFindExternal, false)
    }
    Object.assign(f.registry, { id: 'phi-packages', kind: 'official' })
    assert.equal(
      (await service.search({ ...session, query: 'Protein evolution' }, context)).candidates.length,
      1
    )
    f.registry.packages = []
    assert.equal(
      (await service.search({ ...session, query: 'Protein evolution' }, context)).canFindExternal,
      true
    )
    const failed = createCapabilityService({
      ...f.deps,
      loadRegistries: async () => ({ registries: [f.registry], errors: ['Phi 官网：unavailable'] })
    })
    assert.equal(
      (await failed.search({ ...session, query: 'Protein evolution' }, context)).canFindExternal,
      false
    )
  } finally {
    f.cleanup()
  }
})

test('external search is allowed only after an empty working official catalog and preserves API notice', async () => {
  const f = fixture()
  try {
    const service = createCapabilityService({
      ...f.deps,
      searchOfficial: async () => ({
        available: false,
        matches: [],
        notice: 'API temporarily unavailable'
      })
    })
    assert.equal(
      (await service.search({ ...session, query: 'missing' }, context)).canFindExternal,
      false
    )
    f.registry.trust = 'official'
    const result = await service.search({ ...session, query: 'missing' }, context)
    assert.equal(result.canFindExternal, true)
    assert.equal(result.notice, 'API temporarily unavailable')
    const errored = createCapabilityService({
      ...f.deps,
      loadRegistries: async () => ({
        registries: [f.registry],
        errors: ['Phi Packages：unavailable']
      })
    })
    assert.equal(
      (await errored.search({ ...session, query: 'missing' }, context)).canFindExternal,
      false
    )
    f.registry.packages.push(metadata('skill', 'existing-skill'))
    assert.equal(
      (await service.search({ ...session, query: 'scientific' }, context)).canFindExternal,
      false
    )
  } finally {
    f.cleanup()
  }
})

test('approval is mandatory and lists exact dependency versions before any preparation or install', async () => {
  const f = fixture()
  try {
    const dependency = skill(f.registry, 'analysis-core')
    const root = skill(f.registry, 'analysis-report', [
      { type: 'skill', id: dependency.id, version: '^1.0.0' }
    ])
    const decision = deferred<boolean>()
    const requested = deferred<CapabilityApprovalRequest>()
    const calls: string[] = []
    let callerCommitChecks = 0
    const service = createCapabilityService({
      ...f.deps,
      confirm: async (request) => {
        calls.push('approval')
        requested.resolve(request)
        return decision.promise
      },
      prepare: async (registry) => {
        calls.push('prepare')
        return registry
      },
      installerOptions: async () => ({
        beforeCommit: () => {
          callerCommitChecks += 1
        }
      }),
      afterInstall: async () => {
        calls.push('refreshed')
      }
    })
    const { candidates } = await service.search({ ...session, query: root.id }, context)
    const installing = service.install(
      {
        ...session,
        candidateId: candidates[0].candidateId,
        reason: 'Create the requested scientific report'
      },
      context
    )
    const approval = await requested.promise
    assert.equal(approval.action, 'install')
    assert.equal(approval.reason, 'Create the requested scientific report')
    assert.deepEqual(
      approval.packages.map((item) => [item.id, item.version, item.alreadyInstalled]),
      [
        [root.id, '1.0.0', false],
        [dependency.id, '1.0.0', false]
      ]
    )
    assert.equal(approval.totalSize, root.size + dependency.size)
    assert.deepEqual(calls, ['approval'])
    assert(!existsSync(f.agentDir))
    decision.resolve(true)
    const result = await installing
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('expected installation')
    assert.equal(result.packages.length, 2)
    assert.equal(
      result.usage.find((item) => item.id === root.id)?.path,
      join(result.packages.find((item) => item.id === root.id)!.dir, 'SKILL.md')
    )
    assert(
      result.packages.every((item) =>
        isEnabled(
          { key: `skill:${item.id}`, source: 'installed-package' },
          { agentDir: f.agentDir, logger: silentLogger }
        )
      )
    )
    assert.deepEqual(calls, ['approval', 'prepare', 'refreshed'])
    assert(callerCommitChecks > 0, 'the service must preserve the caller commit guard')
  } finally {
    f.cleanup()
  }
})

test('denied and pre-cancelled requests never prepare, install, enable or refresh', async () => {
  const f = fixture()
  try {
    skill(f.registry, 'analysis-core')
    const calls: string[] = []
    const service = createCapabilityService({
      ...f.deps,
      confirm: async () => false,
      prepare: async (registry) => {
        calls.push('prepare')
        return registry
      },
      installPackages: async () => {
        calls.push('install')
        return []
      },
      afterInstall: async () => {
        calls.push('refresh')
      }
    })
    const { candidates } = await service.search({ ...session, query: 'analysis' }, context)
    const input = { ...session, candidateId: candidates[0].candidateId, reason: 'Need analysis' }
    assert.equal((await service.install(input, context)).ok, false)
    const abort = new AbortController()
    abort.abort()
    assert.deepEqual(await service.install(input, { ...context, signal: abort.signal }), {
      ok: false,
      installed: false,
      status: 'cancelled',
      message: '安装已取消；请继续使用现有功能'
    })
    assert.deepEqual(calls, [])
    assert(!existsSync(f.agentDir))
  } finally {
    f.cleanup()
  }
})

test('cancellation releases a pending approval without waiting for a user decision', async () => {
  const f = fixture()
  try {
    skill(f.registry, 'analysis-core')
    const requested = deferred<void>()
    const service = createCapabilityService({
      ...f.deps,
      confirm: async () => {
        requested.resolve()
        return new Promise<boolean>(() => {})
      }
    })
    const { candidates } = await service.search({ ...session, query: 'analysis' }, context)
    const abort = new AbortController()
    const installing = service.install(
      { ...session, candidateId: candidates[0].candidateId, reason: 'Need analysis' },
      { ...context, signal: abort.signal }
    )
    await requested.promise
    abort.abort()
    const result = await installing
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 'cancelled')
    assert(!existsSync(f.agentDir))
  } finally {
    f.cleanup()
  }
})

test('unknown, other-session and model supplied installation sources cannot request approval', async () => {
  const f = fixture()
  try {
    skill(f.registry, 'analysis-core')
    let approvals = 0
    const service = createCapabilityService({
      ...f.deps,
      confirm: async () => {
        approvals += 1
        return true
      }
    })
    const { candidates } = await service.search({ ...session, query: 'analysis' }, context)
    const input = { ...session, candidateId: candidates[0].candidateId, reason: 'Need analysis' }
    await assert.rejects(
      service.install({ ...input, runtimeSessionId: 'session-b' }, context),
      /候选无效/
    )
    await assert.rejects(
      service.install({ ...input, candidateId: 'invented' }, context),
      /候选无效/
    )
    await assert.rejects(service.install({ ...input, approved: true }, context), /安装参数无效/)
    await assert.rejects(
      service.install({ ...input, registryDir: f.registry.dir }, context),
      /安装参数无效/
    )
    await assert.rejects(
      service.install({ ...input, url: 'https://example.com/package' }, context),
      /安装参数无效/
    )
    assert.equal(approvals, 0)
    assert(!existsSync(f.agentDir))
  } finally {
    f.cleanup()
  }
})

test('cancellation while waiting for the shared mutation queue prevents preparation and install', async () => {
  const f = fixture()
  const gate = deferred<void>()
  const entered = deferred<void>()
  const held = runPackageMutation(async () => {
    entered.resolve()
    await gate.promise
  })
  try {
    await entered.promise
    skill(f.registry, 'analysis-core')
    const approved = deferred<void>()
    let prepared = false
    const service = createCapabilityService({
      ...f.deps,
      confirm: async () => {
        approved.resolve()
        return true
      },
      prepare: async (registry) => {
        prepared = true
        return registry
      }
    })
    const { candidates } = await service.search({ ...session, query: 'analysis' }, context)
    const abort = new AbortController()
    const installing = service.install(
      { ...session, candidateId: candidates[0].candidateId, reason: 'Need analysis' },
      { ...context, signal: abort.signal }
    )
    await approved.promise
    abort.abort()
    gate.resolve()
    await held
    const result = await installing
    assert.equal(result.ok, false)
    assert.equal(prepared, false)
    assert(!existsSync(f.agentDir))
  } finally {
    gate.resolve()
    await held
    f.cleanup()
  }
})

test('installation rejects an approved plan changed by another package mutation', async () => {
  const f = fixture()
  try {
    const root = skill(f.registry, 'analysis-core')
    let prepared = false
    const service = createCapabilityService({
      ...f.deps,
      confirm: async () => {
        await runPackageMutation(() =>
          installPackages(planInstall(f.registry, root, f.deps), { agentDir: f.agentDir })
        )
        return true
      },
      prepare: async (registry) => {
        prepared = true
        return registry
      }
    })
    const { candidates } = await service.search({ ...session, query: 'analysis' }, context)
    await assert.rejects(
      service.install(
        { ...session, candidateId: candidates[0].candidateId, reason: 'Need analysis' },
        context
      ),
      /审批后发生变化/
    )
    assert.equal(prepared, false)
    assert.equal(listInstalledPackages({ agentDir: f.agentDir }).length, 1)
  } finally {
    f.cleanup()
  }
})

test('an installed same-version skill requires approval and is enabled without reinstalling', async () => {
  const f = fixture()
  try {
    const root = skill(f.registry, 'analysis-core')
    await installPackages(planInstall(f.registry, root, f.deps), { agentDir: f.agentDir })
    setEnabled(`skill:${root.id}`, false, { agentDir: f.agentDir, logger: silentLogger })
    let approval: CapabilityApprovalRequest | undefined
    const service = createCapabilityService({
      ...f.deps,
      confirm: async (request) => {
        approval = request
        return true
      },
      installPackages: async () => {
        throw new Error('must not reinstall')
      }
    })
    const { candidates } = await service.search({ ...session, query: 'analysis' }, context)
    assert.equal(candidates[0].installed, true)
    assert.equal(candidates[0].enabled, false)
    const result = await service.install(
      { ...session, candidateId: candidates[0].candidateId, reason: 'Need analysis' },
      context
    )
    assert.equal(result.ok, true)
    assert.equal(approval?.action, 'enable')
    assert.equal(approval?.totalSize, 0)
    assert(approval?.packages.every((item) => item.alreadyInstalled))
    assert.equal(
      (await service.search({ ...session, query: 'analysis' }, context)).candidates[0].enabled,
      true
    )
  } finally {
    f.cleanup()
  }
})

test('trusted external candidates defer materialization until approval and install through the same service', async () => {
  const f = fixture()
  try {
    skill(f.registry, 'external-analysis')
    const calls: string[] = []
    const service = createCapabilityService({
      ...f.deps,
      confirm: async () => {
        calls.push('approve')
        return true
      }
    })
    const { candidates } = service.rememberExternalCandidates(
      {
        ...session,
        query: 'external',
        registries: [f.registry],
        prepare: async (registry) => {
          calls.push('prepare')
          return registry
        }
      },
      context
    )
    assert.deepEqual(calls, [])
    const result = await service.install(
      {
        ...session,
        candidateId: candidates[0].candidateId,
        reason: 'No app module covers the task'
      },
      context
    )
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['approve', 'prepare'])
  } finally {
    f.cleanup()
  }
})
