import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createCapabilityToolRegistrar,
  createLiveSkillSnapshot,
  installedCapabilitySkillFiles,
  refreshInstalledCapabilities,
  type CapabilityRefreshDependencies
} from '../src/main/agent/engine/in-process/capability-refresh'
import { buildSkillRunTool } from '../src/main/agent/content/skill-tools'
import type { PhiTool } from '../src/main/agent/engine/types'
import { installPlugin } from '../src/main/agent/plugins/loader'
import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import { setEnabled } from '../src/main/agent/enablement'
import { createSpecialistFallbackExtension } from '../src/main/agent/engine/phi-extension/extensions/specialist-fallback'

const installed = {
  ok: true,
  installed: true,
  root: { type: 'plugin', id: 'science-tools' },
  packages: [
    { type: 'skill', id: 'new-analysis' },
    { type: 'mcp', id: 'research' },
    { type: 'mcp', id: 'research' }
  ]
}

function refreshHarness(): { calls: string[]; deps: CapabilityRefreshDependencies } {
  const calls: string[] = []
  return {
    calls,
    deps: {
      reloadResources: async () => {
        calls.push('resources')
      },
      refreshSkills: async () => {
        calls.push('skills')
      },
      refreshTools: async () => {
        calls.push('tools')
      },
      refreshConnector: async (name) => {
        calls.push(`connector:${name}`)
      }
    }
  }
}

test('approved installation refreshes skills, scripts, specialists and connector dependencies in order', async () => {
  const { calls, deps } = refreshHarness()
  await refreshInstalledCapabilities(installed, deps)
  assert.deepEqual(calls, ['resources', 'skills', 'tools', 'connector:research'])
})

test('installing a skill does not reconnect unrelated installed connectors', async () => {
  const { calls, deps } = refreshHarness()
  await refreshInstalledCapabilities(
    {
      ...installed,
      root: { type: 'skill', id: 'new-analysis' },
      usage: [{ type: 'skill', id: 'new-analysis', path: '/packages/new-analysis/SKILL.md' }]
    },
    deps
  )
  assert.deepEqual(calls, ['resources', 'skills', 'tools'])
})

test('denied, cancelled and incomplete installs do not refresh a running session', async () => {
  const { calls, deps } = refreshHarness()
  for (const result of [
    undefined,
    {},
    { ok: true },
    { ok: false, installed: false, status: 'denied' },
    { ok: false, installed: false, status: 'cancelled' }
  ]) {
    await refreshInstalledCapabilities(result, deps)
  }
  assert.deepEqual(calls, [])
  await assert.rejects(refreshInstalledCapabilities(installed, deps, AbortSignal.abort()), {
    name: 'AbortError'
  })
  assert.deepEqual(calls, [])
})

test('cancellation during reload prevents tool and connector activation', async () => {
  const { calls, deps } = refreshHarness()
  const controller = new AbortController()
  deps.reloadResources = async () => {
    calls.push('resources')
    controller.abort()
  }
  await assert.rejects(refreshInstalledCapabilities(installed, deps, controller.signal), {
    name: 'AbortError'
  })
  assert.deepEqual(calls, ['resources'])
})

test('refresh failures preserve the installation outcome and give a useful retry message', async () => {
  const { calls, deps } = refreshHarness()
  deps.refreshTools = async () => {
    throw new Error('script catalog unavailable')
  }
  await assert.rejects(
    refreshInstalledCapabilities(installed, deps),
    /模块已安装.*script catalog unavailable.*重新打开当前会话/
  )
  assert.deepEqual(calls, ['resources', 'skills'])
})

test('the existing SDK skill array and generic skill_run allowance stay live after an install', async () => {
  type Skill = { name: string; source?: string; enabled?: boolean }
  const snapshot = createLiveSkillSnapshot<Skill>((skills) =>
    skills.filter((skill) => skill.enabled !== false)
  )
  snapshot.sync([{ name: 'original' }])
  const sdkSkills = snapshot.skills
  const requests: unknown[] = []
  const skillRun = buildSkillRunTool(
    async (_method, input) => {
      requests.push(input)
      return {
        notReady: {
          ref: 'skill:new-analysis',
          envId: 'pending',
          message: 'environment needs approval'
        }
      }
    },
    { runtimeSessionId: 'current-run', allowedSkills: snapshot.allowedSkills }
  )
  snapshot.sync([
    { name: 'original' },
    { name: 'new-analysis' },
    { name: 'disabled', enabled: false },
    { name: 'remote', source: 'server-project', enabled: false }
  ])
  assert.equal(snapshot.skills, sdkSkills)
  assert.deepEqual(
    sdkSkills.map((skill) => skill.name),
    ['original', 'new-analysis', 'remote']
  )
  await skillRun.execute('call', { skill: 'new-analysis', script: 'run.py' }, undefined, {
    cwd: '/project',
    recentUserImages: () => []
  })
  assert.deepEqual((requests[0] as { allowedSkills: string[] }).allowedSkills, [
    'original',
    'new-analysis',
    'remote'
  ])
  snapshot.sync([{ name: 'original', enabled: false }])
  assert.deepEqual(snapshot.allowedSkills, [])
  assert.deepEqual(sdkSkills, [])
})

function tool(name: string): PhiTool {
  return {
    name,
    label: name,
    description: `Phi ${name}`,
    site: 'host',
    approval: 'read',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    execute: async (_id, input, _update, ctx) => ({
      content: [{ type: 'text', text: JSON.stringify({ input, cwd: ctx.cwd }) }]
    })
  }
}

test('new scripts and plugin specialists activate through the SDK barrier without replacing existing tools', async () => {
  type RuntimeSession = NonNullable<ReturnType<Parameters<typeof createCapabilityToolRegistrar>[0]>>
  type ExtensionApi = Parameters<ReturnType<typeof createCapabilityToolRegistrar>['extension']>[0]
  const registered = new Map<string, Parameters<ExtensionApi['registerTool']>[0]>()
  const active = new Set(['read', 'other_script'])
  let pending = Promise.resolve()
  let barriers = 0
  const session = {
    getAllToolInfos: () => [...active].map((name) => ({ name })),
    getEnabledToolNames: () => [...active],
    runToolRegistryMutation: async (mutation: () => Promise<unknown>) => {
      await pending
      barriers += 1
      return mutation()
    }
  } as unknown as RuntimeSession
  const registrar = createCapabilityToolRegistrar(() => session)
  const api = {
    registerTool(definition: Parameters<ExtensionApi['registerTool']>[0]) {
      registered.set(definition.name, definition)
      pending = pending.then(() => {
        active.add(definition.name)
      })
    }
  } as unknown as ExtensionApi
  await registrar.extension(api)
  await registrar.extension({
    registerTool: () => {
      throw new Error('detached discovery instance')
    }
  } as unknown as ExtensionApi)
  const added = await registrar.register([
    tool('read'),
    tool('other_script'),
    tool('analysis_plot'),
    tool('Research')
  ])
  assert.deepEqual(added, ['analysis_plot', 'Research'])
  assert.equal(barriers, 1)
  assert.deepEqual([...registered.keys()], ['analysis_plot', 'Research'])
  const script = registered.get('analysis_plot')!
  const output = await script.execute(
    'call',
    { value: 'ok', undeclared: 'drop' },
    undefined,
    undefined,
    { sessionManager: { getCwd: () => '/project' } } as never
  )
  const content = output.content[0]
  assert.ok(content?.type === 'text')
  assert.deepEqual(JSON.parse(content.text), { input: { value: 'ok' }, cwd: '/project' })
  assert.equal(script.approval, 'read')
  assert.deepEqual(await registrar.register([tool('analysis_plot')]), [])
})

test('runtime activation must be confirmed before an install reports success', async () => {
  type RuntimeSession = NonNullable<ReturnType<Parameters<typeof createCapabilityToolRegistrar>[0]>>
  type ExtensionApi = Parameters<ReturnType<typeof createCapabilityToolRegistrar>['extension']>[0]
  const registrar = createCapabilityToolRegistrar(
    () =>
      ({
        getAllToolInfos: () => [],
        getEnabledToolNames: () => [],
        runToolRegistryMutation: async (mutation: () => Promise<unknown>) => mutation()
      }) as unknown as RuntimeSession
  )
  await registrar.extension({ registerTool: () => undefined } as unknown as ExtensionApi)
  await assert.rejects(
    registrar.register([tool('analysis_plot')]),
    /尚未在当前任务生效.*analysis_plot/
  )
  await assert.rejects(
    registrar.register([tool('analysis_plot')]),
    /尚未在当前任务生效.*analysis_plot/
  )
  await assert.rejects(registrar.register([tool('Research')], AbortSignal.abort()), {
    name: 'AbortError'
  })
})

test('new plugin skills and specialists respect project enablement and retain their plugin owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-capability-plugins-'))
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'project')
  const source = join(root, 'source')
  const skillDir = join(source, 'skills', 'new-analysis')
  try {
    mkdirSync(join(source, 'agents'), { recursive: true })
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(source, 'phi-package.yaml'),
      `schemaVersion: 1
id: scientific-plugin
type: plugin
version: 1.0.0
title: Scientific plugin
summary: Tests live capability discovery.
toolPrefix: science
components:
  agents: [agents/Research.md]
  skills: [skills/new-analysis]
`
    )
    writeFileSync(
      join(source, 'agents', 'Research.md'),
      `---
name: Research
description: Run the new scientific analysis.
tools: [skill_run]
skills: [new-analysis]
delegationMode: required-first
fallback:
  afterFailures: 2
  tools: [bash]
  match: [analysis]
---
Use the installed analysis skill.
`
    )
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: new-analysis
description: Newly approved scientific skill.
---
Run the scientific analysis.
`
    )
    assert.deepEqual(installedCapabilitySkillFiles(agentDir, projectDir), [])
    const result = installPlugin(source, { agentDir, projectDir })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(installedCapabilitySkillFiles(agentDir, projectDir).length, 1)
    const agents = discoverPhiAgents({ cwd: projectDir, agentDir, homeDir: root }).agents
    assert.equal(agents[0]?.name, 'Research')
    assert.equal(agents[0]?.pluginId, 'scientific-plugin')
    assert.equal(agents[0]?.delegationMode, 'required-first')
    setEnabled('plugin:scientific-plugin', false, { agentDir, projectDir })
    assert.deepEqual(installedCapabilitySkillFiles(agentDir, projectDir), [])
    assert.equal(installedCapabilitySkillFiles(agentDir).length, 1)
    assert.deepEqual(discoverPhiAgents({ cwd: projectDir, agentDir, homeDir: root }).agents, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a running fallback guard observes a newly installed required-first specialist', async () => {
  type Policy = Parameters<typeof createSpecialistFallbackExtension>[0][number]
  type ExtensionApi = Parameters<ReturnType<typeof createSpecialistFallbackExtension>>[0]
  const policies: Policy[] = []
  let handler: (event: { toolName: string; input: unknown }) => Promise<unknown>
  const extension = createSpecialistFallbackExtension(policies, {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => false,
    planExecuteModeActive: () => false,
    proposePlanSteps: async () => ({ content: [] }),
    requestToolApproval: async () => undefined,
    browserApprovalInput: (_id, input) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({
      allowed: false,
      failures: 0,
      reason: 'Research must be delegated first.'
    }),
    environmentBinding: () => undefined,
    hostEnvironment: () => ({})
  })
  await extension({
    on: (_event: string, callback: typeof handler) => {
      handler = callback
    }
  } as unknown as ExtensionApi)
  const event = { toolName: 'bash', input: { command: 'analysis' } }
  assert.equal(await handler!(event), undefined)
  policies.push({
    name: 'Research',
    delegationMode: 'required-first',
    fallback: { afterFailures: 2, tools: ['bash'], match: ['analysis'] }
  })
  assert.deepEqual(await handler!(event), {
    block: true,
    reason: 'Research must be delegated first.'
  })
})
