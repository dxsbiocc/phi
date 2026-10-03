import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createManagedEnvironmentActions } from '../src/main/agent/environment/actions'
import { readEnvironmentIndex, updateEnvironmentEntry } from '../src/main/agent/envs'
import type { EnvironmentBuilds } from '../src/main/agent/content/environment-builds'
import { installPlugin } from '../src/main/agent/plugins/loader'

const ENV_ID = 'phi-python-0123456789ab'

function fakeBuilds(building = false): EnvironmentBuilds {
  return {
    start: async () => {
      throw new Error('not used')
    },
    list: () =>
      building
        ? [
            {
              envId: ENV_ID,
              ref: 'phi:python@1',
              state: 'building',
              phase: 'create',
              message: 'building',
              startedAt: '2026-10-01T00:00:00.000Z',
              estimate: { packages: 1, cachedPackages: 0 },
              progress: { packages: 1, packagesDone: 0 }
            }
          ]
        : [],
    cancel: () => undefined
  }
}

function actions(
  root: string,
  building = false
): ReturnType<typeof createManagedEnvironmentActions> {
  return createManagedEnvironmentActions({
    root,
    builds: fakeBuilds(building),
    catalog: async () => []
  })
}

function addIndexEntry(
  root: string,
  referrers: string[] = [],
  envId = ENV_ID,
  name = 'phi-python'
): string {
  const prefix = join(root, 'envs', envId)
  mkdirSync(prefix, { recursive: true })
  writeFileSync(join(prefix, 'payload.bin'), Buffer.alloc(37))
  updateEnvironmentEntry(root, envId, {
    name,
    kind: 'base',
    platform: 'darwin-arm64',
    prefix,
    status: 'ready',
    lockSha256: 'a'.repeat(64),
    referrers,
    updatedAt: '2026-10-01T00:00:00.000Z'
  })
  return prefix
}

function writePluginWithoutEnvironments(root: string): string {
  const pluginDir = join(root, 'other-plugin-source')
  const skillDir = join(pluginDir, 'skills', 'other-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'phi-package.yaml'),
    `schemaVersion: 1
id: other-plugin
type: plugin
version: 1.0.0
title: Other plugin
summary: Plugin without a private environment.
toolPrefix: other
components:
  skills: [skills/other-skill]
`
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: other-skill
description: Other plugin fixture.
---
Use the fixture.
`
  )
  return pluginDir
}

test('managed environment actions reject invalid IPC arguments with readable messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-environment-actions-'))
  try {
    await assert.rejects(actions(root).list('relative/project'), /项目目录必须是绝对路径/)
    assert.throws(() => actions(root).build('', undefined), /环境引用不能为空/)
    assert.throws(() => actions(root).build('./environment.yml', undefined), /技能私有路径环境/)
    assert.throws(() => actions(root).build('phi:python@1', undefined, 42), /插件标识无效/)
    await assert.rejects(actions(root).remove('../bad'), /envId 无效/)
    await assert.rejects(actions(root).rebuild('bad'), /envId 无效/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plugin environment builds require the installed owning plugin and remember it for rebuild', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'phi-plugin-environment-actions-'))
  const root = join(temp, 'runtime')
  const agentDir = join(temp, 'agent')
  const starts: Array<{ owner?: string; requestedBy?: string }> = []
  const repairs: Array<{ owner?: string; name: string }> = []
  try {
    const installed = installPlugin(join(process.cwd(), 'resources', 'plugins', 'visualization'), {
      agentDir,
      runtimeRoot: root
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    const other = installPlugin(writePluginWithoutEnvironments(temp), {
      agentDir,
      runtimeRoot: root
    })
    assert.equal(other.ok, true, JSON.stringify(other.errors))

    const builds: EnvironmentBuilds = {
      start: async (descriptor, options) => {
        starts.push({
          owner: descriptor.owner,
          requestedBy: options.requestedBy?.plugin
        })
        return undefined as never
      },
      list: () => [],
      cancel: () => undefined
    }
    const pluginActions = createManagedEnvironmentActions({
      root,
      agentDir,
      builds,
      catalog: async () => [],
      repair: async (options) => {
        repairs.push({ owner: options.owner, name: options.spec.name })
        return undefined as never
      }
    })

    assert.throws(() => pluginActions.build('plugin:viz'), /构建插件私有环境时必须提供插件标识/)
    assert.throws(
      () => pluginActions.build('plugin:viz', undefined, 'other-plugin'),
      /插件 other-plugin 未声明环境 viz/
    )
    assert.throws(
      () => pluginActions.build('plugin:viz', undefined, 'missing-plugin'),
      /找不到已安装插件：missing-plugin/
    )
    assert.throws(
      () => pluginActions.build('phi:python@1', undefined, 'visualization'),
      /插件标识只能用于插件私有环境/
    )

    const built = pluginActions.build('plugin:viz', undefined, 'visualization')
    assert.match(built.envId, /^plugin-visualization-viz-[0-9a-f]{12}$/)
    assert.deepEqual(starts, [{ owner: 'visualization', requestedBy: 'visualization' }])

    await pluginActions.rebuild(built.envId)
    assert.deepEqual(repairs, [{ owner: 'visualization', name: 'viz' }])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('remove refuses referenced and actively building environments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-environment-remove-guard-'))
  try {
    addIndexEntry(root, ['skill:scanpy'])
    await assert.rejects(actions(root).remove(ENV_ID), /仍被引用/)
    await assert.rejects(actions(root, true).remove(ENV_ID), /正在构建/)
    const cleaned = await actions(root, true).clean()
    assert.deepEqual(cleaned.skipped, [{ envId: ENV_ID, reason: 'building' }])
    assert.ok(readEnvironmentIndex(root).environments[ENV_ID])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remove deletes an unreferenced prefix through the runtime removal primitives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-environment-remove-'))
  try {
    const prefix = addIndexEntry(root)
    const result = await actions(root).remove(ENV_ID)
    assert.equal(result.removed, true)
    assert.ok(result.bytesFreed >= 37)
    assert.equal(existsSync(prefix), false)
    assert.equal(readEnvironmentIndex(root).environments[ENV_ID], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clean reports collected prefixes and the bytes they occupied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-environment-clean-'))
  try {
    addIndexEntry(root)
    const orphanId = 'phi-orphan-abcdef012345'
    const orphan = join(root, 'envs', orphanId)
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'orphan.bin'), Buffer.alloc(19))

    const result = await actions(root).clean()
    assert.deepEqual(result.removed, [ENV_ID])
    assert.deepEqual(result.orphans, [orphanId])
    assert.ok(result.bytesFreed >= 56)
    assert.equal(existsSync(orphan), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clean skips the actively building environment and still removes unrelated entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-environment-clean-building-'))
  const removableId = 'phi-r-abcdef012345'
  try {
    const buildingPrefix = addIndexEntry(root)
    const removablePrefix = addIndexEntry(root, [], removableId, 'phi-r')

    const result = await actions(root, true).clean()
    assert.deepEqual(result.removed, [removableId])
    assert.deepEqual(result.skipped, [{ envId: ENV_ID, reason: 'building' }])
    assert.equal(existsSync(buildingPrefix), true)
    assert.equal(existsSync(removablePrefix), false)
    assert.deepEqual(readEnvironmentIndex(root).environments[ENV_ID]?.referrers, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
