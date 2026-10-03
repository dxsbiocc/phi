import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { formatJobStatus } from '../src/main/agent/wrappers/composition/job-format'
import type { Project } from '../src/main/agent/projects'
import type { WrapperTargetDoctorSnapshot } from '../src/main/agent/wrappers/target-policy'
import type { WrapperJobStatus } from '../src/main/agent/wrappers/composition/job-types'
import {
  getWrapperRunsDir,
  listWrapperRuns,
  readWrapperRun
} from '../src/main/agent/wrappers/store'
import {
  markCompositionRunLost,
  markInterruptedCompositionRuns,
  readCompositionRemoteSnapshot,
  writeCompositionRemoteSnapshot
} from '../src/main/agent/wrappers/composition/run-record'
import type { ResolvedRemoteTarget } from '../src/main/agent/wrappers/remote-connection-resolver'
import { installFakeSlurm } from './helpers/fakeSlurm'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import { WRAPPER_ID, isAlive, waitFor, withSandbox, type Sandbox } from './helpers/wrapperSandbox'

interface Env {
  remoteRoot: string
  resolver: (ctx: {
    projectId?: string
    connectionId?: string
  }) => ResolvedRemoteTarget | { reason: string }
  resolved: ResolvedRemoteTarget
}

async function withRemote(sb: Sandbox, fn: (env: Env) => Promise<void>): Promise<void> {
  sb.useFake()
  const restore = installSetsidShim(mkdtempSync(join(tmpdir(), 'phi-shim-')))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-remote-root-'))
  const session = createLocalShellSession(remoteRoot)
  const resolved: ResolvedRemoteTarget = {
    target: {
      connection: { host: 'login.hpc.test' },
      workspaceRoot: remoteRoot,
      hpc: { scheduler: 'slurm', runtime: 'singularity', nextflowBin: process.env.NEXTFLOW_BIN },
      connectImpl: async () => session,
      pollIntervalMs: 30,
      skipPreflight: true
    },
    connectionId: 'conn1',
    projectId: 'proj1',
    hostProfileId: 'host-a'
  }
  try {
    await fn({ remoteRoot, resolved, resolver: () => resolved })
  } finally {
    restore()
    rmSync(remoteRoot, { recursive: true, force: true })
  }
}

function manager(
  sb: Sandbox,
  env: Env,
  extra: ConstructorParameters<typeof WrapperJobManager>[0] = {}
): WrapperJobManager {
  return new WrapperJobManager({
    agentDir: () => sb.agentDir,
    progressThrottleMs: 0,
    killGraceMs: 500,
    resolveRemoteTarget: env.resolver,
    ...extra
  })
}

async function startRemote(
  m: WrapperJobManager,
  overrides: Record<string, unknown> = {}
): Promise<WrapperJobStatus> {
  const result = await m.start({
    id: WRAPPER_ID,
    overrides: { gff: 'tests/data/genome.gff3', ...overrides },
    target: 'remote'
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error(result.error)
  return result.status
}

function projectForRun(root: string, kind: 'local' | 'ssh'): Project {
  return {
    id: 'proj1',
    name: 'Project',
    location:
      kind === 'ssh'
        ? { kind: 'ssh', hostProfileId: 'host-a', remoteRoot: root, canonicalRoot: root }
        : { kind: 'local', path: root, realPath: root },
    workingDirectory: root,
    workingDirectoryRealPath: root,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z'
  }
}

function readyDoctor(env: Env): WrapperTargetDoctorSnapshot {
  const hpc = env.resolved.target.hpc ?? { scheduler: 'local' as const }
  return {
    report: {
      hostProfileId: 'host-a',
      checkedAt: '2026-09-24T00:00:00.000Z',
      ok: true,
      checks: [
        'ssh',
        'sftp',
        'path',
        'path_read',
        'path_write',
        'shell',
        'nextflow',
        'java',
        'slurm_submit',
        'slurm_status',
        'slurm_detail',
        'slurm_cancel'
      ].map((id) => ({ id, status: 'ok', message: id }))
    },
    remotePath: env.remoteRoot,
    scheduler: hpc.scheduler,
    controller: hpc.controller ?? 'login',
    runtime: 'singularity'
  }
}

test('SSH project starts the same wrapper on its server without a target argument', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const project = projectForRun(env.remoteRoot, 'ssh')
      const m = manager(sb, env, {
        resolveProjectForRun: () => project,
        checkRemoteEnvironment: async () => readyDoctor(env)
      })
      const remoteGff = join(env.remoteRoot, 'genome.gff3')
      copyFileSync(
        join(process.cwd(), 'resources/wrappers/modules/nf-core/gffread/tests/data/genome.gff3'),
        remoteGff
      )
      const result = await m.start({
        id: WRAPPER_ID,
        overrides: { gff: 'genome.gff3' },
        originSessionId: 'runtime-ssh'
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      assert.equal(result.status.remote?.host, 'login.hpc.test')
      assert.match(result.status.targetReason ?? '', /远程项目固定使用/)
      const done = await m.wait(result.status.runId, 60_000)
      assert.equal(done?.state, 'completed')
      assert.match(formatJobStatus(done!), /Target: 远程项目固定使用/)
      const saved = readWrapperRun(result.status.runId, sb.agentDir)
      assert.equal(saved?.executor, 'slurm')
      assert.equal(saved?.remote?.projectId, project.id)
      assert.equal(saved?.inputReferences?.[0]?.source, 'remote')
      assert.deepEqual(saved?.inputReferences?.[0]?.remotePaths, [remoteGff])
      assert.match(saved?.targetReason ?? '', /远程项目固定使用/)
    })
  })
})

test('SSH project rejects explicit local and failed remote checks before recording a run', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const project = projectForRun(env.remoteRoot, 'ssh')
      let resolvedCount = 0
      const m = manager(sb, env, {
        resolveProjectForRun: () => project,
        resolveRemoteTarget: () => {
          resolvedCount += 1
          return env.resolved
        },
        checkRemoteEnvironment: async () => ({
          ...readyDoctor(env),
          report: {
            ...readyDoctor(env).report,
            ok: false,
            checks: [{ id: 'ssh', status: 'error', message: '服务器离线' }]
          }
        })
      })
      const local = await m.start({ id: WRAPPER_ID, overrides: {}, target: 'local' })
      assert.equal(local.ok, false)
      assert.match(local.ok ? '' : local.error, /不能在本机执行/)
      assert.equal(resolvedCount, 0)
      const offline = await m.start({
        id: WRAPPER_ID,
        overrides: {},
        originSessionId: 'runtime-ssh'
      })
      assert.equal(offline.ok, false)
      assert.match(offline.ok ? '' : offline.error, /服务器离线/)
      assert.equal(listWrapperRuns(sb.agentDir).length, 0)
    })
  })
})

test('local project keeps local default and can explicitly select its saved remote', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const localProject = projectForRun(sb.root, 'local')
    const localManager = new WrapperJobManager({
      agentDir: () => sb.agentDir,
      resolveProjectForRun: () => localProject
    })
    const local = await localManager.start({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      originSessionId: 'runtime-local'
    })
    assert.equal(local.ok, true, JSON.stringify(local))
    if (local.ok) {
      assert.equal(local.status.remote, undefined)
      assert.equal((await localManager.wait(local.status.runId, 60_000))?.state, 'completed')
    }
    await withRemote(sb, async (env) => {
      const remoteProject = {
        ...localProject,
        remoteWorkspaceRoot: env.remoteRoot,
        defaultRemoteConnectionId: 'conn1',
        remoteConnections: [
          {
            id: 'conn1',
            label: 'Cluster',
            hostProfileId: 'host-a',
            hpc: { scheduler: 'slurm' as const }
          }
        ]
      }
      const remoteManager = manager(sb, env, {
        resolveProjectForRun: () => remoteProject,
        checkRemoteEnvironment: async () => readyDoctor(env)
      })
      const remoteGff = join(env.remoteRoot, 'genome.gff3')
      const localGff = join(
        process.cwd(),
        'resources/wrappers/modules/nf-core/gffread/tests/data/genome.gff3'
      )
      copyFileSync(localGff, remoteGff)
      const stillLocal = await remoteManager.start({
        id: WRAPPER_ID,
        overrides: { gff: localGff, outdir: join(sb.root, 'local-with-remote-saved') },
        originSessionId: 'runtime-local'
      })
      assert.equal(stillLocal.ok, true, JSON.stringify(stillLocal))
      if (stillLocal.ok) {
        assert.equal(stillLocal.status.remote, undefined)
        assert.equal(
          (await remoteManager.wait(stillLocal.status.runId, 60_000))?.state,
          'completed'
        )
      }
      const selected = await remoteManager.start({
        id: WRAPPER_ID,
        overrides: { gff: remoteGff },
        target: 'remote',
        originSessionId: 'runtime-local'
      })
      assert.equal(selected.ok, true, JSON.stringify(selected))
      if (selected.ok) {
        assert.equal(selected.status.remote?.host, 'login.hpc.test')
        const saved = readWrapperRun(selected.status.runId, sb.agentDir)
        assert.equal(saved?.inputReferences?.[0]?.source, 'remote')
        assert.deepEqual(saved?.inputReferences?.[0]?.localPaths, [])
        assert.deepEqual(saved?.inputReferences?.[0]?.remotePaths, [remoteGff])
        assert.equal((await remoteManager.wait(selected.status.runId, 60_000))?.state, 'completed')
      }
    })
  })
})

test('local input references use the saved mapping and persist final server paths', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const localRoot = join(sb.root, 'local-inputs')
      const remoteDataRoot = join(env.remoteRoot, 'data')
      mkdirSync(localRoot)
      mkdirSync(remoteDataRoot)
      const source = join(
        process.cwd(),
        'resources/wrappers/modules/nf-core/gffread/tests/data/genome.gff3'
      )
      const localGff = join(localRoot, 'genome.gff3')
      const remoteGff = join(remoteDataRoot, 'genome.gff3')
      copyFileSync(source, localGff)
      copyFileSync(source, remoteGff)
      const project = {
        ...projectForRun(sb.root, 'local'),
        remoteWorkspaceRoot: env.remoteRoot,
        remoteConnections: [
          {
            id: 'conn1',
            label: 'Cluster',
            hostProfileId: 'host-a',
            hpc: { scheduler: 'slurm' as const },
            inputPathMapping: { localRoot, remoteRoot: remoteDataRoot }
          }
        ]
      }
      const m = manager(sb, env, {
        resolveProjectForRun: () => project,
        checkRemoteEnvironment: async () => readyDoctor(env)
      })
      const result = await m.start({
        id: WRAPPER_ID,
        overrides: { gff: { source: 'local', path: localGff } },
        target: 'remote',
        originSessionId: 'runtime-local'
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      const run = readWrapperRun(result.status.runId, sb.agentDir)
      assert.equal(run?.inputReferences?.[0]?.source, 'local')
      assert.deepEqual(run?.inputReferences?.[0]?.localPaths, [localGff])
      assert.deepEqual(run?.inputReferences?.[0]?.remotePaths, [remoteGff])
      assert.equal((await m.wait(result.status.runId, 60_000))?.state, 'completed')
    })
  })
})

test('local references without a saved mapping fail before recording a remote run', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const project = {
        ...projectForRun(sb.root, 'local'),
        remoteWorkspaceRoot: env.remoteRoot,
        remoteConnections: [
          {
            id: 'conn1',
            label: 'Cluster',
            hostProfileId: 'host-a',
            hpc: { scheduler: 'slurm' as const }
          }
        ]
      }
      const m = manager(sb, env, {
        resolveProjectForRun: () => project,
        checkRemoteEnvironment: async () => readyDoctor(env)
      })
      const result = await m.start({
        id: WRAPPER_ID,
        overrides: { gff: { source: 'local', path: join(sb.root, 'genome.gff3') } },
        target: 'remote',
        originSessionId: 'runtime-local'
      })
      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.error, /没有配置本机→服务器路径映射/)
      assert.equal(listWrapperRuns(sb.agentDir).length, 0)
    })
  })
})

test('unknown originating session cannot turn an omitted target into a local run', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = new WrapperJobManager({
      agentDir: () => sb.agentDir,
      resolveProjectForRun: () => undefined
    })
    const refused = await m.start({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      originSessionId: 'unrecognized-session'
    })
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.error, /无法确认.*会话或项目/)
    assert.equal(listWrapperRuns(sb.agentDir).length, 0)

    const ordinary = new WrapperJobManager({
      agentDir: () => sb.agentDir,
      resolveProjectForRun: () => null
    })
    const local = await ordinary.start({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      originSessionId: 'known-ordinary-session'
    })
    assert.equal(local.ok, true)
    if (local.ok) {
      assert.equal(local.status.remote, undefined)
      assert.equal((await ordinary.wait(local.status.runId, 60_000))?.state, 'completed')
    }
  })
})

test('a remote run is recorded as remote, completes, and reports outputs found on the cluster', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const m = manager(sb, env)
      const started = await startRemote(m)
      assert.equal(started.state, 'running')
      assert.equal(started.profile, 'singularity', 'the connection default runtime is used')
      assert.equal(started.remote?.host, 'login.hpc.test')
      assert.match(started.outDir, new RegExp(`^${env.remoteRoot}/wrappers/runs/wrun_.*/results$`))

      const done = (await m.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'completed', JSON.stringify(done))
      const run = readWrapperRun(started.runId, sb.agentDir)!
      assert.equal(run.executor, 'slurm')
      assert.equal(run.remote?.host, 'login.hpc.test')
      assert.equal(run.remote?.connectionId, 'conn1')
      assert.equal(run.remote?.hostProfileId, 'host-a')
      assert.equal(run.remote?.outputRoot, run.outDir)
      const primary = run.outputs?.find((output) => output.primary)
      assert.equal(primary?.location, 'remote')
      assert.equal(primary?.exists, true)
      assert.match(
        readFileSync(join(getWrapperRunsDir(sb.agentDir), started.runId, 'nextflow.log'), 'utf-8'),
        /GFFREAD/
      )
    })
  })
})

test('composition refuses an external output root without a plan authorization', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const m = manager(sb, env)
      const result = await m.start({
        id: WRAPPER_ID,
        overrides: { gff: 'tests/data/genome.gff3', outdir: '/outside/phi-results' },
        target: 'remote'
      })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /外部输出授权/)
      assert.equal(listWrapperRuns(sb.agentDir).length, 0)
    })
  })
})

test('a scheduler of "local" is recorded as the remote-background executor', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      env.resolved.target.hpc = { scheduler: 'local', nextflowBin: process.env.NEXTFLOW_BIN }
      const m = manager(sb, env)
      const started = await startRemote(m)
      await m.wait(started.runId, 60_000)
      assert.equal(readWrapperRun(started.runId, sb.agentDir)!.executor, 'remote-background')
    })
  })
})

test('an explicit profile wins over the connection default', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const m = manager(sb, env)
      const result = await m.start({
        id: WRAPPER_ID,
        overrides: { gff: 'tests/data/genome.gff3' },
        profile: 'conda',
        target: 'remote'
      })
      assert.equal(result.ok && result.status.profile, 'conda')
      if (result.ok) await m.wait(result.status.runId, 60_000)
    })
  })
})

test('a remote start without a usable remote is refused with the reason and leaves no run behind', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const m = manager(sb, env, {
        resolveRemoteTarget: () => ({ reason: 'No remote connection is set up.' })
      })
      const result = await m.start({ id: WRAPPER_ID, overrides: {}, target: 'remote' })
      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.error, /No remote connection is set up/)
      assert.equal(listWrapperRuns(sb.agentDir).length, 0)
    })
  })
})

test('a manager with no remote support says so instead of running locally by accident', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = new WrapperJobManager({ agentDir: () => sb.agentDir })
    const result = await m.start({ id: WRAPPER_ID, overrides: {}, target: 'remote' })
    assert.equal(result.ok, false)
    assert.equal(listWrapperRuns(sb.agentDir).length, 0)
  })
})

test('a cluster-only input path passes the local check and is verified on the cluster instead', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const m = manager(sb, env)
      const started = await startRemote(m, { gff: '/cluster/only/genome.gff3' })
      const done = (await m.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'failed')
      assert.match(
        done.logTail + JSON.stringify(readWrapperRun(started.runId, sb.agentDir)),
        /genome\.gff3/
      )
      const summary = JSON.parse(
        readFileSync(join(getWrapperRunsDir(sb.agentDir), started.runId, 'summary.json'), 'utf-8')
      )
      assert.match(summary.logTail, /服务器 login\.hpc\.test 的输入核验失败.*gff.*不存在/s)
    })
  })
})

test('an uncertain remote launch keeps its run ID and claim location in the saved snapshot', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const connect = env.resolved.target.connectImpl!
      const session = await connect(env.resolved.target.connection)
      const original = session.exec
      let dropped = false
      session.exec = async (command) => {
        if (!dropped && command.includes('setsid bash')) {
          dropped = true
          throw new Error('SSH disconnected before launch')
        }
        return original(command)
      }
      const m = manager(sb, env)
      const started = await startRemote(m)
      const done = (await m.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'lost')
      const snapshot = readCompositionRemoteSnapshot(started.runId, sb.agentDir)
      assert.equal(snapshot?.runId, started.runId)
      assert.equal(snapshot?.launchUnknown, true)
      assert.match(snapshot?.remoteRunDir ?? '', new RegExp(`${started.runId}$`))
      assert.equal(dropped, true)
      const runDir = snapshot!.remoteRunDir
      mkdirSync(join(runDir, 'results/gffread'), { recursive: true })
      mkdirSync(join(runDir, 'logs'), { recursive: true })
      writeFileSync(join(runDir, 'results/gffread/out.gtf'), 'x')
      writeFileSync(join(runDir, 'logs/stdout.log'), '[SUCCESS] completed=1 failed=0 cached=0\n')
      writeFileSync(join(runDir, 'exit_code'), '0\n')
      const restored = manager(sb, env)
      assert.equal(await restored.adoptRemoteRuns(), 1)
      const completed = (await restored.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(completed.state, 'completed', JSON.stringify(completed))
      assert.match(completed.logTail, /\[SUCCESS\]/)
    })
  })
})

test('cancelling a remote run stops it and records it cancelled', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      process.env.FAKE_NF_MODE = 'hang'
      const m = manager(sb, env)
      const started = await startRemote(m)
      await waitFor(() => existsSync(sb.pidFile))
      const nfPid = Number(readFileSync(sb.pidFile, 'utf-8'))
      const cancelled = await m.cancel(started.runId)
      assert.equal(cancelled.ok, true)
      const done = (await m.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'cancelled')
      await waitFor(() => !isAlive(nfPid))
    })
  })
})

test('a lost composition run can be reattached and cancelled without a second launch', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      process.env.FAKE_NF_MODE = 'hang'
      const first = manager(sb, env)
      const started = await startRemote(first)
      await waitFor(() => existsSync(sb.pidFile))
      const pid = Number(readFileSync(sb.pidFile, 'utf-8'))
      first.shutdown()
      const saved = readWrapperRun(started.runId, sb.agentDir)!
      markCompositionRunLost(saved, sb.agentDir, 'SSH disconnected')

      const restored = manager(sb, env)
      const requested = await restored.cancel(started.runId)
      assert.equal(requested.ok, true)
      const done = (await restored.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'cancelled')
      await waitFor(() => !isAlive(pid))
      const repeated = await restored.cancel(started.runId)
      assert.equal(repeated.ok, true)
      if (repeated.ok) assert.equal(repeated.status.state, 'cancelled')
    })
  })
})

test('quitting the app leaves a remote run going, and the next start picks it up and finishes it', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      process.env.FAKE_NF_MS = '1500'
      const first = manager(sb, env)
      const started = await startRemote(first)
      await waitFor(() => existsSync(sb.pidFile))
      const nfPid = Number(readFileSync(sb.pidFile, 'utf-8'))

      first.shutdown()
      assert.equal(
        readWrapperRun(started.runId, sb.agentDir)!.state,
        'running',
        'not recorded as cancelled'
      )
      assert.ok(isAlive(nfPid), 'the remote process survives the app')

      // next launch: nothing is "interrupted", and the manager adopts the run
      assert.equal(markInterruptedCompositionRuns(sb.agentDir), 0)
      const second = manager(sb, env)
      assert.equal(await second.adoptRemoteRuns(), 1)
      const done = (await second.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'completed', JSON.stringify(done))
      assert.match(done.logTail, /\[SUCCESS\] completed=1/)
      assert.equal(done.progress.started, 1, 'progress is rebuilt from the whole log')
    })
  })
})

test('a remote run that cannot be reattached is marked lost, never failed', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      process.env.FAKE_NF_MODE = 'hang'
      const first = manager(sb, env)
      const started = await startRemote(first)
      await waitFor(() => existsSync(sb.pidFile))
      first.shutdown()

      const second = manager(sb, env, {
        resolveRemoteTarget: () => ({ reason: 'connection was removed' })
      })
      assert.equal(await second.adoptRemoteRuns(), 0)
      const run = readWrapperRun(started.runId, sb.agentDir)!
      assert.equal(run.state, 'lost')
      const headPid = readCompositionRemoteSnapshot(started.runId, sb.agentDir)?.pid
      assert.ok(headPid)
      process.kill(-headPid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  })
})

test('a restart refuses a snapshot pointing outside its bound remote run directory', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      process.env.FAKE_NF_MODE = 'hang'
      const first = manager(sb, env)
      const started = await startRemote(first)
      await waitFor(() => existsSync(sb.pidFile))
      first.shutdown()
      const snapshot = readCompositionRemoteSnapshot(started.runId, sb.agentDir)!
      writeCompositionRemoteSnapshot(
        started.runId,
        { ...snapshot, remoteRunDir: '/another/project/wrappers/runs/wrun_other' },
        sb.agentDir
      )
      const second = manager(sb, env)
      assert.equal(await second.adoptRemoteRuns(), 0)
      assert.equal(readWrapperRun(started.runId, sb.agentDir)?.state, 'lost')
      assert.match(
        readWrapperRun(started.runId, sb.agentDir)?.launchDiagnostic ?? '',
        /快照与项目绑定/
      )
      assert.ok(snapshot.pid)
      process.kill(-snapshot.pid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  })
})

test('a lost remote run is rechecked after the server returns and resumes its log', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      process.env.FAKE_NF_MS = '1500'
      const session = await env.resolved.target.connectImpl!(env.resolved.target.connection)
      const first = manager(sb, env)
      const started = await startRemote(first)
      await waitFor(() => existsSync(sb.pidFile))
      first.shutdown()

      const offline = manager(sb, env, {
        resolveRemoteTarget: () => ({ reason: 'server temporarily unavailable' })
      })
      assert.equal(await offline.adoptRemoteRuns(), 0)
      assert.equal(readWrapperRun(started.runId, sb.agentDir)?.state, 'lost')

      const restored = manager(sb, env)
      assert.equal(await restored.adoptRemoteRuns(), 1)
      const done = (await restored.wait(started.runId, 60_000)) as WrapperJobStatus
      assert.equal(done.state, 'completed', JSON.stringify(done))
      const savedLog = readFileSync(
        join(getWrapperRunsDir(sb.agentDir), started.runId, 'nextflow.log'),
        'utf8'
      )
      assert.equal(savedLog.split('[PROCESS 87/ef5c73]').length - 1, 1)
      assert.equal(session.commands.filter((command) => command.includes('setsid bash')).length, 1)
    })
  })
})

test('local runs are unaffected: a local run never needs the remote resolver', async () => {
  await withSandbox(async (sb) => {
    sb.useFake()
    const m = new WrapperJobManager({ agentDir: () => sb.agentDir, progressThrottleMs: 0 })
    const result = await m.start({
      id: WRAPPER_ID,
      overrides: { outdir: sb.outdir },
      profile: 'docker'
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.status.remote, undefined)
      const done = await m.wait(result.status.runId, 60_000)
      assert.equal(done?.state, 'completed')
    }
  })
})

test('a run whose head process is a Slurm job is recorded as the slurm-controller executor', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const slurm = installFakeSlurm(mkdtempSync(join(tmpdir(), 'phi-fakeslurm-')))
      try {
        env.resolved.target.hpc = {
          scheduler: 'slurm',
          controller: 'sbatch',
          nextflowBin: process.env.NEXTFLOW_BIN
        }
        const m = manager(sb, env)
        const started = await startRemote(m)
        const done = (await m.wait(started.runId, 15_000)) as WrapperJobStatus
        assert.equal(done.state, 'completed', JSON.stringify(done))
        assert.equal(readWrapperRun(started.runId, sb.agentDir)!.executor, 'slurm-controller')
        assert.match(done.logTail, /Submitted Slurm controller job/)
      } finally {
        slurm.restore()
      }
    })
  })
})

test('quitting leaves an sbatch-controller run going and the next start finishes it', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const slurm = installFakeSlurm(mkdtempSync(join(tmpdir(), 'phi-fakeslurm-')))
      try {
        process.env.FAKE_NF_MS = '1500'
        env.resolved.target.hpc = {
          scheduler: 'slurm',
          controller: 'sbatch',
          nextflowBin: process.env.NEXTFLOW_BIN
        }
        const first = manager(sb, env)
        const started = await startRemote(first)
        await waitFor(() => existsSync(sb.pidFile))
        first.shutdown()
        assert.equal(readWrapperRun(started.runId, sb.agentDir)!.state, 'running')

        const second = manager(sb, env)
        assert.equal(await second.adoptRemoteRuns(), 1)
        const done = (await second.wait(started.runId, 15_000)) as WrapperJobStatus
        assert.equal(done.state, 'completed', JSON.stringify(done))
      } finally {
        slurm.restore()
      }
    })
  })
})
