import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { findWrapperCatalogEntry } from './catalog'
import { prepareNextflowProfile } from './composition/conda-profile'
import {
  nextflowLaunchRecord,
  resolveNextflowLaunch,
  type NextflowLaunchContext
} from './composition/nextflow-launch'
import { checkLocalDoctor } from './doctor'
import { buildNextflowInvocation } from './executor-nextflow'
import {
  appendWrapperAuditEvent,
  appendWrapperRunEvent,
  getWrapperRunsDir,
  writeWrapperRun
} from './store'
import { startWeblogListener, type WeblogListenerHandle } from './weblog-listener'
import type { WrapperManifest } from './manifest-types'
import type { WrapperOutputRecord, WrapperRun, WrapperRunPlan, WrapperRunState } from './types'

/** Matches `node:child_process`'s `spawn` — injectable so tests can fake Nextflow without it installed. */
export type SpawnImpl = typeof spawn

export interface RunLocalWrapperOptions {
  agentDir?: string
  spawnImpl?: SpawnImpl
  /**
   * Injectable so tests can simulate host runtime checks (currently Docker)
   * without it actually being installed. Defaults to the real local doctor.
   */
  doctorImpl?: typeof checkLocalDoctor
  /** Managed/explicit-host Nextflow resolution inputs. No runtime session means no build prompt. */
  nextflowLaunch?: Omit<
    NextflowLaunchContext,
    'profile' | 'runtimeSessionId' | 'wrapperId' | 'signal'
  >
  /** Bundled micromamba override used by tests for the conda-profile setup. */
  micromambaPath?: string
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function collectOutputs(manifest: WrapperManifest, absoluteOutDir: string): WrapperOutputRecord[] {
  return manifest.outputs.map((output) => {
    const path = join(absoluteOutDir, output.path)
    const exists = existsSync(path)
    let bytes: number | undefined
    if (exists) {
      try {
        bytes = statSync(path).size
      } catch {
        bytes = undefined
      }
    }
    return { id: output.id, path, exists, bytes, primary: output.primary, location: 'local' }
  })
}

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

function failRun(
  run: WrapperRun,
  agentDir: string,
  reason: string,
  patch: Partial<WrapperRun> = {}
): WrapperRun {
  const failed = transition(run, agentDir, 'failed', {
    ...patch,
    completedAt: new Date().toISOString()
  })
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

function readStream(stream: NodeJS.ReadableStream | null, onChunk: (chunk: Buffer) => void): void {
  stream?.on('data', (chunk: Buffer) => onChunk(chunk))
}

/**
 * Drives one local run from `created` through `running` to a terminal
 * state, spawning the wrapper's fixed Nextflow entrypoint as a real child
 * process. `spawnImpl` is injectable so CI can fake Nextflow's behavior —
 * a real local Nextflow smoke run is a manual step (Milestone P1.9), not a
 * CI dependency (see docs/design/phi-wrapper-v1-implementation-plan.md).
 */
export async function runLocalWrapperExecution(
  run: WrapperRun,
  plan: WrapperRunPlan,
  options: RunLocalWrapperOptions = {}
): Promise<WrapperRun> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const spawnImpl = options.spawnImpl ?? spawn
  const doctorImpl = options.doctorImpl ?? checkLocalDoctor

  const entry = findWrapperCatalogEntry(run.wrapper.canonicalId, run.wrapper.version, agentDir)
  if (!entry) {
    return failRun(
      run,
      agentDir,
      `找不到已安装的 wrapper: ${run.wrapper.canonicalId}@${run.wrapper.version}`
    )
  }
  const manifest = entry.manifest
  const nextflowProfile = plan.nextflowProfile ?? plan.profile
  const resolved = await resolveNextflowLaunch({
    ...options.nextflowLaunch,
    profile: nextflowProfile,
    wrapperId: run.wrapper.canonicalId
  })
  if (!resolved.ok) {
    return failRun(run, agentDir, resolved.error, { environmentError: resolved.error })
  }

  const requiresDocker =
    manifest.engine.profiles.find((profile) => profile.id === run.profile)?.containerRuntime ===
    'docker'
  const doctor = doctorImpl({ requireDocker: requiresDocker })
  if (!doctor.ok) {
    const missing = doctor.checks
      .filter((check) => !check.ok)
      .map((check) => check.label)
      .join(', ')
    return failRun(run, agentDir, `本地环境检查未通过: ${missing}`)
  }

  const runDir = join(getWrapperRunsDir(agentDir), run.runId)
  const logsDir = join(runDir, 'logs')
  ensureDir(runDir)
  ensureDir(logsDir)

  const absoluteOutDir = join(run.cwd, run.outDir)
  ensureDir(absoluteOutDir)

  let preparedProfile: ReturnType<typeof prepareNextflowProfile>
  try {
    preparedProfile = prepareNextflowProfile(
      nextflowProfile,
      resolved.launch.runtimeRoot,
      resolved.launch.env,
      options.micromambaPath
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return failRun(run, agentDir, reason, { environmentError: reason })
  }

  let weblog: WeblogListenerHandle | undefined
  if (run.steps && run.steps.length > 0) {
    weblog = await startWeblogListener(run.runId, run.steps, agentDir)
  }

  const invocation = buildNextflowInvocation(
    manifest,
    plan,
    entry.installedPath,
    absoluteOutDir,
    weblog?.url
  )
  writeFileSync(join(runDir, 'params.json'), invocation.paramsJson, 'utf-8')
  writeFileSync(
    join(runDir, 'nextflow.json'),
    `${JSON.stringify(nextflowLaunchRecord(resolved.launch), null, 2)}\n`,
    'utf-8'
  )

  if (preparedProfile.config) {
    const configPath = join(runDir, 'conda.config')
    writeFileSync(configPath, preparedProfile.config, 'utf-8')
    invocation.args.push('-c', configPath)
  }

  transition(run, agentDir, 'provisioning')
  const running = transition(run, agentDir, 'running', { startedAt: new Date().toISOString() })

  const exitCode = await new Promise<number>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnImpl(resolved.launch.command, invocation.args, {
        cwd: runDir,
        env: preparedProfile.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve(1)
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    readStream(child.stdout, (chunk) => stdoutChunks.push(chunk))
    readStream(child.stderr, (chunk) => stderrChunks.push(chunk))
    child.on('error', () => resolve(1))
    child.on('close', (code) => {
      writeFileSync(join(logsDir, 'stdout.log'), Buffer.concat(stdoutChunks))
      writeFileSync(join(logsDir, 'stderr.log'), Buffer.concat(stderrChunks))
      resolve(code ?? 1)
    })
  })

  await weblog?.stop()

  if (exitCode !== 0) {
    return transition(running, agentDir, 'failed', {
      completedAt: new Date().toISOString(),
      exitCode
    })
  }

  const collecting = transition(running, agentDir, 'collecting')
  const outputs = collectOutputs(manifest, absoluteOutDir)
  writeFileSync(
    join(runDir, 'outputs.json'),
    `${JSON.stringify({ runId: run.runId, outputs }, null, 2)}\n`
  )
  writeFileSync(
    join(runDir, 'summary.json'),
    `${JSON.stringify({ runId: run.runId, state: 'completed', outputs }, null, 2)}\n`
  )

  return transition(collecting, agentDir, 'completed', {
    completedAt: new Date().toISOString(),
    exitCode,
    outputs
  })
}
