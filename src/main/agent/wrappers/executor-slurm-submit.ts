import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import {
  joinRemote,
  type ConnectImpl,
  type RemoteJobHandle,
  type RemoteLaunchSpec,
  type RemoteRunStatus
} from './executor-remote'
import { SbatchRunner } from './executor-slurm'
import type { WrapperManifest } from './manifest-types'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './remote-ssh-session'
import {
  appendWrapperAuditEvent,
  appendWrapperRunEvent,
  getWrapperRunsDir,
  writeWrapperRun
} from './store'
import type { WrapperOutputRecord, WrapperRun, WrapperRunPlan, WrapperRunState } from './types'

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
  /** Injectable so tests can fake the SSH session — see `executor-remote.ts`'s `RemoteControllerOptions`. */
  connectImpl?: ConnectImpl
  /** How often to poll `SbatchRunner.status()` while the job is queued/running. Defaults to 15s. */
  pollIntervalMs?: number
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- state machine (duplicated from executor-local.ts's transition/failRun
// on purpose — see module doc comment above) --------------------------------

function transition(
  run: WrapperRun,
  agentDir: string,
  state: WrapperRunState,
  patch: Partial<WrapperRun> = {}
): WrapperRun {
  const updated: WrapperRun = { ...run, ...patch, state, updatedAt: new Date().toISOString() }
  writeWrapperRun(updated, agentDir)
  appendWrapperRunEvent(
    run.runId,
    { type: 'run_state_changed', timestamp: updated.updatedAt, state },
    agentDir
  )
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: updated.updatedAt,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state }
    },
    agentDir
  )
  return updated
}

function failRun(run: WrapperRun, agentDir: string, reason: string): WrapperRun {
  const failed = transition(run, agentDir, 'failed', { completedAt: new Date().toISOString() })
  appendWrapperAuditEvent(
    {
      type: 'run_state_changed',
      timestamp: failed.updatedAt,
      actor: run.actor,
      runId: run.runId,
      planId: run.planId,
      wrapperId: run.wrapper.canonicalId,
      wrapperVersion: run.wrapper.version,
      detail: { state: 'failed', reason }
    },
    agentDir
  )
  return failed
}

// --- remote-specific pieces --------------------------------------------------

/**
 * Remote counterpart to `executor-nextflow.ts`'s `buildNextflowLaunch` —
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
  const args = ['run', entrypointPath, '-params-file', 'params.json', '-profile', plan.profile]
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

/**
 * Existence-only output collection — unlike `executor-local.ts`'s
 * `collectOutputs`, there's no cheap remote `stat` in `RemoteSshSession`
 * yet, so `bytes` is left unset. `location: 'remote'` is already part of
 * `WrapperOutputRecord`'s type (added when the full Phase 2 shape was
 * typed up front), so this needs no type changes.
 */
async function collectRemoteOutputs(
  session: RemoteSshSession,
  manifest: WrapperManifest,
  remoteOutDir: string
): Promise<WrapperOutputRecord[]> {
  const outputs: WrapperOutputRecord[] = []
  for (const output of manifest.outputs) {
    const path = joinRemote(remoteOutDir, output.path)
    const exists = await session.exists(path)
    outputs.push({ id: output.id, path, exists, primary: output.primary, location: 'remote' })
  }
  return outputs
}

async function pollUntilTerminal(
  runner: SbatchRunner,
  handle: RemoteJobHandle,
  pollIntervalMs: number
): Promise<RemoteRunStatus> {
  for (;;) {
    const status = await runner.status(handle)
    if (status.outcome !== 'running') return status
    await sleep(pollIntervalMs)
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
    launchScript: `${shellJoin(launch.command, launch.args)}\n`,
    paramsJson: launch.paramsJson
  }

  const running = transition(run, agentDir, 'running', { startedAt: new Date().toISOString() })
  const runner = new SbatchRunner({ connection: options.connection, connectImpl })

  let handle: RemoteJobHandle
  try {
    handle = await runner.submit(running, plan, launchSpec)
  } catch (error) {
    await session.close()
    return failRun(
      running,
      agentDir,
      `远程提交失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // Enough to rebuild a RemoteJobHandle and resume polling after a restart
  // — matches the `runs/<runId>/remote.snapshot.json` placeholder in the
  // design doc's storage layout. TODO: nothing reads this back yet — an
  // actual reconciliation-on-startup pass (the doc's "Monitoring And
  // Recovery" section) is a separate, larger piece of work, not part of
  // wiring up submit.
  const runDir = join(getWrapperRunsDir(agentDir), run.runId)
  ensureDir(runDir)
  writeFileSync(
    join(runDir, 'remote.snapshot.json'),
    `${JSON.stringify({ remoteRunDir, jobId: handle.jobId }, null, 2)}\n`,
    'utf-8'
  )

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

    return transition(running, agentDir, status.outcome === 'lost' ? 'lost' : 'failed', {
      completedAt: new Date().toISOString(),
      exitCode: status.exitCode
    })
  } finally {
    await runner.close()
    await session.close()
  }
}
