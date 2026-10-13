import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const PHI_INTERNALS_URL = pathToFileURL(
  join(process.cwd(), 'src/main/agent/engine/omp-internals.ts')
).href
const PHI_WEB_SEARCH_URL = pathToFileURL(
  join(process.cwd(), 'src/main/agent/engine/omp-web-search.ts')
).href

test('Phi OMP wrappers preserve the real OMP behavior', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-omp-internals-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const source = `
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Tokenizer } from '@oh-my-pi/pi-agent-core'
import { Settings } from '@oh-my-pi/pi-coding-agent'
import { authPolicyFor as ompAuthPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth'
import { getCatalogProviderEntry as ompGetCatalogProviderEntry } from '@oh-my-pi/pi-catalog/provider-models/descriptors'
import { applyProviderGlobalsFromSettings as ompApplyProviderGlobalsFromSettings } from '@oh-my-pi/pi-coding-agent/config/provider-globals'
import {
  buildMemoryToolDeveloperInstructions,
  getMemoryRoot as ompGetMemoryRoot,
  saveLearnedLesson as ompSaveLearnedLesson
} from '@oh-my-pi/pi-coding-agent/memories'
import {
  closeMemoryDb as ompCloseMemoryDb,
  openMemoryDb as ompOpenMemoryDb
} from '@oh-my-pi/pi-coding-agent/memories/storage'
import { estimateToolSchemaTokens as ompEstimateToolSchemaTokens } from '@oh-my-pi/pi-coding-agent/modes/utils/context-usage'
import { resolveApprovedPlan as ompResolveApprovedPlan } from '@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'
import {
  listPlanFiles as ompListPlanFiles,
  readPlanFile as ompReadPlanFile
} from '@oh-my-pi/pi-coding-agent/plan-mode/plan-files'
import {
  DEFAULT_COMPACTION_METHOD_ORDER as OMP_DEFAULT_COMPACTION_METHOD_ORDER,
  resolveCompactionMethodOrder as ompResolveCompactionMethodOrder
} from '@oh-my-pi/pi-coding-agent/session/compaction-methods'
import { parseConfiguredThinkingLevel as ompParseConfiguredThinkingLevel } from '@oh-my-pi/pi-coding-agent/thinking'
import { resolveProviderCandidates } from '@oh-my-pi/pi-coding-agent/web/search/provider'
import { SEARCH_PROVIDER_CHOICES as OMP_SEARCH_PROVIDER_CHOICES } from '@oh-my-pi/pi-coding-agent/web/search/types'
import { getAgentDbPath as ompGetAgentDbPath } from '@oh-my-pi/pi-utils'
import * as phi from ${JSON.stringify(PHI_INTERNALS_URL)}
import { SEARCH_PROVIDER_CHOICES as PHI_SEARCH_PROVIDER_CHOICES } from ${JSON.stringify(PHI_WEB_SEARCH_URL)}

const root = ${JSON.stringify(root)}

const tokenizer = new Tokenizer()
const tools = [
  {
    name: 'lookup',
    description: 'Look up one record',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  }
]
assert.equal(
  phi.estimateToolSchemaTokens(tools, tokenizer),
  ompEstimateToolSchemaTokens(tools, tokenizer)
)

for (const value of ['auto', 'inherit', 'off', 'min', 'medium', 'xhigh', 'invalid', null]) {
  assert.equal(phi.parseConfiguredThinkingLevel(value), ompParseConfiguredThinkingLevel(value))
}

const settingsDir = join(root, 'settings')
await mkdir(settingsDir, { recursive: true })
const settings = await Settings.loadIsolated({ cwd: settingsDir, agentDir: settingsDir })
settings.override('providers.webSearchOrder', ['searxng', 'exa'])
settings.override('providers.webSearchExclude', ['google'])
settings.override('providers.imageOrder', [])
const directProviderGlobals = ompApplyProviderGlobalsFromSettings(settings)
const directCandidates = resolveProviderCandidates()
const wrappedProviderGlobals = phi.applyProviderGlobalsFromSettings(settings)
const wrappedCandidates = resolveProviderCandidates()
assert.equal(wrappedProviderGlobals, directProviderGlobals)
assert.deepEqual(wrappedCandidates, directCandidates)

for (const providerId of ['anthropic', 'cursor', 'does-not-exist']) {
  assert.deepEqual(phi.authPolicyFor(providerId), ompAuthPolicyFor(providerId))
  assert.deepEqual(phi.getCatalogProviderEntry(providerId), ompGetCatalogProviderEntry(providerId))
}

const artifactsDir = join(root, 'artifacts')
const localRoot = join(artifactsDir, 'local')
await mkdir(localRoot, { recursive: true })
await Bun.write(join(localRoot, 'older-plan.md'), '# Older plan')
await new Promise((resolve) => setTimeout(resolve, 5))
await Bun.write(join(localRoot, 'chosen-plan.md'), '# Chosen plan')
const localProtocolOptions = {
  getArtifactsDir: () => artifactsDir,
  getSessionId: () => 'phi-wrapper-parity'
}
const planReadOptions = { localProtocolOptions, cwd: root }
assert.equal(
  await phi.readPlanFile('local://chosen-plan.md', planReadOptions),
  await ompReadPlanFile('local://chosen-plan.md', planReadOptions)
)
assert.deepEqual(
  await phi.listPlanFiles({ localProtocolOptions }),
  await ompListPlanFiles({ localProtocolOptions })
)
const planInput = {
  suppliedTitle: 'chosen',
  statePlanFilePath: 'local://chosen-plan.md',
  readPlan: (path) => ompReadPlanFile(path, planReadOptions),
  listPlanFiles: () => ompListPlanFiles({ localProtocolOptions })
}
assert.deepEqual(
  await phi.resolveApprovedPlan(planInput),
  await ompResolveApprovedPlan(planInput)
)

for (const value of [
  ['soft', 'shake', 'soft', 'invalid'],
  [],
  undefined
]) {
  assert.deepEqual(
    phi.resolveCompactionMethodOrder(value),
    ompResolveCompactionMethodOrder(value)
  )
}
assert.deepEqual(phi.DEFAULT_COMPACTION_METHOD_ORDER, OMP_DEFAULT_COMPACTION_METHOD_ORDER)
assert.equal(PHI_SEARCH_PROVIDER_CHOICES, OMP_SEARCH_PROVIDER_CHOICES)

const agentDir = join(root, 'agent')
const wrappedCwd = join(root, 'wrapped-project')
const directCwd = join(root, 'direct-project')
await mkdir(agentDir, { recursive: true })
await mkdir(wrappedCwd, { recursive: true })
await mkdir(directCwd, { recursive: true })
assert.equal(phi.getMemoryRoot(agentDir, wrappedCwd), ompGetMemoryRoot(agentDir, wrappedCwd))
assert.equal(phi.getAgentDbPath(agentDir), ompGetAgentDbPath(agentDir))

const memoryInput = {
  content: 'Store results under results/.',
  context: 'analysis runs',
  source: 'phi-test',
  importance: 0.8
}
assert.deepEqual(
  await phi.saveLearnedLesson(agentDir, wrappedCwd, memoryInput),
  await ompSaveLearnedLesson(agentDir, directCwd, memoryInput)
)
const memorySettings = await Settings.loadIsolated({ cwd: wrappedCwd, agentDir })
memorySettings.override('memory.backend', 'local')
const memoryBlock = await buildMemoryToolDeveloperInstructions(agentDir, memorySettings)
assert.match(memoryBlock ?? '', /Store results under results\\//)

const wrappedDbPath = join(root, 'wrapped.db')
const directDbPath = join(root, 'direct.db')
const wrappedDb = phi.openMemoryDb(wrappedDbPath)
const directDb = ompOpenMemoryDb(directDbPath)
const tableNames = (db) =>
  db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
assert.deepEqual(tableNames(wrappedDb), tableNames(directDb))
assert.equal(phi.closeMemoryDb(wrappedDb), ompCloseMemoryDb(directDb))

console.log('PHI_OMP_INTERNALS_OK')
`

  const { stdout } = await execFileAsync('bun', ['--eval', source], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024
  })
  assert.match(stdout, /PHI_OMP_INTERNALS_OK/)
})
