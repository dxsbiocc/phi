import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  FAKE_NEXTFLOW,
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
  const session = createLocalShellSession(remoteRoot)
  const harness: Harness = {
    session,
    remoteRoot,
    output: [],
    snapshots: [],
    target: {
      connection: { host: 'h' },
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

test('a completed run drains a 10 MiB log through bounded pages without losing lines', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      sb.useFake(
        FAKE_NEXTFLOW.replace(
          "console.log('[SUCCESS] completed=1 failed=0 cached=0')",
          "process.stdout.write(('x'.repeat(1023) + '\\n').repeat(10240)); console.log('[SUCCESS] completed=1 failed=0 cached=0')"
        )
      )
      const exec = h.session.exec
      let largest = 0
      h.session.exec = async (command) => {
        const result = await exec(command)
        if (command.includes('MIME::Base64')) {
          largest = Math.max(largest, Buffer.byteLength(result.stdout, 'utf8'))
        }
        return result
      }
      const result = await start(h).done
      assert.equal(result.success, true, result.output)
      const output = h.output.join('')
      assert.ok(Buffer.byteLength(output, 'utf8') > 10 * 1024 * 1024)
      assert.match(output, /\[SUCCESS\] completed=1 failed=0 cached=0/)
      const logPath = `${h.remoteRoot}/wrappers/runs/wrun_t1/logs/stdout.log`
      assert.equal(h.snapshots.at(-1)?.logOffset, Buffer.byteLength(readFileSync(logPath)))
      assert.ok(largest <= 256 * 1024)
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

test('repeating a composition run ID observes the existing detached process', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      assert.equal((await start(h).done).success, true)
      assert.equal((await start(h).done).success, true)
      assert.equal(
        h.session.commands.filter((command) => command.includes('setsid bash')).length,
        1
      )
      assert.equal(h.session.uploads.length, 1)
    })
  })
})

test('a detached launch reply lost after execution recovers its PID without relaunching', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      const original = h.session.exec
      let dropped = false
      h.session.exec = async (command) => {
        if (!dropped && command.includes('setsid bash')) {
          dropped = true
          await original(command)
          throw new Error('SSH reply dropped after launch')
        }
        return original(command)
      }
      const result = await start(h).done
      assert.equal(result.success, true, result.output)
      assert.equal(dropped, true)
      assert.equal(
        h.session.commands.filter((command) => command.includes('setsid bash')).length,
        1
      )
      assert.ok(h.snapshots.at(-1)?.pid)
    })
  })
})

test('a disconnect before detached launch retains an unknown snapshot and never retries', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      const original = h.session.exec
      let dropped = false
      h.session.exec = async (command) => {
        if (!dropped && command.includes('setsid bash')) {
          dropped = true
          h.session.commands.push(command)
          throw new Error('SSH disconnected before launch')
        }
        return original(command)
      }
      const first = await start(h).done
      assert.equal(first.lost, true)
      assert.equal(h.snapshots.at(-1)?.launchUnknown, true)
      const second = await start(h).done
      assert.equal(second.lost, true)
      assert.equal(
        h.session.commands.filter((command) => command.includes('setsid bash')).length,
        1
      )
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

test('cancelling run A leaves concurrent run B alive', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      sb.useFake(FAKE_NEXTFLOW_TREE)
      process.env.FAKE_NF_MS = '30000'
      const first = start(h, {}, 'wrun_cancel_a')
      await waitFor(() =>
        h.snapshots.some((snapshot) => snapshot.runId === 'wrun_cancel_a' && snapshot.pid)
      )
      const second = start(h, {}, 'wrun_cancel_b')
      await waitFor(() =>
        h.snapshots.some((snapshot) => snapshot.runId === 'wrun_cancel_b' && snapshot.pid)
      )
      const aPid = h.snapshots.find(
        (snapshot) => snapshot.runId === 'wrun_cancel_a' && snapshot.pid
      )!.pid!
      const bPid = h.snapshots.find(
        (snapshot) => snapshot.runId === 'wrun_cancel_b' && snapshot.pid
      )!.pid!
      try {
        first.cancel()
        assert.equal((await first.done).cancelled, true)
        assert.equal(isAlive(aPid), false)
        assert.equal(isAlive(bPid), true)
      } finally {
        second.cancel()
        await second.done
      }
    })
  })
})

test('an unconfirmed cancel signal never turns a vanished run into cancelled', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      sb.useFake(FAKE_NEXTFLOW_TREE)
      process.env.FAKE_NF_MS = '30000'
      const proc = start(h, {}, 'wrun_cancel_unknown')
      await waitFor(() => h.snapshots.some((snapshot) => snapshot.pid))
      const pid = h.snapshots.find(
        (snapshot) => snapshot.runId === 'wrun_cancel_unknown' && snapshot.pid
      )!.pid!
      const exec = h.session.exec.bind(h.session)
      let signalAttempted = false
      h.session.exec = async (command) => {
        if (command.startsWith('kill -TERM -')) {
          signalAttempted = true
          throw new Error('SSH link dropped before signal reply')
        }
        if (signalAttempted && command.startsWith('kill -0 ')) {
          return { stdout: 'dead\n', stderr: '', code: 0, signal: null }
        }
        return exec(command)
      }
      try {
        proc.cancel()
        await waitFor(() => signalAttempted)
        const result = await proc.done
        assert.equal(result.lost, true)
        assert.equal(result.cancelled, undefined)
      } finally {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // The test may already have stopped the process group.
        }
      }
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
      assert.match(snapshot.logFileIdentity ?? '', /^[0-9]+:[0-9]+$/)
      assert.ok(snapshot.logOffset > 0)

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

test('attached runs show truncation and rotation diagnostics before resuming logs', async () => {
  await withSandbox(async (sb) => {
    await withHarness(sb, async (h) => {
      assert.equal((await start(h).done).success, true)
      const prior = h.snapshots.at(-1)!
      const logPath = `${h.remoteRoot}/wrappers/runs/wrun_t1/logs/stdout.log`
      writeFileSync(logPath, 'new\n')
      const truncatedOutput: string[] = []
      const updated: RemoteJobSnapshot[] = []
      const truncated = attachRemoteWrapperComposition({
        snapshot: prior,
        entry: bundledEntry(),
        target: h.target,
        onOutput: (text) => truncatedOutput.push(text),
        onSnapshot: (value) => updated.push(value)
      })
      assert.equal((await truncated.done).success, true)
      assert.match(truncatedOutput.join(''), /偏移.*超出/)
      assert.match(truncatedOutput.join(''), /new\n/)
      const current = updated.at(-1)!
      renameSync(logPath, `${logPath}.1`)
      writeFileSync(logPath, 'rotated\n')
      const rotatedOutput: string[] = []
      const rotated = attachRemoteWrapperComposition({
        snapshot: current,
        entry: bundledEntry(),
        target: h.target,
        onOutput: (text) => rotatedOutput.push(text)
      })
      assert.equal((await rotated.done).success, true)
      assert.match(rotatedOutput.join(''), /轮转/)
      assert.match(rotatedOutput.join(''), /rotated\n/)
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

test('the cluster check blocks direct host execution without its runtime', async () => {
  await withSandbox(async (sb) => {
    await withHarness(
      sb,
      async (h) => {
        const result = await start(h, {}, 'wrun_t1', 'singularity').done
        assert.equal(result.success, false)
        assert.match(result.output, /(singularity|apptainer).*不可用/i)
        assert.equal(h.snapshots.length, 0)
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
          scheduler: 'slurm',
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

test('sbatch receipt write lost after submission recovers the saved job ID', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      const write = h.session.writeTextFile
      let dropped = false
      h.session.writeTextFile = async (path, content) => {
        await write(path, content)
        if (!dropped && path.endsWith('/job_id')) {
          dropped = true
          throw new Error('SSH reply dropped after job ID was saved')
        }
      }
      const result = await start(h).done
      assert.equal(result.success, true, result.output)
      assert.equal(dropped, true)
      assert.equal(h.session.commands.filter((command) => command.startsWith('sbatch ')).length, 1)
      assert.ok(h.snapshots.at(-1)?.jobId)
    })
  })
})

test('sbatch reply lost before job ID stays unknown, then recovers by exit code', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      process.env.FAKE_NF_MS = '1000'
      const original = h.session.exec
      let dropped = false
      h.session.exec = async (command) => {
        if (!dropped && command.startsWith('sbatch ')) {
          dropped = true
          await original(command)
          throw new Error('SSH reply dropped before job ID')
        }
        return original(command)
      }
      const first = await start(h).done
      assert.equal(first.lost, true)
      assert.equal(h.snapshots.at(-1)?.launchUnknown, true)
      await waitFor(() => existsSync(`${h.remoteRoot}/wrappers/runs/wrun_t1/exit_code`))
      const second = await start(h).done
      assert.equal(second.success, true, second.output)
      assert.equal(h.session.commands.filter((command) => command.startsWith('sbatch ')).length, 1)
    })
  })
})

test('Slurm preflight warns when the selected runtime may exist only on compute nodes', async () => {
  await withSandbox(async (sb) => {
    await withSlurm(sb, async (h) => {
      h.target.skipPreflight = false
      h.target.hpc = { ...h.target.hpc!, controller: 'login' }
      const result = await start(h, {}, 'wrun_t1', 'singularity').done
      assert.equal(result.success, true, result.output)
      assert.match(h.output.join(''), /WARN.*(singularity|apptainer)/i)
      assert.match(h.output.join(''), /登录节点持续运行|sbatch 控制方式/)
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
        assert.equal(h.snapshots.at(-1)?.jobId, undefined)
        assert.match(
          readFileSync(`${h.remoteRoot}/wrappers/runs/wrun_t1/launch_error`, 'utf8'),
          /Invalid account/
        )
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
