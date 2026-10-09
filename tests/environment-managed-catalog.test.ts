import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeRuntimePluginFixture } from './helpers/runtimePluginFixture'
import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { listManagedEnvironments } from '../src/main/agent/environment/managed'
import { updateEnvironmentEntry } from '../src/main/agent/envs'
import { writeOverrides } from '../src/main/agent/envs/project-environments'
import { installPlugin, setPluginEnabled } from '../src/main/agent/plugins/loader'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import { copyMinimal, envIdFor } from './helpers/fakeEnvironment'

function addIndexed(
  root: string,
  envId: string,
  name: string,
  options: { status?: 'ready' | 'failed'; referrers?: string[] } = {}
): string {
  const prefix = join(root, 'envs', envId)
  mkdirSync(join(prefix, '.phi'), { recursive: true })
  writeFileSync(join(prefix, 'payload.bin'), Buffer.alloc(11))
  updateEnvironmentEntry(root, envId, {
    name,
    kind: 'base',
    platform: 'darwin-arm64',
    prefix,
    status: options.status ?? 'ready',
    lockSha256: 'a'.repeat(64),
    referrers: options.referrers ?? [],
    updatedAt: '2026-10-01T00:00:00.000Z'
  })
  return prefix
}

test('managed catalog includes shared phi-r, project overrides, and orphaned environments', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'phi-managed-catalog-'))
  const root = join(temp, 'runtime')
  const environmentsDir = join(temp, 'official')
  const agentDir = join(temp, 'agent')
  const projectDir = join(temp, 'project')
  try {
    mkdirSync(projectDir, { recursive: true })
    copyMinimal(join(environmentsDir, 'phi-python'), 'phi-python')
    copyMinimal(join(environmentsDir, 'phi-nextflow'), 'phi-nextflow')
    copyMinimal(join(environmentsDir, 'phi-r'), 'phi-r')
    const installed = installPlugin(writeRuntimePluginFixture(temp), {
      agentDir,
      runtimeRoot: root,
      platform: 'darwin-arm64'
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    copyMinimal(join(projectDir, '.phi', 'environments', 'r-x1'), 'r-x1')
    writeOverrides(projectDir, { 'phi:r@1': 'project:r-x1' })

    const pythonDescriptor = describeEnvironment('phi:python@1', {
      environmentsDir,
      platform: 'darwin-arm64'
    })
    const pythonId = envIdFor(pythonDescriptor)
    const pythonPrefix = addIndexed(root, pythonId, 'phi-python', {
      referrers: ['skill:scanpy']
    })
    writeFileSync(join(pythonPrefix, '.phi', 'env.json'), JSON.stringify({ status: 'drifted' }))

    const projectDescriptor = describeEnvironment('project:r-x1', {
      environmentsDir,
      projectDir,
      platform: 'darwin-arm64'
    })
    const projectId = envIdFor(projectDescriptor)
    addIndexed(root, projectId, 'r-x1')

    const orphanId = 'plugin-old-plot-0123456789ab'
    addIndexed(root, orphanId, 'old-plot', { status: 'failed' })

    const rDescriptor = describeEnvironment('phi:r@1', {
      environmentsDir,
      platform: 'darwin-arm64'
    })
    const rBuild: EnvironmentBuild = {
      envId: envIdFor(rDescriptor),
      ref: 'phi:r@1',
      state: 'building',
      phase: 'create',
      message: 'building',
      startedAt: '2026-10-01T00:00:00.000Z',
      estimate: { packages: 1, cachedPackages: 0 },
      progress: { packages: 1, packagesDone: 0 }
    }
    const staleFailedBuild: EnvironmentBuild = {
      envId: projectId,
      ref: 'project:r-x1',
      state: 'failed',
      phase: 'failed',
      message: 'old repair failed',
      error: 'old repair failed',
      startedAt: '2026-09-30T00:00:00.000Z',
      finishedAt: '2026-09-30T00:01:00.000Z',
      estimate: { packages: 1, cachedPackages: 0 },
      progress: { packages: 1, packagesDone: 0 }
    }

    const catalog = await listManagedEnvironments({
      root,
      environmentsDir,
      agentDir,
      projectDir,
      platform: 'darwin-arm64',
      builds: [rBuild, staleFailedBuild],
      sizeOf: async () => 123,
      consumers: [
        { ref: 'phi:python@1', consumer: { kind: 'skill', name: 'scanpy' } },
        {
          ref: 'phi:r@1',
          pluginId: 'visualization',
          consumer: { kind: 'agent', name: 'Visualization' }
        }
      ]
    })

    assert.equal(catalog.length, 5)
    const byRef = new Map(catalog.map((entry) => [entry.ref, entry]))
    const python = byRef.get('phi:python@1')
    assert.equal(python?.source, 'official')
    assert.equal(python?.state, 'drifted')
    assert.equal(python?.sizeBytes, 123)
    assert.deepEqual(python?.referrers, ['skill:scanpy'])
    assert.deepEqual(
      python?.consumers.map((consumer) => `${consumer.kind}:${consumer.name}`).sort(),
      ['kernel:phi-python', 'skill:scanpy']
    )

    const nextflow = byRef.get('phi:nextflow@1')
    assert.equal(nextflow?.state, 'absent')
    assert.ok(nextflow?.estimate?.remainingBytes)
    assert.equal(nextflow?.consumers[0]?.kind, 'wrapper')

    const r = byRef.get('phi:r@1')
    assert.equal(r?.source, 'official')
    assert.equal(r?.state, 'building')
    assert.deepEqual(r?.consumers, [])

    const project = byRef.get('project:r-x1')
    assert.equal(project?.source, 'project')
    assert.equal(project?.state, 'ready')
    assert.equal(project?.error, undefined)
    assert.deepEqual(project?.overrideFrom, ['phi:r@1'])
    assert.ok(project?.consumers.some((consumer) => consumer.name === 'Visualization'))

    const orphan = byRef.get(`orphaned:${orphanId}`)
    assert.equal(orphan?.source, 'orphaned')
    assert.equal(orphan?.state, 'failed')
    assert.equal(orphan?.sizeBytes, 123)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('managed catalog does not add a private environment for the disabled visualization plugin', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'phi-managed-disabled-plugin-'))
  const root = join(temp, 'runtime')
  const agentDir = join(temp, 'agent')
  const environmentsDir = join(temp, 'official')
  try {
    copyMinimal(join(environmentsDir, 'phi-r'), 'phi-r')
    const installed = installPlugin(writeRuntimePluginFixture(temp), {
      agentDir,
      runtimeRoot: root,
      platform: 'darwin-arm64'
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    const disabled = setPluginEnabled('visualization', false, { agentDir, runtimeRoot: root })
    assert.equal(disabled.ok, true, JSON.stringify(disabled.errors))

    const catalog = await listManagedEnvironments({
      root,
      agentDir,
      environmentsDir,
      platform: 'darwin-arm64',
      consumers: []
    })
    assert.equal(
      catalog.some((entry) => entry.source === 'plugin'),
      false
    )
    assert.equal(
      catalog.some((entry) => entry.label === 'viz'),
      false
    )
    assert.equal(
      catalog.some((entry) => entry.ref === 'phi:r@1'),
      true
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
