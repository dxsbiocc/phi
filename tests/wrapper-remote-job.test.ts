import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getBundledWrapperPackagesDir } from '../src/main/agent/wrappers/catalog'
import {
  attachRemoteWrapperComposition,
  startRemoteWrapperComposition,
  type RemoteJobSnapshot,
  type RemoteTarget
} from '../src/main/agent/wrappers/composition/remote-job'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { installFakeSlurm, type FakeSlurm } from './helpers/fakeSlurm'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import {
  FAKE_NEXTFLOW_TREE,
  bundledEntry,
  isAlive,
  waitFor,
  withSandbox,
  type Sandbox
} from './helpers/wrapperSandbox'

interface Harness {
  session: ReturnType<typeof createLocalShellSession>
  target: RemoteTarget
  remoteRoot: string
  output: string[]
  snapshots: RemoteJobSnapshot[]
}

async function withHarness(
  sb: Sandbox,
  fn: (h: Harness) => Promise<void>,
  targetPatch: Partial<RemoteTarget> | ((nextflowBin: string) => Partial<RemoteTarget>) = {}
): Promise<void> {
  sb.useFake()
  const restore = installSetsidShim(mkdtempSync(join(tmpdir(), 'phi-shim-')))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'phi-remote-root-'))
  const session = createLocalShellSession()
  const harness: Harness = {
    session,
    remoteRoot,
    output: [],
    snapshots: [],
    target: {
      connection: { host: 'h', username: 'u', privateKey: 'k' },
      workspaceRoot: remoteRoot,
      hpc: { scheduler: 'local', nextflowBin: process.env.NEXTFLOW_BIN },
      connectImpl: async () => session,
      pollIntervalMs: 30,
      skipPreflight: true,
      ...(typeof targetPatch === 'function'
        ? targetPatch(process.env.NEXTFLOW_BIN as string)
        : targetPatch)
    }
  }
  try {
    await fn(harness)
  } finally {
    restore()
    rmSync(remoteRoot, { recursive: true, force: true })
  }
}

function start(
  h: Harness,
  overrides: Record<string, unknown> = {},
  runId = 'wrun_t1',
  profile = 'docker'
): ReturnType<typeof startRemoteWrapperComposition> {
  const entry = bundledEntry()
  return startRemoteWrapperComposition({
    runId,
    entry,
    params: { gff: 'tests/data/genome.gff3', outdir: 'results', ...overrides },
    profile,
    target: h.target,
    wrappersRoot: getBundledWrapperPackagesDir(),
    onOutput: (chunk) => h.output.push(chunk),
    onSnapshot: (snapshot) => h.snapshots.push(snapshot),
    killGraceMs: 500
  })
}

test('a remote run ships the bundle, launches Nextflow detached, streams its log and reports outputs', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      const result = await start(h).done
      assert.equal(result.success, true, result.output)
      assert.match(h.output.join(''), /\[PROCESS 87\/ef5c73\] GFFREAD/)
      assert.equal(h.session.uploads.length, 1)

      const runDir = `${h.remoteRoot}/wrappers/runs/wrun_t1`
      const params = JSON.parse(readFileSync(`${runDir}/params.json`, 'utf-8'))
      assert.equal(params.outdir, `${runDir}/results`, 'a relative outdir lands under the run dir')
      assert.match(
        readFileSync(`${runDir}/phi_remote.config`, 'utf-8'),
        /process\.executor = 'local'/
      )

      assert.deepEqual(result.remote?.missingOutputs, [])
      const primary = result.remote?.outputs.find((output) => output.primary)
      assert.equal(primary?.exists, true)
      assert.equal(primary?.location, 'remote')
      assert.equal(primary?.path, `${runDir}/results/gffread`)
      assert.ok(h.snapshots.length > 0)
      assert.ok(h.snapshots.at(-1)!.pid! > 0)
    })
  })
})

test('an input path missing on the cluster is reported before anything is launched', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      const result = await start(h, { gff: '/no/such/annotation.gff3' }).done
      assert.equal(result.success, false)
      assert.match(result.output, /gff.*\/no\/such\/annotation\.gff3/)
      assert.equal(h.snapshots.length, 0, 'nothing may have been launched')
      assert.equal(existsSync(`${h.remoteRoot}/wrappers/runs/wrun_t1/launch.sh`), false)
    })
  })
})

test('a failing Nextflow run is reported with its exit code and error output', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      process.env.FAKE_NF_MODE = 'fail'
      const result = await start(h).done
      assert.equal(result.success, false)
      assert.equal(result.exitCode, 1)
      assert.match(h.output.join(''), /boom: pipeline failed/)
    })
  })
})

test('cancel stops the remote process group and resolves as cancelled', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      sb.useFake(FAKE_NEXTFLOW_TREE)
      h.target = { ...h.target, hpc: { scheduler: 'local', nextflowBin: process.env.NEXTFLOW_BIN } }
      const proc = start(h)
      await waitFor(() => existsSync(sb.pidFile) && existsSync(`${sb.pidFile}.child`))
      const nfPid = Number(readFileSync(sb.pidFile, 'utf-8'))
      const childPid = Number(readFileSync(`${sb.pidFile}.child`, 'utf-8'))
      assert.ok(isAlive(nfPid) && isAlive(childPid))

      proc.cancel()
      const result = await proc.done
      assert.equal(result.cancelled, true)
      assert.equal(result.success, false)
      await waitFor(() => !isAlive(nfPid) && !isAlive(childPid))
    })
  })
})

test('cancelling before the launch never starts the run', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      const proc = start(h)
      proc.cancel()
      const result = await proc.done
      assert.equal(result.cancelled, true)
      assert.equal(h.snapshots.length === 0 || !isAlive(h.snapshots[0].pid!), true)
    })
  })
})

test('detach leaves the run going remotely and attach picks it up without repeating log lines', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      process.env.FAKE_NF_MS = '1200'
      const first = start(h)
      await waitFor(() => h.output.join('').includes('GFFREAD') && h.snapshots.length > 0)
      first.detach?.()
      const detached = await first.done
      assert.equal(detached.detached, true)
      const snapshot = h.snapshots.at(-1)!
      assert.ok(isAlive(snapshot.pid!), 'the remote run must survive the app letting go of it')

      const second: string[] = []
      const resumed = attachRemoteWrapperComposition({
        snapshot,
        entry: bundledEntry(),
        target: h.target,
        onOutput: (chunk) => second.push(chunk)
      })
      const result = await resumed.done
      assert.equal(result.success, true, result.output)
      const later = second.join('')
      assert.match(later, /\[SUCCESS\] completed=1/)
      assert.doesNotMatch(
        later,
        /GFFREAD/,
        'lines already delivered before the detach are not replayed'
      )
    })
  })
})

test('a dropped connection is retried, and the run still completes', async () => {
  await withSandbox(async (sb) => {
    let failures = 2
    await withHarness(
      sb,
      async (h) => {
        process.env.FAKE_NF_MS = '600'
        const result = await start(h).done
        assert.equal(result.success, true, result.output)
        assert.equal(failures, 0, 'the injected failures were consumed')
      },
      {
        connectImpl: async () => {
          const session = createLocalShellSession()
          const real: RemoteSshSession['exec'] = session.exec
          session.exec = async (command) => {
            if (command.startsWith('kill -0') && failures > 0) {
              failures -= 1
              throw new Error('Connection lost')
            }
            return real(command)
          }
          return session
        }
      }
    )
  })
})

test('a connection that never comes back ends the run as lost, not failed', async () => {
  await withSandbox(async (sb) => {
    await withHarness(
      sb,
      async (h) => {
        process.env.FAKE_NF_MODE = 'hang'
        const proc = start(h)
        const result = await proc.done
        assert.equal(result.lost, true)
        assert.equal(result.success, false)
        assert.match(result.output, /Connection lost/)
        // the run itself is untouched remotely; clean it up
        const pid = h.snapshots.at(-1)?.pid
        assert.ok(pid)
        // The launch is asynchronous: wait for its process group to exist before killing it.
        await waitFor(() => {
          try {
            process.kill(-pid, 0)
            return true
          } catch {
            return false
          }
        })
        process.kill(-pid, 'SIGKILL')
      },
      {
        maxConsecutivePollFailures: 3,
        connectImpl: (() => {
          let first = true
          return async () => {
            if (!first) throw new Error('Connection lost')
            first = false
            const session = createLocalShellSession()
            const real: RemoteSshSession['exec'] = session.exec
            session.exec = async (command) => {
              if (command.startsWith('kill -0')) throw new Error('Connection lost')
              return real(command)
            }
            return session
          }
        })()
      }
    )
  })
})

test('the cluster check runs before anything is launched and reports what is missing', async () => {
  await withSandbox(async (sb) => {
    await withHarness(
      sb,
      async (h) => {
        const result = await start(h).done
        assert.equal(result.success, false)
        assert.match(result.output, /sbatch/)
        assert.match(h.output.join(''), /sbatch/, 'the reason is in the run log the agent reads')
        assert.equal(h.snapshots.length, 0, 'nothing may have been launched')
      },
      (nextflowBin) => ({
        skipPreflight: false,
        hpc: { scheduler: 'slurm', nextflowBin }
      })
    )
  })
})

test('the cluster check lets a healthy host through and puts its warnings in the log', async () => {
  await withSandbox(async (sb) => {
    await withHarness(
      sb,
      async (h) => {
        const result = await start(h, {}, 'wrun_t1', 'singularity').done
        assert.equal(result.success, true, result.output)
        assert.match(h.output.join(''), /WARN.*(singularity|apptainer)/i)
      },
      (nextflowBin) => ({
        skipPreflight: false,
        hpc: { scheduler: 'local', runtime: 'singularity', nextflowBin }
      })
    )
  })
})

// ── the sbatch controller: the Nextflow head process is itself a Slurm job ──────────────

async function withSlurm(
  sb: Sandbox,
  fn: (h: Harness, slurm: FakeSlurm) => Promise<void>,
  controllerOptions?: string
): Promise<void> {
  const slurm = installFakeSlurm(mkdtempSync(join(tmpdir(), 'phi-fakeslurm-')))
  try {
    await withHarness(
      sb,
      (h) => fn(h, slurm),
      (nextflowBin) => ({
        hpc: {
          scheduler: 'local',
          controller: 'sbatch',
          nextflowBin,
          ...(controllerOptions ? { controllerOptions } : {})
        }
      })
    )
  } finally {
    slurm.restore()
  }
}

test('sbatch controller: the head process is submitted as a Slurm job and the run completes', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h, slurm) => {
      const result = await start(h).done
      assert.equal(result.success, true, result.output)
      assert.match(h.output.join(''), /Submitted Slurm controller job \d+/)
      assert.match(h.output.join(''), /\[PROCESS 87\/ef5c73\] GFFREAD/)
      const snapshot = h.snapshots.at(-1)!
      assert.match(snapshot.jobId ?? '', /^\d+$/)
      assert.equal(snapshot.pid, undefined, 'a Slurm job is identified by its job id, not a pid')
      const directives = slurm.directives(snapshot.jobId!)
      assert.ok(directives.includes('--job-name=phi-wrun_t1'))
      assert.ok(directives.some((d) => d.endsWith('/logs/stdout.log')))
      assert.equal(result.remote?.outputs.find((o) => o.primary)?.exists, true)
    })
  })
})

test('sbatch controller: a Nextflow failure is a failed run, not a completed job', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      process.env.FAKE_NF_MODE = 'fail'
      const result = await start(h).done
      assert.equal(result.success, false)
      assert.equal(result.exitCode, 1)
      assert.match(h.output.join(''), /boom: pipeline failed/)
    })
  })
})

test('sbatch controller: controller options reach the head job', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(
      sb,
      async (h, slurm) => {
        await start(h).done
        const directives = slurm.directives(h.snapshots.at(-1)!.jobId!)
        assert.deepEqual(directives.slice(-2), ['--time=7-00:00:00', '--qos=long'])
      },
      '--time=7-00:00:00 --qos=long'
    )
  })
})

test('sbatch controller: cancel scancels the job and the process behind it stops', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      process.env.FAKE_NF_MODE = 'hang'
      const proc = start(h)
      await waitFor(() => existsSync(sb.pidFile) && h.snapshots.length > 0)
      const nfPid = Number(readFileSync(sb.pidFile, 'utf-8'))
      proc.cancel()
      const result = await proc.done
      assert.equal(result.cancelled, true)
      await waitFor(() => !isAlive(nfPid))
    })
  })
})

test("sbatch controller: a refused submission is reported with the scheduler's reason", async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      process.env.FAKE_SLURM_REJECT = 'Invalid account or account/partition combination'
      try {
        const result = await start(h).done
        assert.equal(result.success, false)
        assert.match(result.output, /Invalid account/)
        assert.match(h.output.join(''), /Invalid account/)
        assert.equal(h.snapshots.length, 0)
      } finally {
        delete process.env.FAKE_SLURM_REJECT
      }
    })
  })
})

test('sbatch controller: a job killed at its time limit says so and how to raise it', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h, slurm) => {
      process.env.FAKE_NF_MODE = 'hang'
      const proc = start(h)
      await waitFor(() => existsSync(sb.pidFile) && h.snapshots.length > 0)
      const jobId = h.snapshots.at(-1)!.jobId!
      slurm.setState(jobId, 'TIMEOUT')
      process.kill(-slurm.pid(jobId), 'SIGKILL')
      const result = await proc.done
      assert.equal(result.success, false)
      assert.match(result.output, /TIMEOUT/)
      assert.match(result.output, /--time/)
    })
  })
})

test('sbatch controller: detach leaves the job going and attach finishes it from the job id alone', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      process.env.FAKE_NF_MS = '1500'
      const first = start(h)
      await waitFor(() => h.output.join('').includes('GFFREAD') && h.snapshots.length > 0)
      first.detach?.()
      assert.equal((await first.done).detached, true)
      const snapshot = h.snapshots.at(-1)!

      const later: string[] = []
      const result = await attachRemoteWrapperComposition({
        snapshot,
        entry: bundledEntry(),
        target: h.target,
        onOutput: (chunk) => later.push(chunk)
      }).done
      assert.equal(result.success, true, result.output)
      assert.doesNotMatch(later.join(''), /GFFREAD/)
    })
  })
})
