import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import {
  buildEnvironment,
  describeEnvironment,
  scriptToolsOf,
  validateSkill
} from '../src/main/agent/content'
import { createSkillHost, type PresentArtifactsRequest } from '../src/main/agent/content/skill-host'
import { currentPlatform, removeTree } from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import { installPlugin } from '../src/main/agent/plugins/loader'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'

const SKILL_DIR = join(
  process.cwd(),
  'resources',
  'plugins',
  'visualization',
  'skills',
  'omics-visualization'
)
const VOLCANO_DATA = join(SKILL_DIR, 'scripts', 'scatter', 'volcano', 'example.tsv')

function withTemp(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-script-tools-'))
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

test('the bundled visualization skill yields four viz script tools for Visualization', async () => {
  const validated = validateSkill(SKILL_DIR, { insidePlugin: true })
  assert.equal(validated.ok, true, JSON.stringify(validated.errors))
  assert.ok(validated.skill)
  const declared = scriptToolsOf(validated.skill, { prefix: 'viz' })
  assert.deepEqual(
    declared.map((tool) => tool.name),
    ['viz_examples', 'viz_route', 'viz_prepare', 'viz_render']
  )
  assert.deepEqual(
    declared.map((tool) => tool.approval),
    ['read', 'read', 'write', 'write']
  )
  assert.deepEqual(
    declared.map((tool) => tool.timeoutSeconds),
    [120, 120, 120, 900]
  )
  const routeArgs = declared[1]?.args.properties as {
    data_path?: { format?: string }
    sidecar_dir?: { format?: string }
  }
  const prepareArgs = declared[2]?.args.properties as { workdir?: { format?: string } }
  const renderArgs = declared[3]?.args.properties as {
    script?: { format?: string }
    inputs?: { items?: { format?: string } }
    output?: { format?: string }
  }
  assert.equal(routeArgs.data_path?.format, 'input-path')
  assert.equal(routeArgs.sidecar_dir?.format, 'input-path')
  assert.equal(prepareArgs.workdir?.format, 'project-path')
  assert.equal(renderArgs.script?.format, 'input-path')
  assert.equal(renderArgs.inputs?.items?.format, 'input-path')
  assert.equal(renderArgs.output?.format, 'project-path')

  await withTemp(async (root) => {
    const agentDir = join(root, 'agent')
    const installed = installPlugin(join(process.cwd(), 'resources', 'plugins', 'visualization'), {
      agentDir,
      runtimeRoot: join(root, 'runtime')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    const skill = installed.plugin?.components.skills[0]
    assert.ok(skill)
    const host = createSkillHost({
      agentDir,
      listSkillDirs: async () => [skill]
    })
    const listed = await host.scriptTools({ cwd: root })
    assert.deepEqual(listed.problems, [])
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['viz_examples', 'viz_route', 'viz_prepare', 'viz_render']
    )
    for (const tool of listed.tools) {
      assert.deepEqual(tool.attachTo, ['Visualization'])
      assert.equal(tool.attachTo.includes('main'), false)
    }

    const { agents } = discoverPhiAgents({
      cwd: join(root, 'project'),
      agentDir,
      bundledDir: join(process.cwd(), 'resources', 'agents'),
      homeDir: join(root, 'home')
    })
    const visualization = agents.find((agent) => agent.name === 'Visualization')
    assert.equal(visualization?.environment, 'plugin:viz')
    assert.equal(visualization?.pluginId, 'visualization')
  })
})

function integrationSkip(): string | false {
  if (process.env.PHI_RUNTIME_INTEGRATION !== '1') {
    return 'network integration: set PHI_RUNTIME_INTEGRATION=1'
  }
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1; integration tests skipped'
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bundled micromamba is unavailable'
    return `${message}; integration tests skipped`
  }
}

test(
  'integration: viz_route, viz_prepare, and viz_render present one figure',
  { timeout: 1_200_000, skip: integrationSkip() },
  async () => {
    const root = realpathSync(createTestRuntimeRoot('viz-script-tools'))
    const project = join(root, 'project')
    mkdirSync(join(project, 'data'), { recursive: true })
    mkdirSync(join(project, 'visualizations'))
    cpSync(VOLCANO_DATA, join(project, 'data', 'example.tsv'))
    const presented: PresentArtifactsRequest[] = []
    try {
      const agentDir = join(root, 'agent')
      const installed = installPlugin(
        join(process.cwd(), 'resources', 'plugins', 'visualization'),
        { agentDir, runtimeRoot: root }
      )
      assert.equal(installed.ok, true, JSON.stringify(installed.errors))
      const installedSkill = installed.plugin?.components.skills[0]
      assert.ok(installedSkill)
      const descriptor = describeEnvironment('plugin:viz', {
        agentDir,
        pluginId: 'visualization',
        platform: currentPlatform()
      })
      await buildEnvironment(root, descriptor)
      const host = createSkillHost({
        runtimeRoot: root,
        agentDir,
        listSkillDirs: async () => [installedSkill],
        presentArtifacts: (request) => {
          presented.push(request)
        }
      })
      const listed = await host.scriptTools({ cwd: project })
      assert.deepEqual(listed.problems, [])
      const routed = await host.scriptTool({
        requestId: 'route',
        cwd: project,
        tool: 'viz_route',
        args: {
          data_path: join(project, 'data', 'example.tsv'),
          purpose: 'volcano plot of differential expression',
          top: 1
        }
      })
      assert.equal('ok' in routed && routed.ok, true, JSON.stringify(routed))
      if (!('ok' in routed) || !routed.ok) return
      const candidates = routed.output.candidates as Array<{ template_id: string }>
      assert.equal(candidates[0]?.template_id, 'scatter-volcano')
      const prepared = await host.scriptTool({
        requestId: 'prepare',
        cwd: project,
        tool: 'viz_prepare',
        args: {
          template_id: 'scatter-volcano',
          workdir: join(project, 'visualizations', 'volcano')
        }
      })
      assert.equal('ok' in prepared && prepared.ok, true, JSON.stringify(prepared))
      if (!('ok' in prepared) || !prepared.ok) return
      const script = prepared.output.script
      assert.equal(typeof script, 'string')
      const rendered = await host.scriptTool({
        requestId: 'render',
        cwd: project,
        tool: 'viz_render',
        args: {
          script,
          inputs: [join(project, 'data', 'example.tsv')],
          output: join(project, 'visualizations', 'volcano', 'volcano.png'),
          timeout_seconds: 240
        },
        runtimeSessionId: 'session-viz',
        toolCallId: 'render-call'
      })
      assert.equal('ok' in rendered && rendered.ok, true, JSON.stringify(rendered))
      if (!('ok' in rendered) || !rendered.ok) return
      assert.deepEqual(rendered.output.artifacts, ['visualizations/volcano/volcano.png'])
      assert.equal(presented.length, 1)
      const artifact = presented[0]?.artifacts[0]
      assert.ok(artifact)
      assert.equal(artifact.descriptor.kind, 'figure')
      assert.equal(artifact.descriptor.figure?.format, 'png')
      assert.equal(artifact.relativePath, 'visualizations/volcano/volcano.png')
    } finally {
      removeTree(root)
    }
  }
)
