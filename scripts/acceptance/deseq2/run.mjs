// Run from Phi with node --import ./scripts/test-loader.mjs scripts/acceptance/deseq2/run.mjs.
// Set PHI_PACKAGES_ROOT and NEXTFLOW_BIN. The optional PHI_QC_NATIVE=1 runs the installed
// Nextflow workflow against the host R + DESeq2 stack and binds the installed tools to local Python.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scientificReport,
  readScientificHandoff
} from '../../../src/main/agent/agents/research-handoff.ts'
import { describeEnvironment } from '../../../src/main/agent/content/environment-refs.ts'
import { createSkillHost } from '../../../src/main/agent/content/skill-host.ts'
import { setEnabled } from '../../../src/main/agent/enablement/index.ts'
import { installPackages } from '../../../src/main/agent/packages/installer.ts'
import { planInstall } from '../../../src/main/agent/packages/planning.ts'
import { readRegistry } from '../../../src/main/agent/packages/registry.ts'
import {
  installPlugin,
  loadedPlugins,
  setPluginEnabled
} from '../../../src/main/agent/plugins/loader.ts'
import { buildAskUserQuestionCustomTools } from '../../../src/main/agent/user-interaction-tools.ts'
import { wrapperRunContinuationPrompt } from '../../../src/main/agent/wrappers/composition/job-continue.ts'
import { formatJobStatus } from '../../../src/main/agent/wrappers/composition/job-format.ts'
import { WrapperJobManager } from '../../../src/main/agent/wrappers/composition/job-manager.ts'
import { materializeWrapperRegistry } from '../../../src/main/agent/wrappers/packages/builder.ts'
import { getWrapperRunsDir, listWrapperRuns } from '../../../src/main/agent/wrappers/store.ts'
import { buildWrapperRunFinishedEvent } from '../../../src/shared/wrapperRunNotice.ts'
import { installReady, shQuote } from '../../../tests/helpers/fakeEnvironment.ts'

const packages = process.env.PHI_PACKAGES_ROOT
const nextflow = process.env.NEXTFLOW_BIN
assert(packages && nextflow, 'Set PHI_PACKAGES_ROOT and NEXTFLOW_BIN.')
const native = process.env.PHI_QC_NATIVE === '1'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-deseq2-acceptance-')))
console.log('Local acceptance workspace:', root)
const project = join(root, 'project')
const agentDir = join(root, 'agent')
const runtimeRoot = native ? join(root, 'runtime') : process.env.PHI_QC_RUNTIME_ROOT
assert(
  runtimeRoot,
  'Set PHI_QC_RUNTIME_ROOT to an installed Phi Python runtime, or use PHI_QC_NATIVE=1.'
)
const environmentsDir = resolve('resources/runtime/environments')
const component = 'modules/local/differential-expression/deseq2'
const id = 'local/modules/differential-expression-deseq2'
const pluginId = 'differential-expression'
const skillHost = createSkillHost({
  agentDir,
  runtimeRoot,
  environmentsDir,
  listSkillDirs: async () =>
    loadedPlugins({ agentDir, projectDir: project }).flatMap((p) => p.components.skills)
})
const evidence = { environment: {}, cases: {} }

function install() {
  const source = join(root, 'wrapper-sources')
  cpSync(join(packages, 'resources/wrappers', component), join(source, component), {
    recursive: true
  })
  const registryDir = join(root, 'registry')
  const { index } = materializeWrapperRegistry({ wrappersRoot: source, outDir: registryDir })
  assert.equal(index.packages.length, 1)
  const packageId = index.packages[0].id
  const plugin = installPlugin(join(packages, 'resources/plugins', pluginId), { agentDir })
  assert.equal(plugin.ok, true, JSON.stringify(plugin.errors))
  assert.equal(setPluginEnabled(pluginId, true, { agentDir }).ok, true)
  setEnabled('wrapper:' + packageId, true, { agentDir })
  return installPackages(
    planInstall(readRegistry(registryDir), { type: 'wrapper', id: packageId }, { agentDir }),
    { agentDir }
  )
}

function prepareRuntime() {
  const directory = dirname(fileURLToPath(import.meta.url))
  mkdirSync(project)
  execFileSync('Rscript', [join(directory, 'fixtures.R'), project])
  if (native) {
    const python = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8'
    }).trim()
    installReady(runtimeRoot, describeEnvironment('phi:python@1', { environmentsDir }), {
      python: 'exec ' + shQuote(python) + ' "$@"'
    })
    evidence.environment.python = execFileSync(python, ['--version'], { encoding: 'utf8' }).trim()
    evidence.environment.r = execFileSync(
      'Rscript',
      ['-e', 'cat(R.version.string, " DESeq2 ", as.character(packageVersion("DESeq2")), sep="")'],
      { encoding: 'utf8' }
    ).trim()
  }
  // Use the actual launcher and workflow. The optional local profile override only disables containers.
  // For the corruption test, modify a genuine published result between process exit and host collection.
  const config = join(root, 'native.config')
  if (native) writeFileSync(config, 'profiles { docker { docker.enabled = false } }\n')
  const launcher = join(root, 'nextflow')
  const prefix = 'export PATH=' + shQuote(dirname(nextflow)) + ':"$PATH"\n'
  const run = shQuote(nextflow) + ' "$@"' + (native ? ' -c ' + shQuote(config) : '')
  writeFileSync(
    launcher,
    [
      '#!/bin/sh',
      'set -eu',
      prefix,
      'if [ "$1" != run ]; then exec ' + shQuote(nextflow) + ' "$@"; fi',
      run,
      'if [ -n "${QC_TEST_CORRUPT_RESULT:-}" ]; then printf "BROKEN_TEST_ROW\\n" >> "$QC_TEST_CORRUPT_RESULT"; fi'
    ].join('\n'),
    { mode: 0o755 }
  )
  evidence.environment.nextflow = execFileSync(launcher, ['-version'], {
    encoding: 'utf8',
    env: { ...process.env, NXF_DISABLE_CHECK_LATEST: 'true' }
  }).match(/version [\d.]+/i)?.[0]
  evidence.environment.profile = native
    ? 'local R + Python, containers disabled for acceptance'
    : 'installed Phi Python and wrapper profile'
  return launcher
}

async function tool(name, args) {
  const result = await skillHost.scriptTool({
    requestId: randomUUID(),
    cwd: project,
    tool: 'de_' + name,
    args
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.doesNotMatch(JSON.stringify(result.output), /BROKEN_TEST_ROW|SYN0001|Log tail:/)
  return result.output
}

async function runWrapper(label, input, corrupt = false) {
  const outdir = join(project, label)
  const results = join(outdir, 'deseq2_differential', 'test.deseq2.results.tsv')
  const manager = new WrapperJobManager({
    agentDir: () => agentDir,
    nextflowLaunch: {
      hostNextflowPath: () => launcher,
      baseEnv: {
        ...process.env,
        NXF_OFFLINE: 'true',
        NXF_ANSI_LOG: 'false',
        ...(corrupt ? { QC_TEST_CORRUPT_RESULT: results } : {})
      }
    }
  })
  let prompt
  manager.onFinish((run, status) => {
    prompt = wrapperRunContinuationPrompt([buildWrapperRunFinishedEvent(run, status)])
  })
  const start = await manager.start({
    id,
    profile: 'docker',
    target: 'local',
    overrides: { ...input, outdir, prefix: 'test' }
  })
  assert(start.ok, JSON.stringify(start))
  const status = await manager.wait(start.status.runId, 300_000)
  assert(prompt, 'The wrapper must notify the parent through its finish event')
  assert.equal(status.logTail, '', 'The tool response details must also exclude the log tail')
  assert.doesNotMatch(
    prompt + formatJobStatus(status),
    /Log tail:|SYN0001|BROKEN_TEST_ROW|DESEQ2_DIFFERENTIAL \(test\)/
  )
  const persisted = new WrapperJobManager({ agentDir: () => agentDir }).statusSync(
    start.status.runId
  )
  const log = readFileSync(
    join(getWrapperRunsDir(agentDir), start.status.runId, 'nextflow.log'),
    'utf8'
  )
  // Only the isolated fixture log is inspected. No raw log content enters the conversation.
  const submitted = [...log.matchAll(/Submitted process > DESEQ2_DIFFERENTIAL\b/g)].length
  return {
    status,
    persisted,
    submitted,
    prompt,
    results,
    qc: results.replace(/results\.tsv$/, 'qc.tsv')
  }
}

const launcher = prepareRuntime()
await install()
const discovered = await skillHost.scriptTools({ cwd: project })
assert.deepEqual(discovered.problems, [])
assert.deepEqual(discovered.tools.map((t) => t.name).sort(), [
  'de_assess',
  'de_ora',
  'de_preflight'
])
evidence.environment.tools = discovered.tools.map((t) => t.name)

const design = {
  sample_id_col: 'sample',
  condition_col: 'condition',
  reference_level: 'control',
  target_level: 'treated'
}
async function preflight(metadata, extra) {
  return tool('preflight', { ...design, metadata, ...extra })
}

const missing = await preflight('no-donor.tsv', { design: 'paired', donor_col: 'donor' })
assert.equal(missing.status, 'needs_input')
// This fixture supplies the specialist's narrative for a known original question.
// The registered plugin supplies the actionable question; the real host validates and forwards it.
const original =
  'Compare treated and control samples from the same donors. Run ORA only on supported hits.'
const blocked = scientificReport(original, 'blocked', {
  missingInputs: ['Sample-to-donor mapping'],
  research: {
    subquestion: 'Can the paired comparison start?',
    answer: 'The metadata do not identify the donor for each sample.',
    interpretation: 'The paired contrast cannot be fitted.',
    rationale: 'The plugin requires the mapping to verify the biological replicate.',
    evidence: ['no-donor.tsv'],
    question: missing.question
  }
})
const restoredQuestion = JSON.parse(
  readScientificHandoff(blocked.text, original, 'blocked').text
).question
assert.deepEqual(restoredQuestion, missing.question)
async function acceptQuestion(payload) {
  let captured
  const [ask] = buildAskUserQuestionCustomTools('fixture-session', async (request) => {
    assert.equal(request.questions.length, 1)
    captured = request.questions[0]
    return {
      requestId: 'fixture-answer',
      answers: [
        {
          questionIndex: 0,
          question: captured.question,
          kind: 'option',
          answer: captured.options[0].label
        }
      ]
    }
  })
  const asked = await ask.execute('fixture-question', { questions: [payload] }, undefined, {
    cwd: project,
    recentUserImages: () => []
  })
  assert(!asked.isError, JSON.stringify(asked))
  assert(captured.options.length >= 2)
  return captured
}
evidence.cases.missingDonor = {
  ...(await acceptQuestion(restoredQuestion)),
  startedDE: listWrapperRuns(agentDir).length,
  normalOraCalls: 0,
  completedORA: Number(existsSync(join(project, 'enrichment.tsv')))
}
assert.equal(
  evidence.cases.missingDonor.startedDE,
  0,
  'The plugin must ask before launching the wrapper'
)

// Even when the specialist preflight is omitted, the installed wrapper must stop before R runs.
for (const supplyColumn of [false, true]) {
  const label = supplyColumn ? 'missing-donor-column' : 'missing-donor-option'
  const stopped = await runWrapper(label, {
    counts: join(project, 'positive.tsv'),
    samplesheet: join(project, 'no-donor.tsv'),
    study_design: 'paired',
    sample_id_col: 'sample',
    contrast_variable: 'condition',
    reference_level: 'control',
    target_level: 'treated',
    ...(supplyColumn ? { donor_col: 'donor' } : {})
  })
  assert.equal(stopped.status.state, 'failed')
  assert.equal(
    stopped.status.researchQc?.disposition,
    'needs_input',
    JSON.stringify(stopped.status)
  )
  assert.equal(stopped.submitted, 0)
  assert.equal(existsSync(stopped.results), false)
  assert.deepEqual(stopped.persisted.researchQc, stopped.status.researchQc)
  assert.match(stopped.prompt, /ask_user_question/)
  evidence.cases[label] = {
    ...(await acceptQuestion(stopped.status.researchQc.question)),
    runId: stopped.status.runId,
    startedDE: stopped.submitted,
    normalOraCalls: 0,
    completedORA: Number(existsSync(join(project, label, 'enrichment.tsv')))
  }
}

for (const kind of ['positive', 'zero', 'corrupt']) {
  const isPaired = kind === 'positive'
  const pre = await preflight(
    'samples.tsv',
    isPaired ? { design: 'paired', donor_col: 'donor' } : { design: 'independent' }
  )
  assert.equal(pre.status, 'ok', JSON.stringify(pre))
  const result = await runWrapper(
    kind,
    {
      ...pre.wrapper_params,
      counts: join(project, kind === 'zero' ? 'zero.tsv' : 'positive.tsv'),
      samplesheet: join(project, 'samples.tsv')
    },
    kind === 'corrupt'
  )
  assert.equal(result.submitted, 1)
  assert.equal(result.status.state, kind === 'corrupt' ? 'failed' : 'completed')
  assert.equal(result.persisted.state, result.status.state)
  if (isPaired) {
    assert.match(
      readFileSync(result.results.replace(/results\.tsv$/, 'model.txt'), 'utf8'),
      /donor/
    )
  }
  const paths = { results: result.results, qc: result.qc }
  const qc = await tool('assess', paths)
  const expected = { positive: 'eligible', zero: 'skip', corrupt: 'invalid' }[kind]
  assert.equal(qc.disposition, expected)
  assert.equal(result.status.researchQc?.disposition, expected)
  assert.deepEqual(
    result.persisted.researchQc,
    result.status.researchQc,
    'Persisted QC must survive a new manager'
  )
  if (kind !== 'corrupt') {
    assert.equal(result.status.researchQc.evaluated, 1400)
    assert.equal(result.status.researchQc.hits, kind === 'positive' ? 50 : 0)
    assert.equal(result.status.researchQc.integrityVerified, true)
  } else {
    assert.equal(result.status.researchQc.reason, 'integrity-mismatch')
  }
  const evidenceFile = join(project, kind, 'enrichment.tsv')
  const oraArgs = { ...paths, gmt: join(project, 'sets.gmt'), out: evidenceFile }
  assert.equal(skillHost.approvalFor('de_ora', oraArgs), 'write')
  // The fixture's original question explicitly authorizes ORA on supported hits.
  // A live model is not used here; exercise the downstream decision each real verdict permits.
  let normalOraCalls = 0
  let guardedAttempt
  if (result.status.state === 'completed' && qc.disposition === 'eligible') {
    normalOraCalls++
    await tool('ora', oraArgs)
    const lines = readFileSync(evidenceFile, 'utf8').trimEnd().split('\n')
    assert(lines.length >= 2, 'ORA must write at least one tested term')
    const columns = lines[0].split('\t')
    const rows = lines
      .slice(1)
      .map((row) =>
        Object.fromEntries(row.split('\t').map((value, index) => [columns[index], value]))
      )
    const signal = rows.find((row) => row.gene_set === 'SIGNAL')
    assert(signal, 'ORA must test the implanted positive gene set')
    assert.equal(Number(signal.overlap), 50)
    // All 50 marked objects are drawn from 1,400, so the upper tail has one term.
    let exactP = 1
    for (let i = 0; i < 50; i++) exactP *= (50 - i) / (1400 - i)
    assert(Math.abs(Number(signal.p_value) / exactP - 1) < 1e-4)
    assert(Math.abs(Number(signal.p_adjust) / (rows.length * exactP) - 1) < 1e-4)
  } else {
    const forbidden = join(project, kind, 'guard-probe.tsv')
    guardedAttempt = await tool('ora', { ...oraArgs, out: forbidden })
    assert.equal(
      existsSync(forbidden),
      false,
      'A direct call with ineligible results must also stop'
    )
  }
  assert.equal(normalOraCalls, kind === 'positive' ? 1 : 0)
  assert.equal(existsSync(evidenceFile), kind === 'positive')
  evidence.cases[kind] = {
    runId: result.status.runId,
    runState: result.status.state,
    startedDE: result.submitted,
    normalOraCalls,
    completedORA: Number(existsSync(evidenceFile)),
    guardedAttempt,
    wrapperQc: result.status.researchQc,
    qc,
    parentPrompt: result.prompt
  }
}
const report = join(root, 'acceptance.json')
writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n')
console.log('Passed four real local plugin cases. Evidence:', report)
