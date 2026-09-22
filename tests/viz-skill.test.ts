import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'

const SKILL_DIR = join(process.cwd(), 'resources', 'skills', 'omics-visualization')
const SKILL = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
const AGENTS_DIR = join(process.cwd(), 'resources', 'agents')

// The skill is read whole by the Visualization agent on every delegation, so what is in it
// is paid for every time. Long, situational material lives in references/ and is read on demand.
const SKILL_BUDGET_BYTES = 16_500

test('SKILL.md stays within its budget', () => {
  assert.ok(
    Buffer.byteLength(SKILL) <= SKILL_BUDGET_BYTES,
    `SKILL.md is ${Buffer.byteLength(SKILL)} bytes; the budget is ${SKILL_BUDGET_BYTES}`
  )
})

test('the long situational sections moved to references, and SKILL.md says when to read them', () => {
  for (const file of ['mis-routes.md', 'multipanel-workflow.md']) {
    assert.ok(existsSync(join(SKILL_DIR, 'references', file)), `references/${file} should exist`)
    assert.match(SKILL, new RegExp(`references/${file.replace('.', '\\.')}`))
  }
  assert.doesNotMatch(SKILL, /^## Easy mis-routes/m)
  assert.doesNotMatch(SKILL, /^## Multi-panel composition/m)
})

test('nothing in the moved sections was lost', () => {
  const misRoutes = readFileSync(join(SKILL_DIR, 'references', 'mis-routes.md'), 'utf-8')
  // Spot checks across the whole span of the original section, first entry to last.
  for (const id of [
    'bar-enrichment-dot',
    'heatmap-corr-dot',
    'heatmap-oncoprint',
    'tree-dendrogram',
    'graph-circular-concentric',
    'scatter-umap-circos',
    'boxplot-differential-bg',
    'ideogram-coverage'
  ]) {
    assert.ok(misRoutes.includes(`\`${id}\``), `mis-routes.md lost ${id}`)
  }
  const multipanel = readFileSync(join(SKILL_DIR, 'references', 'multipanel-workflow.md'), 'utf-8')
  for (const phrase of [
    'necessity test',
    'audit_patchwork_layout()',
    '.layout-audit.json',
    'layouts.yaml'
  ]) {
    assert.ok(multipanel.includes(phrase), `multipanel-workflow.md lost "${phrase}"`)
  }
})

test('the rules that keep figures honest and project-bound are still in SKILL.md', () => {
  assert.match(SKILL, /active Phi project working directory/)
  assert.match(SKILL, /Treat data directories outside the\s+project as read-only inputs/)
  assert.match(SKILL, /Do not copy `references\/`, `references\/palettes\/`, or catalog files/)
  assert.match(SKILL, /Do not invent sample sizes/)
  assert.match(SKILL, /Do not silently filter, aggregate, impute/)
  assert.match(SKILL, /Qualitative\.Safe/)
  assert.match(SKILL, /Do not add a sibling template/)
  assert.match(SKILL, /^## Scientific integrity/m)
  assert.match(SKILL, /^## Delivery/m)
})

test('SKILL.md tells the agent to use the visualization tools, and keeps the manual commands as a fallback', () => {
  for (const tool of ['viz_route', 'viz_prepare', 'viz_render'])
    assert.match(SKILL, new RegExp(tool))
  assert.match(SKILL, /scripts\/route_template\.py/)
  assert.match(SKILL, /qa_single_plot\.py/)
})

test('every relative link in SKILL.md points at a file that exists', () => {
  const links = [...SKILL.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)].map((match) => match[1])
  assert.ok(links.length > 5)
  for (const link of links) {
    assert.ok(
      existsSync(join(SKILL_DIR, dirname(link) === '.' ? '' : '', link)),
      `broken link: ${link}`
    )
  }
})

test('the moved multi-panel workflow links still resolve from its new home', () => {
  const text = readFileSync(join(SKILL_DIR, 'references', 'multipanel-workflow.md'), 'utf-8')
  const links = [...text.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)].map((match) => match[1])
  for (const link of links) {
    assert.ok(
      existsSync(join(SKILL_DIR, 'references', link)),
      `broken link from references/: ${link}`
    )
  }
})

test('the Visualization agent is given the three visualization tools and told how to use them', () => {
  const { agents, diagnostics } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  assert.deepEqual(diagnostics, [])
  const visualization = agents.find((agent) => agent.name === 'Visualization')
  assert.ok(visualization)
  for (const tool of ['viz_route', 'viz_prepare', 'viz_render']) {
    assert.ok(visualization.tools.includes(tool), `Visualization should have ${tool}`)
    assert.match(visualization.systemPrompt, new RegExp(tool))
  }
  assert.ok(
    Buffer.byteLength(visualization.systemPrompt) <= 7_200,
    `the Visualization prompt is ${Buffer.byteLength(visualization.systemPrompt)} bytes`
  )
})
