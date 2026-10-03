import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  addKnownRegistry,
  BUNDLED_REGISTRY_ID,
  knownRegistriesPath,
  listKnownRegistries,
  loadKnownRegistryIndexes,
  readKnownRegistries,
  registryIdForPath,
  removeKnownRegistry
} from '../src/main/agent/packages/registries'

function sandbox(): { root: string; agentDir: string; registryDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-known-registries-'))
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(
    join(registryDir, 'index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-02T00:00:00.000Z',
      packages: []
    })}\n`
  )
  return { root, agentDir, registryDir }
}

test('persists an added directory registry and reloads it from the agent state', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const added = addKnownRegistry(registryDir, {
      agentDir,
      now: () => new Date('2026-10-02T01:02:03.000Z')
    })
    const expectedId = createHash('sha256').update(registryDir).digest('hex').slice(0, 16)

    assert.deepEqual(added, {
      id: expectedId,
      kind: 'directory',
      path: registryDir,
      addedAt: '2026-10-02T01:02:03.000Z'
    })
    assert.equal(registryIdForPath(registryDir), expectedId)
    assert.match(added.id, /^[a-f0-9]{16}$/)
    assert.deepEqual(readKnownRegistries(agentDir), {
      version: 1,
      registries: [added]
    })
    assert.deepEqual(JSON.parse(readFileSync(knownRegistriesPath(agentDir), 'utf8')), {
      version: 1,
      registries: [added]
    })
    assert.deepEqual(readdirSync(join(agentDir, 'state')), ['registries.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removes a persisted directory registry without touching installed content', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const added = addKnownRegistry(registryDir, { agentDir })
    const installedMarker = join(agentDir, 'packages', 'skill', 'kept', '1.0.0', 'SKILL.md')
    mkdirSync(dirname(installedMarker), { recursive: true })
    writeFileSync(installedMarker, '# Kept\n')

    assert.equal(removeKnownRegistry(added.id, { agentDir }), true)
    assert.deepEqual(readKnownRegistries(agentDir), { version: 1, registries: [] })
    assert.equal(readFileSync(installedMarker, 'utf8'), '# Kept\n')
    assert.equal(removeKnownRegistry(added.id, { agentDir }), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports an invalid state as empty and refuses to overwrite it', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const statePath = knownRegistriesPath(agentDir)
    mkdirSync(join(agentDir, 'state'), { recursive: true })
    const invalid = '{"version":1,"registries":[],"unexpected":true}\n'
    writeFileSync(statePath, invalid)

    const loaded = readKnownRegistries(agentDir)
    assert.equal(loaded.version, 1)
    assert.deepEqual(loaded.registries, [])
    assert.match(loaded.error ?? '', /软件源配置文件无效/)
    assert.throws(() => addKnownRegistry(registryDir, { agentDir }), /请先修复或移走该文件/)
    assert.equal(readFileSync(statePath, 'utf8'), invalid)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validates the persisted file and each directory entry exactly', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const statePath = knownRegistriesPath(agentDir)
    mkdirSync(dirname(statePath), { recursive: true })
    const entry = {
      id: registryIdForPath(registryDir),
      kind: 'directory',
      path: registryDir,
      addedAt: '2026-10-02T01:02:03.000Z'
    }
    const invalidStates = [
      '{',
      JSON.stringify({ version: 2, registries: [] }),
      JSON.stringify({ version: 1, registries: [{ ...entry, unexpected: true }] }),
      JSON.stringify({ version: 1, registries: [{ ...entry, id: '0'.repeat(16) }] }),
      JSON.stringify({ version: 1, registries: [{ ...entry, addedAt: '1' }] }),
      JSON.stringify({ version: 1, registries: [entry, entry] })
    ]

    for (const invalid of invalidStates) {
      writeFileSync(statePath, invalid)
      const loaded = readKnownRegistries(agentDir)
      assert.deepEqual(loaded.registries, [])
      assert.match(loaded.error ?? '', /软件源配置文件无效/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lists the real bundled source tree first with a cached package count and no read error', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const added = addKnownRegistry(registryDir, {
      agentDir,
      now: () => new Date('2026-10-02T01:02:03.000Z')
    })

    const resourcesDir = join(process.cwd(), 'resources')
    const listed = listKnownRegistries({ agentDir, bundledResourcesDir: resourcesDir })
    assert.equal(listed.error, undefined)
    assert.equal(listed.registries[0]?.error, undefined)
    assert.ok((listed.registries[0]?.packageCount ?? 0) > 0)
    assert.deepEqual(listed, {
      registries: [
        {
          id: BUNDLED_REGISTRY_ID,
          kind: 'bundled',
          path: resourcesDir,
          removable: false,
          trust: 'builtin',
          packageCount: listed.registries[0]?.packageCount
        },
        {
          ...added,
          removable: true,
          trust: 'imported',
          packageCount: 0
        }
      ]
    })
    assert.throws(
      () => removeKnownRegistry(BUNDLED_REGISTRY_ID, { agentDir }),
      /内置软件源不能移除/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loads no registry indexes or errors when the user has not added a registry', () => {
  const { root, agentDir } = sandbox()
  try {
    assert.deepEqual(loadKnownRegistryIndexes({ agentDir }), {
      registries: [],
      errors: []
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps a registry in the list with its read error when the directory stops loading', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const added = addKnownRegistry(registryDir, { agentDir })
    unlinkSync(join(registryDir, 'index.json'))

    const listed = listKnownRegistries({
      agentDir,
      bundledResourcesDir: join(process.cwd(), 'resources')
    })
    assert.equal(listed.registries[0]?.id, BUNDLED_REGISTRY_ID)
    const unavailable = listed.registries[1]
    assert.equal(unavailable?.id, added.id)
    assert.equal(unavailable?.path, added.path)
    assert.equal(unavailable?.removable, true)
    assert.equal(unavailable?.trust, undefined)
    assert.equal(unavailable?.packageCount, undefined)
    assert.match(unavailable?.error ?? '', /无法读取本地软件包注册表/)
    assert.deepEqual(readKnownRegistries(agentDir).registries, [added])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts only readable absolute directories and adds each path once', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    assert.throws(() => addKnownRegistry('relative/registry', { agentDir }), /绝对路径/)

    const emptyDir = join(root, 'empty')
    mkdirSync(emptyDir)
    assert.throws(() => addKnownRegistry(emptyDir, { agentDir }), /无法读取本地软件包注册表/)
    assert.deepEqual(readKnownRegistries(agentDir), { version: 1, registries: [] })

    const first = addKnownRegistry(registryDir, {
      agentDir,
      now: () => new Date('2026-10-02T01:02:03.000Z')
    })
    const repeated = addKnownRegistry(registryDir, {
      agentDir,
      now: () => new Date('2027-01-01T00:00:00.000Z')
    })
    assert.deepEqual(repeated, first)
    assert.deepEqual(readKnownRegistries(agentDir).registries, [first])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
