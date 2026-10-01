import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { buildEnvironment, describeEnvironment } from '../src/main/agent/content'
import {
  currentPlatform,
  ensureMambarc,
  ensureRuntimeLayout,
  removeTree,
  type PhiPlatform
} from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import {
  NEXTFLOW_CONDA_CACHE_DIR,
  condaProfileSetup,
  renderCondaProfileConfig,
  withCondaProfileEnv
} from '../src/main/agent/wrappers/composition/conda-profile'
import { runWrapperComposition } from '../src/main/agent/wrappers/composition/executor'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import {
  HOST_UNMANAGED_LABEL,
  NEXTFLOW_ENVIRONMENT_REF,
  hostNextflowRejection,
  insertBeforeSystemDirs,
  resolveNextflowLaunch,
  type NextflowLaunch,
  type NextflowLaunchContext
} from '../src/main/agent/wrappers/composition/nextflow-launch'
import {
  MIN_NEXTFLOW_VERSION,
  isNextflowVersionSupported,
  parseNextflowVersion
} from '../src/main/agent/wrappers/composition/nextflow-version'
import { getWrapperRunsDir, listWrapperRuns } from '../src/main/agent/wrappers/store'
import {
  copyMinimal,
  installReady,
  shQuote,
  shell,
  writeExecutable
} from './helpers/fakeEnvironment'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'
import { FAKE_NEXTFLOW, WRAPPER_ID, bundledEntry, withSandbox } from './helpers/wrapperSandbox'

interface Fixture {
  root: string
  environmentsDir: string
  platform: PhiPlatform
}

function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-managed-nf-')))
  const environmentsDir = join(root, 'environments')
  copyMinimal(join(environmentsDir, 'phi-nextflow'), 'phi-nextflow')
  return body({ root, environmentsDir, platform: currentPlatform() }).finally(() => {
    rmSync(root, { recursive: true, force: true })
  })
}

/** Installs a ready fake `phi:nextflow@1` whose `nextflow` runs `script`. Returns the prefix. */
function installFakeNextflow(fixture: Fixture, script: string): { envId: string; prefix: string } {
  const descriptor = describeEnvironment(NEXTFLOW_ENVIRONMENT_REF, {
    environmentsDir: fixture.environmentsDir,
    platform: fixture.platform
  })
  const envId = installReady(fixture.root, descriptor, { nextflow: script })
  return { envId, prefix: join(fixture.root, 'envs', envId) }
}

function context(fixture: Fixture, extra: NextflowLaunchContext = {}): NextflowLaunchContext {
  return {
    runtimeRoot: fixture.root,
    environmentsDir: fixture.environmentsDir,
    platform: fixture.platform,
    hostNextflowPath: () => undefined,
    ...extra
  }
}

function micromambaAvailable(): string | false {
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    return error instanceof Error ? error.message : 'bundled micromamba is unavailable'
  }
}

// ── versions ─────────────────────────────────────────────────────────────

test('nextflow -version output is parsed and compared against the wrapper minimum', () => {
  const output =
    '\n      N E X T F L O W\n      version 26.04.6 build 12646\n      created 1 Jun 2026\n'
  assert.equal(parseNextflowVersion(output), '26.04.6')
  assert.equal(parseNextflowVersion('N E X T F L O W'), undefined)
  assert.equal(isNextflowVersionSupported('26.04.6'), true)
  assert.equal(isNextflowVersionSupported(MIN_NEXTFLOW_VERSION), true)
  assert.equal(isNextflowVersionSupported('25.03.1'), false)
  assert.equal(isNextflowVersionSupported('24.10.5'), false)
})

test('the host rejection names both the host version and the minimum', () => {
  const message = hostNextflowRejection('/opt/nf/nextflow', '23.10.1')
  assert.match(message, /23\.10\.1/)
  assert.match(message, new RegExp(MIN_NEXTFLOW_VERSION.replace(/\./g, '\\.')))
  assert.match(message, /\/opt\/nf\/nextflow/)
  assert.match(hostNextflowRejection('/opt/nf/nextflow', undefined), /无法报告版本/)
})

// ── host opt-in ──────────────────────────────────────────────────────────

test('a chosen host nextflow at or above the minimum is used and labelled host (unmanaged)', async () => {
  await withFixture(async (fixture) => {
    installFakeNextflow(fixture, shell(['exit 0']))
    const result = await resolveNextflowLaunch(
      context(fixture, {
        hostNextflowPath: () => process.execPath,
        readVersion: () => Promise.resolve('25.10.0'),
        baseEnv: { PATH: '/host/bin', HOME: '/Users/tester' }
      })
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    const launch = result.launch
    assert.equal(launch.source, 'host')
    if (launch.source !== 'host') return
    assert.equal(launch.label, HOST_UNMANAGED_LABEL)
    assert.equal(launch.version, '25.10.0')
    assert.equal(launch.command, process.execPath)
    assert.equal(launch.env.PATH, `${dirname(process.execPath)}:/host/bin`)
    assert.equal(launch.env.NXF_DISABLE_CHECK_LATEST, 'true')
  })
})

test('a too-old host nextflow is rejected with both versions and never falls back', async () => {
  await withFixture(async (fixture) => {
    // A ready managed environment exists; the explicit host choice must still win and fail.
    installFakeNextflow(fixture, shell(['exit 0']))
    const result = await resolveNextflowLaunch(
      context(fixture, {
        hostNextflowPath: () => process.execPath,
        readVersion: () => Promise.resolve('22.10.6')
      })
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /22\.10\.6/)
    assert.match(result.error, /25\.04\.0/)
  })
})

test('a host nextflow whose version cannot be read, or that does not exist, is rejected', async () => {
  await withFixture(async (fixture) => {
    const unreadable = await resolveNextflowLaunch(
      context(fixture, {
        hostNextflowPath: () => process.execPath,
        readVersion: () => Promise.resolve(undefined)
      })
    )
    assert.equal(unreadable.ok, false)
    const missing = await resolveNextflowLaunch(
      context(fixture, { hostNextflowPath: () => join(fixture.root, 'no-such-nextflow') })
    )
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.error, /不存在/)
  })
})

// ── managed default ──────────────────────────────────────────────────────

test('by default nextflow comes from phi:nextflow@1 with the environment variables', async () => {
  await withFixture(async (fixture) => {
    const { envId, prefix } = installFakeNextflow(fixture, shell(['exit 0']))
    const result = await resolveNextflowLaunch(
      context(fixture, {
        baseEnv: {
          PATH: '/host/bin',
          HOME: '/Users/tester',
          PYTHONPATH: '/leak',
          CONDA_PREFIX: '/c'
        }
      })
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok || result.launch.source !== 'managed') throw new Error('expected managed')
    const launch = result.launch
    assert.equal(launch.ref, NEXTFLOW_ENVIRONMENT_REF)
    assert.equal(launch.envId, envId)
    assert.equal(launch.command, join(prefix, 'bin', 'nextflow'))
    assert.equal(launch.env.PATH.startsWith(`${join(prefix, 'bin')}:`), true)
    assert.equal(launch.env.PATH.includes('/host/bin'), false)
    assert.equal(launch.env.PHI_ENV_ID, envId)
    assert.equal(launch.env.HOME, '/Users/tester')
    assert.equal(launch.env.PYTHONPATH, undefined)
    assert.equal(launch.env.CONDA_PREFIX, undefined)
    assert.equal(launch.env.NXF_DISABLE_CHECK_LATEST, 'true')
    assert.equal(launch.runtimeRoot, fixture.root)
  })
})

test('a missing phi:nextflow@1 fails with the gate message instead of using the host', async () => {
  await withFixture(async (fixture) => {
    const result = await resolveNextflowLaunch(context(fixture))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(
      result.error,
      `environment ${NEXTFLOW_ENVIRONMENT_REF} is not ready; the user must build it first`
    )
  })
})

test("the profile's container runtime from the spec host section is put on PATH", async () => {
  await withFixture(async (fixture) => {
    const hostBin = join(fixture.root, 'hostbin')
    writeExecutable(join(hostBin, 'docker'), 'exit 0')
    const specPath = join(fixture.environmentsDir, 'phi-nextflow', 'environment.yml')
    writeFileSync(
      specPath,
      `${readFileSync(specPath, 'utf8')}host:\n  - name: docker\n    candidates:\n      - ${join(hostBin, 'docker')}\n`
    )
    installFakeNextflow(fixture, shell(['exit 0']))
    const docker = await resolveNextflowLaunch(context(fixture, { profile: 'docker' }))
    const conda = await resolveNextflowLaunch(context(fixture, { profile: 'conda' }))
    if (!docker.ok || !conda.ok) throw new Error('expected launches')
    const entries = docker.launch.env.PATH.split(':')
    assert.ok(entries.includes(hostBin))
    assert.ok(entries.indexOf(hostBin) < entries.indexOf('/usr/bin'))
    assert.equal(conda.launch.env.PATH.split(':').includes(hostBin), false)
  })
})

test('container runtime directories go before the system directories, once', () => {
  assert.equal(
    insertBeforeSystemDirs('/env/bin:/usr/bin:/bin', ['/usr/local/bin', '/usr/local/bin']),
    '/env/bin:/usr/local/bin:/usr/bin:/bin'
  )
  assert.equal(insertBeforeSystemDirs('/env/bin:/usr/bin', ['/usr/bin']), '/env/bin:/usr/bin')
})

// ── -profile conda ───────────────────────────────────────────────────────

test('the conda profile config selects micromamba and the runtime cache', () => {
  const setup = condaProfileSetup('/rt', '/bundle/micromamba/darwin-arm64/micromamba')
  assert.equal(setup.cacheDir, join('/rt', NEXTFLOW_CONDA_CACHE_DIR))
  assert.match(setup.config, /^conda \{$/m)
  assert.match(setup.config, /^ {4}useMicromamba = true$/m)
  assert.match(setup.config, /^ {4}cacheDir = '\/rt\/nextflow-conda'$/m)
  assert.deepEqual(setup.env, {
    MAMBA_ROOT_PREFIX: '/rt',
    MAMBARC: '/rt/mambarc',
    MAMBA_NO_BANNER: '1'
  })
  assert.match(renderCondaProfileConfig("/a'b\\c"), /cacheDir = '\/a\\'b\\\\c'/)

  const env = withCondaProfileEnv(
    {
      PATH: '/env/bin:/usr/bin:/bin',
      HOME: '/h',
      CONDA_PREFIX: '/env',
      CONDA_DEFAULT_ENV: 'x',
      CONDARC: '/u/.condarc',
      MAMBA_EXE: '/u/mamba',
      JAVA_HOME: '/env/lib/jvm'
    },
    setup
  )
  assert.equal(env.PATH, '/bundle/micromamba/darwin-arm64:/env/bin:/usr/bin:/bin')
  assert.equal(env.CONDA_PREFIX, undefined)
  assert.equal(env.CONDA_DEFAULT_ENV, undefined)
  assert.equal(env.CONDARC, undefined)
  assert.equal(env.MAMBA_EXE, undefined)
  assert.equal(env.MAMBA_ROOT_PREFIX, '/rt')
  assert.equal(env.MAMBARC, '/rt/mambarc')
  assert.equal(env.JAVA_HOME, '/env/lib/jvm')
  assert.equal(env.HOME, '/h')
})

test(
  'a conda-profile run spawns managed nextflow with the micromamba config and variables',
  { skip: micromambaAvailable() },
  async () => {
    await withSandbox(async (sb) => {
      await withFixture(async (fixture) => {
        const record = join(fixture.root, 'record.txt')
        const script = shell([
          `out=${shQuote(record)}`,
          'echo "ARGS $*" > "$out"',
          'env | sort >> "$out"',
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "-c" ]; then echo "CONFIG $2" >> "$out"; cat "$2" >> "$out"; fi',
          '  shift',
          'done',
          'echo "[SUCCESS] completed=1"'
        ])
        const { envId, prefix } = installFakeNextflow(fixture, script)
        const resolved = await resolveNextflowLaunch(context(fixture, { profile: 'conda' }))
        if (!resolved.ok) throw new Error(resolved.error)
        const result = await runWrapperComposition(
          bundledEntry().wrapperDir,
          { outdir: sb.outdir },
          'conda',
          { launch: resolved.launch }
        )
        assert.equal(result.success, true, result.output)
        const text = readFileSync(record, 'utf8')
        assert.match(
          text,
          /^ARGS run wrapper\/main\.nf -params-file \S+ -profile conda -c \S+conda\.config/m
        )
        assert.match(text, /useMicromamba = true/)
        assert.match(text, new RegExp(`cacheDir = '${join(fixture.root, 'nextflow-conda')}'`))
        const micromambaDir = dirname(getMicromambaPath())
        assert.match(text, new RegExp(`^PATH=${micromambaDir}:${join(prefix, 'bin')}:`, 'm'))
        assert.match(text, new RegExp(`^MAMBA_ROOT_PREFIX=${fixture.root}$`, 'm'))
        assert.match(text, new RegExp(`^MAMBARC=${join(fixture.root, 'mambarc')}$`, 'm'))
        assert.match(text, new RegExp(`^PHI_ENV_ID=${envId}$`, 'm'))
        assert.doesNotMatch(text, /^CONDA_PREFIX=/m)
        assert.ok(existsSync(join(fixture.root, 'nextflow-conda')))
        assert.ok(existsSync(join(fixture.root, 'mambarc')))
      })
    })
  }
)

test('a docker-profile run gets no conda config', async () => {
  await withSandbox(async (sb) => {
    await withFixture(async (fixture) => {
      const record = join(fixture.root, 'args.txt')
      installFakeNextflow(fixture, shell([`echo "$*" > ${shQuote(record)}`]))
      const resolved = await resolveNextflowLaunch(context(fixture, { profile: 'docker' }))
      if (!resolved.ok) throw new Error(resolved.error)
      const result = await runWrapperComposition(
        bundledEntry().wrapperDir,
        { outdir: sb.outdir },
        'docker',
        { launch: resolved.launch }
      )
      assert.equal(result.success, true, result.output)
      assert.doesNotMatch(readFileSync(record, 'utf8'), /conda\.config/)
    })
  })
})

// ── the job manager ──────────────────────────────────────────────────────

test('the job manager runs phi:nextflow@1 and records which nextflow ran', async () => {
  await withSandbox(async (sb) => {
    await withFixture(async (fixture) => {
      const fake = join(fixture.root, 'fake-nextflow.cjs')
      writeFileSync(fake, FAKE_NEXTFLOW.replace(/^#!.*\n/, ''))
      const { envId, prefix } = installFakeNextflow(
        fixture,
        shell([`exec ${shQuote(process.execPath)} ${shQuote(fake)} "$@"`])
      )
      const manager = new WrapperJobManager({
        agentDir: () => sb.agentDir,
        progressThrottleMs: 0,
        nextflowLaunch: {
          runtimeRoot: fixture.root,
          environmentsDir: fixture.environmentsDir,
          platform: fixture.platform,
          hostNextflowPath: () => undefined
        }
      })
      const started = await manager.start({
        id: WRAPPER_ID,
        overrides: { outdir: sb.outdir },
        profile: 'docker'
      })
      assert.equal(started.ok, true, JSON.stringify(started))
      if (!started.ok) return
      const done = await manager.wait(started.status.runId, 20_000)
      assert.equal(done?.state, 'completed')
      const recorded = JSON.parse(
        readFileSync(
          join(getWrapperRunsDir(sb.agentDir), started.status.runId, 'nextflow.json'),
          'utf8'
        )
      ) as Record<string, string>
      assert.deepEqual(recorded, {
        source: 'managed',
        ref: NEXTFLOW_ENVIRONMENT_REF,
        envId,
        resolvedCommand: join(prefix, 'bin', 'nextflow')
      })
      const log = readFileSync(
        join(getWrapperRunsDir(sb.agentDir), started.status.runId, 'nextflow.log'),
        'utf8'
      )
      assert.match(log, new RegExp(`Nextflow: phi:nextflow@1 \\(${envId}\\)`))
    })
  })
})

test('the job manager refuses a local run when phi:nextflow@1 is not built', async () => {
  await withSandbox(async (sb) => {
    await withFixture(async (fixture) => {
      const manager = new WrapperJobManager({
        agentDir: () => sb.agentDir,
        nextflowLaunch: {
          runtimeRoot: fixture.root,
          environmentsDir: fixture.environmentsDir,
          platform: fixture.platform,
          hostNextflowPath: () => undefined
        }
      })
      const started = await manager.start({
        id: WRAPPER_ID,
        overrides: { outdir: sb.outdir },
        profile: 'docker',
        originSessionId: 'runtime-session-1'
      })
      assert.deepEqual(started, {
        ok: false,
        error: `environment ${NEXTFLOW_ENVIRONMENT_REF} is not ready; the user must build it first`
      })
      assert.equal(listWrapperRuns(sb.agentDir).length, 0)
    })
  })
})

test('the job manager asks to build phi:nextflow@1 in the originating chat', async () => {
  await withSandbox(async (sb) => {
    await withFixture(async (fixture) => {
      const asked: string[] = []
      const manager = new WrapperJobManager({
        agentDir: () => sb.agentDir,
        nextflowLaunch: {
          runtimeRoot: fixture.root,
          environmentsDir: fixture.environmentsDir,
          platform: fixture.platform,
          hostNextflowPath: () => undefined,
          builds: {
            start: () => Promise.reject(new Error('unused')),
            list: () => [],
            cancel: () => undefined
          },
          confirmBuild: (request) => {
            asked.push(`${request.runtimeSessionId} ${request.ref} ${request.skill ?? ''}`)
            return Promise.resolve(false)
          }
        }
      })
      const started = await manager.start({
        id: WRAPPER_ID,
        overrides: { outdir: sb.outdir },
        profile: 'docker',
        originSessionId: 'runtime-session-1'
      })
      assert.equal(started.ok, false)
      if (!started.ok) assert.match(started.error, /declined/)
      assert.deepEqual(asked, [`runtime-session-1 ${NEXTFLOW_ENVIRONMENT_REF} ${WRAPPER_ID}`])
    })
  })
})

// ── integration: the real environment ────────────────────────────────────

function integrationSkipReason(): string | false {
  if (process.env.PHI_RUNTIME_INTEGRATION !== '1') {
    return 'network integration: set PHI_RUNTIME_INTEGRATION=1 (npm run test:runtime)'
  }
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1; integration tests skipped'
  const missing = micromambaAvailable()
  return missing ? `${missing}; integration tests skipped` : false
}

test(
  'integration: phi-nextflow builds and nextflow -version runs through it',
  { timeout: 1_200_000, skip: integrationSkipReason() },
  async () => {
    const root = realpathSync(createTestRuntimeRoot('phi-nextflow'))
    try {
      ensureRuntimeLayout(root)
      ensureMambarc(root)
      const descriptor = describeEnvironment(NEXTFLOW_ENVIRONMENT_REF)
      const handle = await buildEnvironment(root, descriptor)
      const resolved = await resolveNextflowLaunch({
        runtimeRoot: root,
        hostNextflowPath: () => undefined,
        profile: 'conda'
      })
      if (!resolved.ok) throw new Error(resolved.error)
      const launch: NextflowLaunch = resolved.launch
      assert.equal(launch.source, 'managed')
      assert.equal(launch.command, join(handle.prefix, 'bin', 'nextflow'))
      const ran = spawnSync(launch.command, ['-version'], {
        env: launch.env,
        encoding: 'utf8',
        timeout: 300_000
      })
      assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`)
      const version = parseNextflowVersion(`${ran.stdout}\n${ran.stderr}`)
      assert.ok(version, ran.stdout)
      assert.equal(isNextflowVersionSupported(version), true)
      assert.equal(launch.env.JAVA_HOME?.startsWith(handle.prefix), true)
    } finally {
      removeTree(root)
    }
  }
)
