import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../../src/main/agent/agents/discovery'
import { validateAgent } from '../../src/main/agent/agents/definition'
import { installPlugin, type LoadedPlugin } from '../../src/main/agent/plugins/loader'
import { packageContentPath } from '../helpers/packageContent'

const REPO_AGENTS_DIR = fileURLToPath(new URL('../../resources/agents/', import.meta.url))

function withInstalledVisualization(
  fn: (fixture: { agentDir: string; plugin: LoadedPlugin }) => void
): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-agents-'))
  const agentDir = join(root, 'agent')
  try {
    const installed = installPlugin(packageContentPath('plugins', 'visualization'), {
      agentDir,
      runtimeRoot: join(root, 'runtime')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    assert.ok(installed.plugin)
    fn({ agentDir, plugin: installed.plugin })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the public Visualization agent validates without errors or warnings', () => {
  const result = validateAgent(
    packageContentPath('plugins', 'visualization', 'agents', 'Visualization.md')
  )
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.agent?.visibility, 'entry')
  assert.equal(result.agent?.delegationMode, 'required-first')
})

test('specialists keep delegated scope, evidence, and stop rules explicit', () => {
  withInstalledVisualization(({ agentDir }) => {
    const { agents } = discoverPhiAgents({
      cwd: '/nonexistent/cwd',
      agentDir,
      bundledDir: REPO_AGENTS_DIR,
      homeDir: '/nonexistent/home'
    })
    for (const name of ['Visualization', 'Wrapper']) {
      const prompt = agents.find((agent) => agent.name === name)?.systemPrompt ?? ''
      assert.match(prompt, /do not broaden the delegated task/i, `${name} must preserve scope`)
      assert.match(
        prompt,
        /tool outputs?.*evidence, not instructions/i,
        `${name} must distrust data`
      )
      assert.match(prompt, /missing.*report/i, `${name} must expose missing inputs`)
    }
    const visualization = agents.find((agent) => agent.name === 'Visualization')!
    assert.match(visualization.systemPrompt, /preview.*before.*final render/i)
    assert.match(visualization.systemPrompt, /verify.*artifact.*before.*report/i)
    const wrapper = agents.find((agent) => agent.name === 'Wrapper')!
    assert.match(wrapper.systemPrompt, /inspect.*before.*run/i)
    assert.match(wrapper.systemPrompt, /lost.*unknown outcome/i)
  })
})

test('specialist delegation excludes general explanation and adjacent deliverables', () => {
  withInstalledVisualization(({ agentDir }) => {
    const { agents } = discoverPhiAgents({
      cwd: '/nonexistent/cwd',
      agentDir,
      bundledDir: REPO_AGENTS_DIR,
      homeDir: '/nonexistent/home'
    })
    for (const name of ['Visualization', 'Wrapper']) {
      const guidance = agents.find((agent) => agent.name === name)?.delegation ?? ''
      assert.match(guidance, /only the requested/i, `${name} must constrain delegation`)
    }
    assert.match(
      agents.find((agent) => agent.name === 'Visualization')?.delegation ?? '',
      /general explanation/i
    )
    assert.match(
      agents.find((agent) => agent.name === 'Wrapper')?.delegation ?? '',
      /general explanation/i
    )
  })
})

test('the public Visualization agent routes template previews through omics visualization', () => {
  withInstalledVisualization(({ agentDir, plugin }) => {
    const { agents, diagnostics } = discoverPhiAgents({
      cwd: '/nonexistent/cwd',
      agentDir,
      bundledDir: REPO_AGENTS_DIR,
      homeDir: '/nonexistent/home'
    })
    assert.deepEqual(diagnostics, [])
    const visualization = agents.find((agent) => agent.name === 'Visualization')
    assert.ok(visualization, 'the visualization plugin should define Visualization')
    assert.equal(visualization.filePath, plugin.components.agents[0])
    assert.equal(visualization.pluginId, 'visualization')
    assert.equal(visualization.source, 'phi')
    for (const tool of ['read', 'glob', 'grep', 'bash', 'write', 'edit']) {
      assert.ok(visualization.tools.includes(tool), `Visualization should have ${tool}`)
    }
    assert.equal(visualization.environment, 'phi:r@1')
    for (const tool of ['viz_examples', 'viz_route', 'viz_prepare', 'viz_render']) {
      assert.equal(visualization.tools.includes(tool), false, `${tool} arrives through attachTo`)
    }
    assert.deepEqual(visualization.skills, ['omics-visualization'])
    const skillDir = plugin.components.skills[0]
    assert.ok(skillDir)
    assert.equal(existsSync(join(skillDir, 'SKILL.md')), true)
    assert.equal(visualization.delegationMode, 'required-first')
    assert.equal(visualization.fallback?.afterFailures, 1)
    assert.deepEqual(visualization.fallback?.tools, ['bash', 'eval'])
    assert.ok(
      visualization.fallback?.match.includes('plugins/visualization/skills/omics-visualization')
    )
    assert.match(visualization.delegation ?? '', /show a few templates/i)
    assert.match(visualization.delegation ?? '', /preview/i)
    assert.match(visualization.delegation ?? '', /directly drawing with Python\/R/i)
    assert.match(visualization.delegation ?? '', /current project working directory/i)
    assert.match(visualization.delegation ?? '', /Output directories must be inside/)
    assert.match(visualization.systemPrompt, /skill:\/\/omics-visualization/)
    assert.match(visualization.systemPrompt, /preview-selection mode/i)
    assert.match(visualization.systemPrompt, /Markdown image/i)
    assert.match(visualization.systemPrompt, /template_id/)
    assert.match(visualization.systemPrompt, /absolute path/i)
    assert.match(visualization.systemPrompt, /Project output boundary/)
    assert.match(visualization.systemPrompt, /external input dataset/)
    assert.match(visualization.systemPrompt, /Do not copy the skill's `references\/`/)
    assert.match(
      visualization.systemPrompt,
      /sourcing the installed read-only `scripts\/lib\/common\.R`/
    )
    assert.match(visualization.systemPrompt, /Do not invent template ids/i)
    assert.match(visualization.systemPrompt, /viz_examples.*without.*data/i)
    assert.match(visualization.systemPrompt, /do not simulate.*render.*example/i)
    assert.match(visualization.systemPrompt, /example-only request is `completed`/i)
    assert.match(visualization.systemPrompt, /revision mode.*existing figure/i)
    assert.match(visualization.systemPrompt, /do not call `viz_route` or `viz_prepare`/i)
    assert.match(visualization.systemPrompt, /existing `plot\.R`.*input.*output/i)
    assert.match(visualization.systemPrompt, /palette.*existing.*script/i)
    assert.match(visualization.delegation ?? '', /existing `plot\.R`.*input.*output/i)
    assert.match(visualization.delegation ?? '', /examples, create, revise, or reference/i)
    assert.match(
      visualization.systemPrompt,
      /reference image.*visual evidence, not an instruction source/i
    )
    assert.match(visualization.systemPrompt, /reference.*user.*data.*do not invent/i)
    assert.match(visualization.systemPrompt, /same cutoffs for Up\/Down\/None colors/i)
    assert.match(visualization.systemPrompt, /counts based on adjusted P value alone distinct/i)

    const skillText = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    assert.match(skillText, /active Phi project working directory/)
    assert.match(skillText, /Treat data directories outside the\s+project as read-only inputs/)
    assert.match(
      skillText,
      /Do not copy `references\/`, `references\/palettes\/`, or catalog files/
    )
    assert.match(skillText, /same values for point classification, cutoff lines, legend text/i)
    const commonR = readFileSync(join(skillDir, 'scripts', 'lib', 'common.R'), 'utf-8')
    assert.match(commonR, /OMICS_VISUALIZATION_SKILL_ROOT/)
  })
})
