import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { RemoteHpcSettings } from '../../../shared/wrapperRemoteTypes'
import { remoteDoctor } from '../remote-doctor'
import { findWrapperCatalogEntry } from './catalog'
import {
  buildRemoteConfiguredLaunchScript,
  buildRemoteNextflowConfig
} from './composition/remote-config'
import {
  joinRemote,
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
  transitionUnlessCancelled,
  writeRemoteRunSnapshot
} from './executor-remote-run'
import { buildRemoteNextflowLaunch } from './executor-slurm-submit'
import { checkRemoteWrapperInputs } from './remote-input-check'
import { RemoteLaunchUnknownError } from './remote-launch-claim'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './remote-ssh-session'
import { readWrapperRun, writeWrapperRun } from './store'
import { checkRemoteSubmitPreflight, executeRemoteLaunchPreflight } from './remote-submit-preflight'
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
  hpc?: RemoteHpcSettings
  doctorImpl?: typeof remoteDoctor
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

  let environment: Awaited<ReturnType<typeof checkRemoteSubmitPreflight>>
  try {
    environment = await checkRemoteSubmitPreflight({
      run,
      plan,
      manifest: entry.manifest,
      agentDir,
      doctorImpl: options.doctorImpl,
      remote: {
        connection: options.connection,
        remoteWorkspaceRoot: plan.targetSelection?.remoteRoot ?? remoteRunDir,
        hpc: options.hpc,
        connectImpl: options.connectImpl
      }
    })
  } catch (error) {
    const reason = `服务器提交前检查失败: ${error instanceof Error ? error.message : String(error)}`
    return failRun({ ...run, environmentError: reason }, agentDir, reason)
  }
  if (environment.error) {
    return failRun({ ...run, environmentError: environment.error }, agentDir, environment.error)
  }
  let provisioning = transition(run, agentDir, 'provisioning', {
    ...(environment.warnings.length ? { environmentWarnings: environment.warnings } : {})
  })

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

  if (plan.targetSelection?.target === 'remote') {
    try {
      const checked = await executeRemoteLaunchPreflight(
        session,
        environment.hpc,
        plan.targetSelection.remoteRoot!
      )
      if (checked.error) {
        await session.close().catch(() => undefined)
        return failRun(
          { ...provisioning, environmentError: checked.error },
          agentDir,
          checked.error
        )
      }
      if (checked.warnings.length > 0) {
        provisioning = {
          ...provisioning,
          environmentWarnings: [
            ...new Set([...(provisioning.environmentWarnings ?? []), ...checked.warnings])
          ]
        }
        writeWrapperRun(provisioning, agentDir)
      }
    } catch (error) {
      await session.close().catch(() => undefined)
      const reason = `服务器预检失败: ${error instanceof Error ? error.message : String(error)}`
      return failRun({ ...provisioning, environmentError: reason }, agentDir, reason)
    }
  }

  const references = run.inputReferences ?? plan.inputs
  try {
    const checked = await checkRemoteWrapperInputs(session, references)
    if (checked.errors.length > 0) {
      await session.close().catch(() => undefined)
      return failRun(
        { ...provisioning, inputErrors: checked.errors, inputWarnings: checked.warnings },
        agentDir,
        checked.errors.join('\n')
      )
    }
    if (checked.warnings.length > 0) {
      provisioning = { ...provisioning, inputWarnings: checked.warnings }
      writeWrapperRun(provisioning, agentDir)
    }
  } catch (error) {
    await session.close().catch(() => undefined)
    return failRun(
      {
        ...provisioning,
        inputErrors: [
          `服务器输入核验失败: ${error instanceof Error ? error.message : String(error)}`
        ]
      },
      agentDir,
      `服务器输入核验失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    await uploadWrapperBundle(session, entry.installedPath, remoteWrapperDir)
  } catch (error) {
    await session.close()
    return failRun(
      provisioning,
      agentDir,
      `上传 wrapper 到远程失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const launch = buildRemoteNextflowLaunch(entry.manifest, plan, remoteWrapperDir, remoteOutDir)
  const launchSpec: RemoteLaunchSpec = {
    remoteRunDir,
    // The shared script records the exit code even when setup fails, which is
    // needed for detached status polling and gives Slurm the correct state.
    launchScript: buildRemoteConfiguredLaunchScript({
      runDir: remoteRunDir,
      commands: [shellJoin(launch.command, launch.args)],
      setupCommands: environment.hpc.setupCommands
    }),
    paramsJson: launch.paramsJson,
    nextflowConfig: buildRemoteNextflowConfig(environment.hpc)
  }

  const running = transition(provisioning, agentDir, 'running', {
    startedAt: new Date().toISOString()
  })
  const runner = new SshExecRunner({ connection: options.connection, connectImpl })
  writeRemoteRunSnapshot(run.runId, agentDir, { remoteRunDir, launchUnknown: true })

  let handle: RemoteJobHandle
  try {
    handle = await runner.submit(running, plan, launchSpec)
  } catch (error) {
    await runner.close().catch(() => undefined)
    await session.close()
    if (error instanceof RemoteLaunchUnknownError) {
      return transition(running, agentDir, 'lost', {
        completedAt: new Date().toISOString(),
        launchUnknown: true,
        launchDiagnostic: error.message
      })
    }
    writeRemoteRunSnapshot(run.runId, agentDir, { remoteRunDir })
    return failRun(
      running,
      agentDir,
      `远程启动失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // Enough to rebuild a RemoteJobHandle and resume polling after a restart.
  // The startup remote reconciliation pass reads the same snapshot for both controllers.
  writeRemoteRunSnapshot(run.runId, agentDir, { remoteRunDir, pid: handle.pid })

  try {
    const status = await pollUntilTerminal(runner, handle, pollIntervalMs)
    const recorded = readWrapperRun(run.runId, agentDir)
    if (recorded?.state === 'cancelled') return recorded

    if (status.outcome === 'completed') {
      const collecting = transition(running, agentDir, 'collecting')
      const outputs = await collectRemoteOutputs(
        session,
        entry.manifest,
        run.remote?.outputRoot ?? remoteOutDir
      )
      return transitionUnlessCancelled(collecting, agentDir, 'completed', {
        completedAt: new Date().toISOString(),
        exitCode: status.exitCode,
        outputs
      })
    }

    if (status.outcome === 'lost') {
      return transitionUnlessCancelled(running, agentDir, 'lost', {
        completedAt: new Date().toISOString()
      })
    }

    // A signal exit does not prove the run's independently submitted tasks were cleaned.
    const current = readWrapperRun(run.runId, agentDir) ?? running
    const signalEnded = status.exitCode === 143 || status.exitCode === 137
    if (current.state === 'cancelling' && !current.cancelConfirmedAt && signalEnded) return current
    const cancelled = current.state === 'cancelling' && current.cancelConfirmedAt !== undefined
    return transitionUnlessCancelled(running, agentDir, cancelled ? 'cancelled' : 'failed', {
      completedAt: new Date().toISOString(),
      exitCode: status.exitCode
    })
  } finally {
    await runner.close()
    await session.close()
  }
}
