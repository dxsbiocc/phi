import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeEnvironment } from '../../../src/main/agent/content/environment-refs.ts'
import { setEnabled } from '../../../src/main/agent/enablement/index.ts'
import { getRuntimeRoot } from '../../../src/main/agent/envs/runtime.ts'
import {
  installPackages,
  planInstall,
  readRegistry
} from '../../../src/main/agent/packages/installer.ts'
import { installPlugin, setPluginEnabled } from '../../../src/main/agent/plugins/loader.ts'
import { createProject, updateProjectDefaults } from '../../../src/main/agent/projects.ts'
import { materializeWrapperRegistry } from '../../../src/main/agent/wrappers/packages/builder.ts'
import { getWrapperRunsDir } from '../../../src/main/agent/wrappers/store.ts'
import { installReady, shQuote } from '../../../tests/helpers/fakeEnvironment.ts'

const here = dirname(fileURLToPath(import.meta.url))
const environmentsDir = join(here, '../../../resources/runtime/environments')
const component = 'modules/local/differential-expression/deseq2'
const pluginId = 'differential-expression'

function scenarioFiles(project, name) {
  const directory = join(project, name)
  mkdirSync(directory, { recursive: true })
  return {
    counts: join(directory, 'counts.tsv'),
    metadata: join(directory, 'samples.tsv'),
    geneSets: join(directory, 'sets.gmt'),
    outdir: join(directory, 'results'),
    enrichment: join(directory, 'enrichment.tsv')
  }
}

function prepareData(project, env) {
  const paired = scenarioFiles(project, 'paired')
  const zero = scenarioFiles(project, 'zero')
  const staging = mkdtempSync(join(tmpdir(), 'phi-deseq2-inputs-'))
  let corrected
  try {
    execFileSync('Rscript', ['--vanilla', join(here, 'fixtures.R'), staging], { env })
    for (const scenario of [paired, zero])
      copyFileSync(join(staging, 'sets.gmt'), scenario.geneSets)
    copyFileSync(join(staging, 'zero.tsv'), zero.counts)
    copyFileSync(join(staging, 'samples.tsv'), zero.metadata)

    // Opaque paired sample labels prevent deriving donor IDs from filenames or the zero fixture.
    const metadata = readFileSync(zero.metadata, 'utf8')
    const samples = new Map()
    corrected = metadata.replace(/^(?:C|T)\d+(?=\t)/gm, (name) => {
      const opaque = 'sample-' + createHash('sha256').update(name).digest('hex').slice(0, 12)
      samples.set(name, opaque)
      return opaque
    })
    writeFileSync(paired.metadata, corrected.replace(/\t[^\t\n]+$/gm, ''))
    const counts = readFileSync(join(staging, 'positive.tsv'), 'utf8')
    const headerEnd = counts.indexOf('\n')
    const header = counts
      .slice(0, headerEnd)
      .split('\t')
      .map((name) => samples.get(name) ?? name)
    writeFileSync(paired.counts, header.join('\t') + counts.slice(headerEnd))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // The full mapping exists only in the test user's memory until the question is answered.
  function supplyMapping() {
    const path = join(dirname(paired.metadata), 'corrected-samples.tsv')
    writeFileSync(path, corrected, { flag: 'wx', mode: 0o600 })
    return path
  }
  return { paired, zero, supplyMapping }
}

async function installContent(root, agentDir, packagesRoot) {
  const source = join(root, 'wrapper-sources')
  cpSync(join(packagesRoot, 'resources/wrappers', component), join(source, component), {
    recursive: true
  })
  const registry = join(root, 'registry')
  const { index } = materializeWrapperRegistry({ wrappersRoot: source, outDir: registry })
  assert.equal(index.packages.length, 1)
  const id = index.packages[0].id
  await installPackages(
    planInstall(readRegistry(registry), { type: 'wrapper', id }, { agentDir }),
    {
      agentDir
    }
  )
  setEnabled('wrapper:' + id, true, { agentDir })
  const installed = installPlugin(join(packagesRoot, 'resources/plugins', pluginId), { agentDir })
  assert(installed.ok, JSON.stringify(installed.errors))
  const enabled = setPluginEnabled(pluginId, true, { agentDir })
  assert(enabled.ok, JSON.stringify(enabled.errors))
}

function registerProject(agentDir, path, model) {
  // These production APIs take the profile from PI_CODING_AGENT_DIR; keep this section synchronous.
  const prior = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const project = createProject({
      name: 'DESeq2 desktop acceptance',
      workingDirectory: path,
      permissionMode: 'auto'
    })
    if (model) updateProjectDefaults(project.id, { defaultModel: model })
    return project
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prior
  }
}

function nativeEnvironment({ root, home, agentDir, nextflowBin, nextflowCache }) {
  const config = join(root, 'native.config')
  writeFileSync(config, 'profiles { docker { docker.enabled = false } }\n')
  const launcher = join(root, 'nextflow')
  writeFileSync(
    launcher,
    [
      '#!/bin/sh',
      'set -eu',
      'export PATH=' + shQuote(dirname(nextflowBin)) + ':"$PATH"',
      'if [ "$1" != run ]; then exec ' + shQuote(nextflowBin) + ' "$@"; fi',
      'exec ' + shQuote(nextflowBin) + ' "$@" -c ' + shQuote(config),
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  const nxfHome = join(home, '.nextflow')
  mkdirSync(nxfHome)
  // Some standalone launchers need an already-cached JAR. Only copy immutable framework files.
  if (nextflowCache) {
    cpSync(join(nextflowCache, 'framework'), join(nxfHome, 'framework'), { recursive: true })
  }
  const libPaths = execFileSync('Rscript', ['--vanilla', '-e', 'cat(.libPaths(),sep="\\n")'], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
  const env = {
    PATH: root + delimiter + process.env.PATH,
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR || tmpdir(),
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    NEXTFLOW_BIN: launcher,
    NXF_HOME: nxfHome,
    NXF_OFFLINE: 'true',
    NXF_DISABLE_CHECK_LATEST: 'true',
    NXF_ANSI_LOG: 'false',
    R_LIBS: libPaths.join(delimiter),
    R_ENVIRON_USER: '/dev/null',
    R_PROFILE_USER: '/dev/null'
  }
  // Keep the desktop's credential and SSH environment empty. Isolated HOME alone is insufficient.
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    env,
    encoding: 'utf8'
  }).trim()
  installReady(getRuntimeRoot(agentDir), describeEnvironment('phi:python@1', { environmentsDir }), {
    python: [
      'case "${1##*/}" in',
      '  preflight.py|assess.py|ora.py)',
      '    script=${1##*/}; printf "de_%s\\n" "${script%.py}" >> ' +
        shQuote(join(root, 'plugin-calls.log')) +
        ';;',
      'esac',
      'exec ' + shQuote(python) + ' "$@"'
    ].join('\n')
  })
  return env
}

export async function prepareDesktopProfile({
  packagesRoot = process.env.PHI_PACKAGES_ROOT,
  nextflowBin = process.env.NEXTFLOW_BIN,
  nextflowCache = process.env.NXF_HOME,
  tempRoot = tmpdir(),
  model
} = {}) {
  assert(
    packagesRoot && existsSync(packagesRoot),
    'Set PHI_PACKAGES_ROOT to the DESeq2 QC checkout'
  )
  assert(
    nextflowBin && isAbsolute(nextflowBin) && existsSync(nextflowBin),
    'Set NEXTFLOW_BIN to an installed Nextflow executable'
  )
  const root = realpathSync(mkdtempSync(join(tempRoot, 'phi-deseq2-desktop-')))
  const home = join(root, 'home')
  const agentDir = join(home, '.phi')
  const userData = join(root, 'electron-user-data')
  const project = join(root, 'project')
  for (const dir of [agentDir, userData, project]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const env = nativeEnvironment({ root, home, agentDir, nextflowBin, nextflowCache })
  const cases = prepareData(project, env)
  await installContent(root, agentDir, packagesRoot)
  const registered = registerProject(agentDir, project, model)
  return {
    root,
    home,
    agentDir,
    userData,
    env,
    project,
    projectId: registered.id,
    projectName: registered.name,
    runsDir: getWrapperRunsDir(agentDir),
    pluginCallsFile: join(root, 'plugin-calls.log'),
    ...cases
  }
}
