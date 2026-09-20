import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import type { WrapperJobStatus } from '../src/main/agent/wrappers/composition/job-types'
import {
  getWrapperRunsDir,
  listWrapperRuns,
  readWrapperRun
} from '../src/main/agent/wrappers/store'
import { markInterruptedCompositionRuns } from '../src/main/agent/wrappers/composition/run-record'
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
  const session = createLocalShellSession()
  const resolved: ResolvedRemoteTarget = {
    target: {
      connection: { host: 'login.hpc.test', username: 'u', privateKey: 'k' },
      workspaceRoot: remoteRoot,
      hpc: { scheduler: 'slurm', runtime: 'singularity', nextflowBin: process.env.NEXTFLOW_BIN },
      connectImpl: async () => session,
      pollIntervalMs: 30,
      skipPreflight: true
    },
    connectionId: 'conn1',
    projectId: 'proj1'
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

test('a remote run is recorded as remote, completes, and reports outputs found on the cluster', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      const m = manager(sb, env)
      const started = await startRemote(m)
      assert.equal(started.state, 'running')
      assert.equal(started.profile, 'singularity', 'the connection default runtime is used')
      assert.equal(started.remote?.host, 'login.hpc.test')
      assert.match(started.outDir, new RegExp(`^${env.remoteRoot}/wrappers/runs/wrun_.*/results$`))

      const done = (await m.wait(started.runId, 10_000)) as WrapperJobStatus
      assert.equal(done.state, 'completed', JSON.stringify(done))
      const run = readWrapperRun(started.runId, sb.agentDir)!
      assert.equal(run.executor, 'slurm')
      assert.equal(run.remote?.host, 'login.hpc.test')
      assert.equal(run.remote?.connectionId, 'conn1')
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

test('a scheduler of "local" is recorded as the remote-background executor', async () => {
  await withSandbox(async (sb) => {
    await withRemote(sb, async (env) => {
      env.resolved.target.hpc = { scheduler: 'local', nextflowBin: process.env.NEXTFLOW_BIN }
      const m = manager(sb, env)
      const started = await startRemote(m)
      await m.wait(started.runId, 10_000)
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
      if (result.ok) await m.wait(result.status.runId, 10_000)
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
      const done = (await m.wait(started.runId, 10_000)) as WrapperJobStatus
      assert.equal(done.state, 'failed')
      assert.match(
        done.logTail + JSON.stringify(readWrapperRun(started.runId, sb.agentDir)),
        /genome\.gff3/
      )
      const summary = JSON.parse(
        readFileSync(join(getWrapperRunsDir(sb.agentDir), started.runId, 'summary.json'), 'utf-8')
      )
      assert.match(summary.logTail, /do not exist on login\.hpc\.test/)
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
      const done = (await m.wait(started.runId, 10_000)) as WrapperJobStatus
      assert.equal(done.state, 'cancelled')
      await waitFor(() => !isAlive(nfPid))
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
      const done = (await second.wait(started.runId, 10_000)) as WrapperJobStatus
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
      const nfPid = Number(readFileSync(sb.pidFile, 'utf-8'))
      first.shutdown()

      const second = manager(sb, env, {
        resolveRemoteTarget: () => ({ reason: 'connection was removed' })
      })
      assert.equal(await second.adoptRemoteRuns(), 0)
      const run = readWrapperRun(started.runId, sb.agentDir)!
      assert.equal(run.state, 'lost')
      process.kill(nfPid, 'SIGKILL')
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
      const done = await m.wait(result.status.runId, 10_000)
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
          scheduler: 'local',
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
          scheduler: 'local',
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
