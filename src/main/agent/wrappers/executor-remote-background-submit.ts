import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import {
  joinRemote,
  wrapWithExitCodeTrap,
  SshExecRunner,
  type ConnectImpl,
  type RemoteJobHandle,
  type RemoteLaunchSpec
} from './executor-remote'
import {
  collectRemoteOutputs,
  failRun,
  pollUntilTerminal,
  transition,
  writeRemoteRunSnapshot
} from './executor-remote-run'
import { buildRemoteNextflowLaunch } from './executor-slurm-submit'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './remote-ssh-session'
import { readWrapperRun } from './store'
import type { WrapperRun, WrapperRunPlan } from './types'

/**
 * Drives one `remote-background` run end to end via `SshExecRunner` (the
 * `detached_ssh` controller) — the plain-SSH counterpart to
 * `executor-slurm-submit.ts`'s `runSlurmWrapperExecution`, which drives
 * `slurm-controller` via `SbatchRunner` instead. Called from `runs.ts`'s
 * submit path the same way (fire-and-forget,
 * `void runRemoteBackgroundWrapperExecution(...).catch(...)`). Deliberately
 * duplicates most of `runSlurmWrapperExecution`'s sequence rather than
 * sharing it behind a generic orchestrator — see `executor-remote-run.ts`'s
 * module doc comment for why: this codebase keeps each executor's
 * orchestration independently modifiable on purpose, sharing only the truly
 * generic pieces (state transitions, output collection, the reconnect
 * snapshot).
 *
 * Also reuses `executor-slurm-submit.ts`'s `buildRemoteNextflowLaunch` as-is
 * — building the Nextflow command line doesn't depend on which controller
 * eventually launches it.
 */
export interface RunRemoteBackgroundWrapperOptions {
  agentDir?: string
  /** Absolute remote path this run executes under, e.g. `<remoteWorkspaceRoot>/wrappers/runs/<runId>`. */
  remoteRunDir: string
  connection: RemoteConnectionConfig
  /** Injectable so tests can fake the SSH session — see `executor-remote.ts`'s `RemoteControllerOptions`. */
  connectImpl?: ConnectImpl
  /** How often to poll `SshExecRunner.status()` while the process is running. Defaults to 15s. */
  pollIntervalMs?: number
}

function shellJoin(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ')
}

/**
 * Recursively uploads the installed wrapper's source into `remoteDir` —
 * identical to `executor-slurm-submit.ts`'s private `uploadWrapperBundle`,
 * kept as its own copy rather than exported/shared since it's a trivial
 * helper, not a meaningful behavioral seam.
 */
async function uploadWrapperBundle(
  session: RemoteSshSession,
  localDir: string,
  remoteDir: string
): Promise<void> {
  await session.mkdirp(remoteDir)
  for (const entry of readdirSync(localDir, { withFileTypes: true })) {
    const localPath = join(localDir, entry.name)
    const remotePath = joinRemote(remoteDir, entry.name)
    if (entry.isDirectory()) {
      await uploadWrapperBundle(session, localPath, remotePath)
    } else if (entry.isFile()) {
      await session.writeTextFile(remotePath, readFileSync(localPath, 'utf-8'))
    }
  }
}

export async function runRemoteBackgroundWrapperExecution(
  run: WrapperRun,
  plan: WrapperRunPlan,
  options: RunRemoteBackgroundWrapperOptions
): Promise<WrapperRun> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const pollIntervalMs = options.pollIntervalMs ?? 15_000
  const connectImpl = options.connectImpl ?? connectRemoteSshSession

  const entry = findWrapperCatalogEntry(run.wrapper.canonicalId, run.wrapper.version, agentDir)
  if (!entry) {
    return failRun(
      run,
      agentDir,
      `找不到已安装的 wrapper: ${run.wrapper.canonicalId}@${run.wrapper.version}`
    )
  }

  const remoteRunDir = options.remoteRunDir
  const remoteWrapperDir = joinRemote(remoteRunDir, 'wrapper')
  const remoteOutDir = joinRemote(remoteRunDir, 'output')

  transition(run, agentDir, 'provisioning')

  let session: RemoteSshSession
  try {
    session = await connectImpl(options.connection)
  } catch (error) {
    return failRun(
      run,
      agentDir,
      `连接远程主机失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    await uploadWrapperBundle(session, entry.installedPath, remoteWrapperDir)
  } catch (error) {
    await session.close()
    return failRun(
      run,
      agentDir,
      `上传 wrapper 到远程失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const launch = buildRemoteNextflowLaunch(entry.manifest, plan, remoteWrapperDir, remoteOutDir)
  const launchSpec: RemoteLaunchSpec = {
    remoteRunDir,
    // Unlike sbatch (where Slurm itself is the source of truth for exit
    // status), a detached SSH process must record its own exit code — see
    // wrapWithExitCodeTrap's doc comment. SshExecRunner.status() depends on
    // the exit_code file this produces.
    launchScript: wrapWithExitCodeTrap(shellJoin(launch.command, launch.args)),
    paramsJson: launch.paramsJson
  }

  const running = transition(run, agentDir, 'running', { startedAt: new Date().toISOString() })
  const runner = new SshExecRunner({ connection: options.connection, connectImpl })

  let handle: RemoteJobHandle
  try {
    handle = await runner.submit(running, plan, launchSpec)
  } catch (error) {
    await session.close()
    return failRun(
      running,
      agentDir,
      `远程启动失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // Enough to rebuild a RemoteJobHandle and resume polling after a restart
  // — matches the `runs/<runId>/remote.snapshot.json` placeholder in the
  // design doc's storage layout. Not yet read back by a reconciliation pass
  // (that exists only for slurm-controller so far, see
  // executor-slurm-reconcile.ts's doc comment) — a separate follow-up.
  writeRemoteRunSnapshot(run.runId, agentDir, { remoteRunDir, pid: handle.pid })

  try {
    const status = await pollUntilTerminal(runner, handle, pollIntervalMs)

    if (status.outcome === 'completed') {
      const collecting = transition(running, agentDir, 'collecting')
      const outputs = await collectRemoteOutputs(session, entry.manifest, remoteOutDir)
      return transition(collecting, agentDir, 'completed', {
        completedAt: new Date().toISOString(),
        exitCode: status.exitCode,
        outputs
      })
    }

    if (status.outcome === 'lost') {
      return transition(running, agentDir, 'lost', { completedAt: new Date().toISOString() })
    }

    // Same race as runSlurmWrapperExecution's: a concurrent cancelWrapperRun
    // call may have moved the run to `cancelling` while this poll loop was
    // waiting. Cancelling isn't wired up for remote-background yet (see
    // runs.ts — REMOTE_CANCELLABLE_RUN_STATES only applies to
    // slurm-controller), so this branch can't be hit today, but re-checking
    // here keeps this orchestrator correct the moment it is.
    const current = readWrapperRun(run.runId, agentDir) ?? running
    return transition(running, agentDir, current.state === 'cancelling' ? 'cancelled' : 'failed', {
      completedAt: new Date().toISOString(),
      exitCode: status.exitCode
    })
  } finally {
    await runner.close()
    await session.close()
  }
}
