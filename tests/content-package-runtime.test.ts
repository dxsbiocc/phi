import assert from 'node:assert/strict'
import test from 'node:test'

import type { EnvironmentBuildStartOptions } from '../src/main/agent/content/environment-builds'
import type { EnvironmentDescriptor } from '../src/main/agent/content/environment-refs'
import type { PackageUpdate } from '../src/main/agent/packages/installer'
import type {
  LocalRegistry,
  RegistryPackageEntry
} from '../src/main/agent/packages/installer-types'
import {
  createContentPackageRuntime,
  packageUpdateViews,
  type ContentPackageRuntime,
  type ContentPackageRuntimeOperations
} from '../src/main/agent/packages/content-package-runtime'
import { createInstalledPluginNamespace } from '../src/main/agent/plugins/installed-plugin-namespace'

function entry(type: RegistryPackageEntry['type'], id: string): RegistryPackageEntry {
  return {
    id,
    type,
    version: '1.0.0',
    title: id,
    summary: id,
    archive: `${id}.tgz`,
    sha256: 'a'.repeat(64),
    size: 1,
    dependsOn: []
  }
}

function registry(id: string, packages: RegistryPackageEntry[]): LocalRegistry {
  return {
    id,
    dir: `/registries/${id}`,
    trust: 'official',
    schemaVersion: 1,
    generatedAt: '2026-10-21T00:00:00.000Z',
    packages
  }
}

function contentRuntime(
  operations: ContentPackageRuntimeOperations,
  cache: { current: PackageUpdate[] } = { current: [] }
): ContentPackageRuntime & {
  fetched: string[]
  registryFetch: typeof fetch
  environmentBuildCalls: Array<{
    descriptor: EnvironmentDescriptor
    options: EnvironmentBuildStartOptions
  }>
} {
  const fetched: string[] = []
  const environmentBuildCalls: Array<{
    descriptor: EnvironmentDescriptor
    options: EnvironmentBuildStartOptions
  }> = []
  const registryFetch: typeof fetch = (input) => {
    fetched.push(String(input))
    return Promise.resolve(Response.json({ ok: true }))
  }
  const runtime = createContentPackageRuntime({
    getAgentDir: () => '/agent',
    getAppVersion: () => '0.1.0',
    registryFetch,
    environmentBuilds: {
      start: (descriptor, options) => {
        environmentBuildCalls.push({ descriptor, options })
        return Promise.resolve({} as never)
      }
    },
    configuredStdioTools: () => Promise.resolve(['stdio']),
    replaceCachedPackageUpdates: (updates) => {
      cache.current = updates
    },
    getCachedPackageUpdates: () => cache.current,
    operations
  })
  return { ...runtime, fetched, registryFetch, environmentBuildCalls }
}

test('builds official and known content source options from call-time dependencies', async () => {
  const calls: Array<{ source: 'connector' | 'website'; forceRefresh?: boolean }> = []
  const official = registry('official', [])
  const operations: ContentPackageRuntimeOperations = {
    loadKnownRegistryIndexes: async (options) => ({
      registries: [await options.loadOfficialRegistry!()],
      errors: []
    }),
    syncOfficialConnectorRegistry: async (options) => {
      await options.fetch?.('https://registry.test/connector')
      calls.push({ source: 'connector', forceRefresh: options.forceRefresh })
      return official
    },
    syncPreferredOfficialRegistry: async (options) => {
      await options.fetch?.('https://registry.test/website')
      calls.push({ source: 'website', forceRefresh: options.forceRefresh })
      return official
    },
    listPackageUpdates: () => []
  }
  const support = contentRuntime(operations)

  const sourceOptions = support.officialContentSourceOptions()
  const descriptor: EnvironmentDescriptor = {
    ref: 'mcp:server',
    scope: 'mcp',
    owner: 'server-owner',
    kind: 'package',
    spec: { name: 'server-environment', channels: [], dependencies: [] },
    lockText: '',
    platform: 'linux-x64'
  }
  assert.equal(sourceOptions.agentDir, '/agent')
  assert.equal(sourceOptions.appVersion, '0.1.0')
  assert.equal(sourceOptions.fetch, support.registryFetch)
  assert.deepEqual(
    await sourceOptions.verifyMcpStdio({
      name: 'server',
      entry: {},
      environment: {
        root: '/env',
        agentDir: '/agent'
      }
    }),
    ['stdio']
  )
  await sourceOptions.buildMcpEnvironment(descriptor)
  assert.deepEqual(support.environmentBuildCalls, [
    {
      descriptor,
      options: {
        ref: 'mcp:server',
        requestedBy: { mcp: 'server-owner' }
      }
    }
  ])

  await support.knownContentSourceOptions('mcp', true).loadOfficialRegistry()
  await support.knownContentSourceOptions('skill').loadOfficialRegistry()

  assert.deepEqual(calls, [
    { source: 'connector', forceRefresh: true },
    { source: 'website', forceRefresh: false }
  ])
  assert.deepEqual(support.fetched, [
    'https://registry.test/connector',
    'https://registry.test/website'
  ])
})

test('loads connector and non-MCP website registries while preserving registry errors', async () => {
  const connector = registry('connector', [entry('mcp', 'stdio')])
  const website = registry('website', [entry('mcp', 'http'), entry('skill', 'analysis')])
  const support = contentRuntime({
    loadKnownRegistryIndexes: async (options) => ({
      registries: [await options.loadOfficialRegistry!()],
      errors: ['local warning']
    }),
    syncOfficialConnectorRegistry: () => Promise.resolve(connector),
    syncPreferredOfficialRegistry: () => Promise.resolve(website),
    listPackageUpdates: () => []
  })

  const loaded = await support.loadPackageRegistries()

  assert.equal(loaded.registries[0], connector)
  assert.deepEqual(loaded.registries[1], {
    ...website,
    packages: [entry('skill', 'analysis')]
  })
  assert.deepEqual(loaded.errors, ['local warning'])
})

test('copies update views and refreshes the injected package update cache', async () => {
  const update: PackageUpdate = {
    id: 'analysis',
    type: 'skill',
    title: 'Analysis',
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    registryId: 'website',
    registryPath: '/registries/website',
    trust: 'official'
  }
  const cache = { current: [] as PackageUpdate[] }
  const support = contentRuntime(
    {
      loadKnownRegistryIndexes: () =>
        Promise.resolve({ registries: [registry('connector', [])], errors: [] }),
      syncOfficialConnectorRegistry: () => Promise.resolve(registry('connector', [])),
      syncPreferredOfficialRegistry: () => Promise.resolve(registry('website', [])),
      listPackageUpdates: () => [update]
    },
    cache
  )

  const updates = [update]
  const view = packageUpdateViews(updates)
  assert.notEqual(view, updates)
  assert.deepEqual(view, [update])
  assert.deepEqual(await support.refreshCachedPackageUpdates(), [update])
  assert.deepEqual(cache.current, [update])
})

test('builds the standalone namespace while excluding plugin-owned skills', async () => {
  const pluginOptions: unknown[] = []
  const skillCwds: string[] = []
  const namespace = createInstalledPluginNamespace({
    getAgentDir: () => '/agent',
    getSessionCwd: () => '/session',
    operations: {
      loadedPlugins: (options) => {
        pluginOptions.push(options)
        return [{ components: { skills: ['/plugins/one/skill/SKILL.md'] } }]
      },
      listSkills: (cwd) => {
        skillCwds.push(cwd)
        return Promise.resolve([
          { name: 'plugin-skill', filePath: '/plugins/one/skill/SKILL.md' },
          { name: 'standalone', filePath: '/session/.phi/skills/standalone/SKILL.md' },
          { name: 'invalid', filePath: '/session/.phi/skills/invalid/SKILL.md' }
        ])
      },
      isPathInsideRoot: (root, filePath) => filePath.startsWith(root),
      validateSkill: (dir) => {
        if (dir.endsWith('/invalid')) throw new Error('invalid')
        return { skill: { phi: { toolPrefix: 'standalone' } } }
      },
      discoverPhiAgents: (options) => {
        assert.deepEqual(options, {
          cwd: '/project',
          agentDir: '/agent',
          bundledDir: '/bundled/agents',
          pluginAgentDirs: []
        })
        return { agents: [{ name: 'local-agent' }] }
      },
      getBundledAgentsDir: () => '/bundled/agents'
    }
  })

  assert.deepEqual(await namespace.installedPluginNamespace('/project'), {
    agentNames: ['local-agent'],
    skillNames: ['standalone', 'invalid'],
    toolPrefixes: ['standalone']
  })
  assert.deepEqual(pluginOptions, [{ agentDir: '/agent', projectDir: '/project' }])
  assert.deepEqual(skillCwds, ['/project'])
})

test('uses the current session cwd for a namespace without a project override', async () => {
  const observed: string[] = []
  const namespace = createInstalledPluginNamespace({
    getAgentDir: () => '/agent',
    getSessionCwd: () => '/current',
    operations: {
      loadedPlugins: () => [],
      listSkills: (cwd) => {
        observed.push(cwd)
        return Promise.resolve([])
      },
      isPathInsideRoot: () => false,
      validateSkill: () => ({ skill: undefined }),
      discoverPhiAgents: ({ cwd }) => ({ agents: [{ name: cwd }] }),
      getBundledAgentsDir: () => '/bundled/agents'
    }
  })

  assert.deepEqual(await namespace.installedPluginNamespace(), {
    agentNames: ['/current'],
    skillNames: [],
    toolPrefixes: []
  })
  assert.deepEqual(observed, ['/current'])
})
