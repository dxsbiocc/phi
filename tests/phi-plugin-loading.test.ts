import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { ManagedEnvironmentEntry } from '../src/shared/environmentTypes'
import type { PhiPluginListItem } from '../src/shared/phiPluginTypes'
import type { InstalledPackageView } from '../src/shared/packageManagerTypes'
import type { PhiPluginDisplayItem } from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'
import * as pluginHelpers from '../src/renderer/src/features/phi-plugin/lib/phiPlugins'
import { pluginCopy } from '../src/renderer/src/features/phi-plugin/lib/pluginCopy'

test('installed plugin names and verified trust appear before a delayed environment scan', async () => {
  const plugin: PhiPluginListItem = {
    id: 'visualization',
    title: '科研绘图',
    version: '1.0.3',
    summary: 'Original author description',
    enabled: true,
    source: 'local',
    installedAt: '2026-10-08T00:00:00Z',
    directory: '/plugins/visualization',
    agents: [],
    skills: [],
    scriptTools: [],
    environments: [],
    usedEnvironments: [
      { name: 'phi-r', ref: 'phi:r@1', scope: 'builtin', skillNames: [], agentNames: [] }
    ]
  }
  const installed: InstalledPackageView = {
    id: plugin.id,
    title: plugin.title,
    version: plugin.version,
    summary: plugin.summary,
    type: 'plugin',
    dir: plugin.directory,
    installedAt: plugin.installedAt,
    installedBy: 'user',
    registry: 'official',
    sha256: 'a'.repeat(64),
    trust: 'official'
  }
  let finishScan!: (environments: ManagedEnvironmentEntry[]) => void
  const scan = new Promise<ManagedEnvironmentEntry[]>((resolve) => {
    finishScan = resolve
  })
  const slots: unknown[] = []
  const effects: Array<() => void | (() => void)> = []
  const cleanups: Array<() => void> = []
  let cursor = 0
  const react = {
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const index = cursor++
      slots[index] = initial
      return [
        initial,
        (next): void => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
        }
      ]
    },
    useRef(initial: unknown): { current: unknown } {
      return { current: initial }
    },
    useCallback<T>(callback: T): T {
      return callback
    },
    useEffect(effect: () => void | (() => void)): void {
      effects.push(effect)
    }
  }
  const source = ts.transpileModule(
    readFileSync('src/renderer/src/features/phi-plugin/hooks/usePhiPlugins.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const module = { exports: {} as { usePhiPlugins: () => { refresh: () => Promise<void> } } }
  const timers: Array<ReturnType<typeof setTimeout>> = []
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(name: string): unknown {
      if (name === 'react') return react
      if (name === '../lib/phiPlugins') return pluginHelpers
      if (name === '../lib/pluginCopy') return { pluginCopy }
      throw new Error(`Unexpected module ${name}`)
    },
    window: {
      setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
        const timer = setTimeout(callback, 0)
        timers.push(timer)
        return timer
      },
      clearTimeout,
      api: {
        listPhiPlugins: async (): Promise<PhiPluginListItem[]> => [plugin],
        listInstalledPackages: async (): Promise<InstalledPackageView[]> => [installed],
        listManagedEnvironments: (): Promise<ManagedEnvironmentEntry[]> => scan,
        listEnvironmentBuilds: async (): Promise<never[]> => [],
        onEnvironmentBuildsChanged: (): (() => void) => () => undefined
      }
    }
  })
  const controls = module.exports.usePhiPlugins()
  for (const setup of effects) {
    const cleanup = setup()
    if (cleanup) cleanups.push(cleanup)
  }
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const displayed = (): PhiPluginDisplayItem => (slots[0] as PhiPluginDisplayItem[])[0]
  try {
    await settle()
    assert.equal(slots[1], false, 'a pending scan must not leave the installed list loading')
    assert.equal(displayed().title, 'Visualization')
    assert.equal(displayed().trust, 'official')
    assert.equal(displayed().distribution, 'registry')
    assert.equal(displayed().environmentStatuses[0].state, undefined)
    assert.equal(displayed().environmentStatuses[0].envId, undefined)
    let refreshed = false
    void controls.refresh().then(() => {
      refreshed = true
    })
    await settle()
    assert.equal(
      refreshed,
      true,
      'refresh and mutation completion must not wait for environment scans'
    )
    finishScan([
      {
        ref: 'phi:r@1',
        envId: 'r-ready',
        state: 'ready',
        source: 'official',
        referrers: [],
        consumers: []
      }
    ])
    await settle()
    assert.equal(displayed().title, 'Visualization')
    assert.equal(displayed().environmentStatuses[0].state, 'ready')
    assert.equal(displayed().environmentStatuses[0].envId, 'r-ready')
    assert.equal(plugin.title, '科研绘图', 'the original installed manifest stays unchanged')
  } finally {
    for (const cleanup of cleanups) cleanup()
    for (const timer of timers) clearTimeout(timer)
  }
})
