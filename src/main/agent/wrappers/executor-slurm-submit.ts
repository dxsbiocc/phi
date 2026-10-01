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
import { SbatchRunner } from './executor-slurm'
import type { WrapperManifest } from './manifest-types'
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
 * Drives one `slurm-controller` run end to end via `SbatchRunner` — the
 * remote counterpart to `executor-local.ts`'s `runLocalWrapperExecution`,
 * called from `runs.ts`'s submit path the same way (fire-and-forget,
 * `void runSlurmWrapperExecution(...).catch(...)`). Kept as its own module
 * rather than folded into `executor-local.ts` or `executor-slurm.ts` — the
 * design doc's stability notes call out that Phase 2 work shouldn't need
 * to touch `executor-local.ts`, and `executor-slurm.ts` is meant to stay a
 * pure `RemoteRunner` implementation, not an orchestrator.
 */
export interface RunSlurmWrapperOptions {
  agentDir?: string
  /** Absolute remote path this run executes under, e.g. `<remoteWorkspaceRoot>/wrappers/runs/<runId>`. */
  remoteRunDir: string
  connection: RemoteConnectionConfig
  hpc?: RemoteHpcSettings
  doctorImpl?: typeof remoteDoctor
  /** Injectable so tests can fake the SSH session — see `executor-remote.ts`'s `RemoteControllerOptions`. */
  connectImpl?: ConnectImpl
  /** How often to poll `SbatchRunner.status()` while the job is queued/running. Defaults to 15s. */
  pollIntervalMs?: number
}

// --- remote-specific pieces --------------------------------------------------

/**
 * Remote counterpart to `executor-nextflow.ts`'s `buildNextflowInvocation` —
 * same shape, but paths are joined with `/` (`joinRemote`) instead of
 * `node:path`'s `join`, which would emit `\`-separated paths on a Windows
 * Phi host for what is always a POSIX remote path. No `weblogUrl` param:
 * remote `-with-weblog` needs an SSH tunnel back to the local listener that
 * doesn't exist yet (see `executor-remote.ts`'s module doc comment).
 */
export function buildRemoteNextflowLaunch(
  manifest: WrapperManifest,
  plan: WrapperRunPlan,
  remoteInstalledPath: string,
  remoteOutDir: string
): { command: string; args: string[]; paramsJson: string } {
  const entrypointPath = joinRemote(remoteInstalledPath, manifest.engine.entrypoint)
  const args = [
    'run',
    entrypointPath,
    '-params-file',
    'params.json',
    '-profile',
    plan.nextflowProfile ?? plan.profile,
    '-c',
    'nextflow.config'
  ]
  const params: Record<string, unknown> = { ...plan.params }
  if (params.outdir === undefined) {
    params.outdir = remoteOutDir
  }
  return { command: 'nextflow', args, paramsJson: JSON.stringify(params, null, 2) }
}

function shellJoin(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ')
}

/**
 * Recursively uploads the installed wrapper's source into `remoteDir`.
 * Text-only (wrapper bundles are Nextflow scripts/configs) — a wrapper
 * that ever ships a binary asset needs a base64 path through
 * `writeTextFile` or a real SFTP stream, neither of which exists yet.
 * Also not optimized: one round trip per file, fine for a handful of
 * workflow files, not for a large nf-core-style tree — worth revisiting
 * (tar the tree locally, upload once, `tar xzf` remotely) if that turns
 * out to matter.
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

export async function runSlurmWrapperExecution(
  run: WrapperRun,
  plan: WrapperRunPlan,
  options: RunSlurmWrapperOptions
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
    launchScript: buildRemoteConfiguredLaunchScript({
      runDir: remoteRunDir,
      commands: [shellJoin(launch.command, launch.args)],
      setupCommands: environment.hpc.setupCommands
    }),
    paramsJson: launch.paramsJson,
    nextflowConfig: buildRemoteNextflowConfig(environment.hpc),
    hpc: environment.hpc
  }

  const running = transition(provisioning, agentDir, 'running', {
    startedAt: new Date().toISOString()
  })
  const runner = new SbatchRunner({ connection: options.connection, connectImpl })
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
      `远程提交失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // Enough to rebuild a RemoteJobHandle and resume polling after a restart
  // — matches the `runs/<runId>/remote.snapshot.json` placeholder in the
  // design doc's storage layout. Read back by `executor-slurm-reconcile.ts`'s
  // startup pass and by `runs.ts`'s `cancelWrapperRun`.
  writeRemoteRunSnapshot(run.runId, agentDir, { remoteRunDir, jobId: handle.jobId })

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

    // A concurrent `cancelWrapperRun` call may have moved the run to
    // `cancelling` (and issued `scancel`) while this poll loop was waiting —
    // re-read the current record rather than trusting `running`, which is a
    // stale snapshot from before that happened. Slurm reports a cancelled
    // job the same way it reports any other non-zero exit ("failed" states),
    // so without this check a user-requested cancellation would land as
    // `failed`, not the `cancelled` the design doc's state diagram promises.
    const current = readWrapperRun(run.runId, agentDir) ?? running
    const cancelled =
      current.state === 'cancelling' &&
      (current.cancelConfirmedAt !== undefined ||
        status.detail?.startsWith('CANCELLED') === true ||
        status.exitCode === 143 ||
        status.exitCode === 137)
    return transitionUnlessCancelled(running, agentDir, cancelled ? 'cancelled' : 'failed', {
      completedAt: new Date().toISOString(),
      exitCode: status.exitCode
    })
  } finally {
    await runner.close()
    await session.close()
  }
}
