import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import type { ProjectMemoryTarget } from '../../memory/project-memory-worker'
import {
  buildProjectMemoryPromptBlock,
  readProjectMemoryFiles
} from '../../memory/project-memory-files'
import {
  getMemoryRoot,
  releaseImportedMemoryJobs,
  removeImportedMemoryThread,
  saveLearnedLesson,
  writeImportedMemoryRollout
} from '../omp-internals'
import { resolveBunExecutable, workerPathWithBun } from '../bun-executable'
import { projectMemoryWorkerEnvironment } from './desktop-project-memory-env'
import { rpcIdentifier } from './control-frame'
import { webSearchPath, webSearchRecord } from './desktop-websearch-protocol'

type ModelRef = { provider: string; id: string }
import {
  importedMemoryRolloutPath,
  parseProjectMemoryManifest,
  type ProjectMemoryManifest
} from './desktop-project-memory-cache'
interface Project {
  target: ProjectMemoryTarget
  directory: string
  sdk: string
  rollouts: string
  manifestPath: string
  manifest: ProjectMemoryManifest
  tail: Promise<void>
  retiring: number
  job?: Job
}
interface Job {
  owner: string
  requestId: string
  child: ChildProcessWithoutNullStreams
  aborted: boolean
  closed: Promise<number | null>
  done: Promise<void>
}
interface Scope {
  id: string
  target: ProjectMemoryTarget
  policy: { enabled: boolean; learn: boolean }
  controller: AbortController
  project: Promise<Project>
  epoch?: number
  calls: Map<string, { controller: AbortController; done: Promise<unknown> }>
}
const projects = new Map<string, Promise<Project>>()
const scopes = new Map<string, Scope>()
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const key = (target: ProjectMemoryTarget): string => target.agentDir + '\0' + target.cwd
function targetOf(value: Record<string, unknown>): ProjectMemoryTarget {
  if (!webSearchPath(value.agentDir) || !webSearchPath(value.cwd))
    throw new Error('Invalid local memory anchor')
  return { agentDir: value.agentDir, cwd: value.cwd }
}
async function projectFor(target: ProjectMemoryTarget): Promise<Project> {
  let pending = projects.get(key(target))
  if (!pending) {
    pending = (async () => {
      // All data is desktop-private. No imported rollout is an SDK recovery journal.
      const canonicalAgentDir = await realpath(target.agentDir)
      const directory = join(canonicalAgentDir, 'phi-rpc-memory', digest(target.cwd))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await realpath(directory)) !== directory)
        throw new Error('Memory import cache must stay inside its owned directory')
      const manifestPath = join(directory, 'imports.json')
      let manifest: ProjectMemoryManifest = { schema: 1, epoch: 0, clearCutoff: 0, imports: {} }
      try {
        manifest = parseProjectMemoryManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return {
        target,
        directory,
        sdk: join(directory, 'sdk'),
        rollouts: join(directory, 'rollouts'),
        manifestPath,
        manifest,
        tail: Promise.resolve(),
        retiring: 0
      }
    })()
    projects.set(key(target), pending)
    void pending.catch(() => {
      if (projects.get(key(target)) === pending) projects.delete(key(target))
    })
  }
  return pending
}
function atomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + process.pid + '.tmp'
  writeFileSync(temporary, content, { mode: 0o600 })
  renameSync(temporary, path)
}
function persist(project: Project): void {
  atomic(project.manifestPath, JSON.stringify(project.manifest))
}
function locked<T>(project: Project, action: () => Promise<T>): Promise<T> {
  const run = project.tail.then(action, action)
  project.tail = run.then(
    () => {},
    () => {}
  )
  return run
}
function guard(scope: Scope, project: Project, signal?: AbortSignal): void {
  scope.controller.signal.throwIfAborted()
  signal?.throwIfAborted()
  if (project.retiring || scope.epoch !== project.manifest.epoch)
    throw new Error('Project memory generation changed')
}
async function cancelJob(project: Project, owner?: string, requestId?: string): Promise<void> {
  const job = project.job
  if (!job || (owner && job.owner !== owner) || (requestId && job.requestId !== requestId)) return
  job.aborted = true
  if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGKILL')
  }, 2000)
  try {
    await job.closed
  } finally {
    clearTimeout(timer)
  }
  if (job.child.pid) releaseImportedMemoryJobs(project.sdk, job.child.pid)
}
function startJob(scope: Scope, project: Project, requestId: string, model: ModelRef): void {
  const epoch = project.manifest.epoch
  const bun = resolveBunExecutable({ resourcesPath: process.resourcesPath })
  const workerPath = fileURLToPath(
    new URL('./desktop-project-memory-sdk-worker.ts', import.meta.url)
  ).replace(/app\.asar(?=\/)/, 'app.asar.unpacked')
  const env: NodeJS.ProcessEnv = {
    ...projectMemoryWorkerEnvironment(process.env),
    PATH: workerPathWithBun(bun, process.env.PATH),
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: project.target.agentDir,
    OMP_APP_NAME: 'Phi'
  }
  const child = spawn(bun, ['--no-env-file', workerPath], {
    cwd: project.target.agentDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  let diagnostic = ''
  let spawnFailed = false
  child.stdout.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4096)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-32768)
  })
  child.stdin.on('error', () => {})
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => {
      spawnFailed = true
    })
    child.once('close', (code, signal) => {
      // Evidence only, never authority for killing a process after a restart.
      try {
        atomic(
          join(project.directory, 'last-child-exit.json'),
          JSON.stringify({ pid: child.pid, code, signal })
        )
      } catch {
        /* A diagnostic failure cannot prevent the owned close acknowledgement. */
      }
      resolve(code)
    })
  })
  const job: Job = {
    owner: scope.id,
    requestId,
    child,
    aborted: false,
    closed,
    done: Promise.resolve()
  }
  project.job = job
  // Keep stdin open: EOF belongs to parent death/retirement, not successful startup.
  child.stdin.write(
    JSON.stringify({
      agentDir: project.target.agentDir,
      stageAgentDir: project.sdk,
      cwd: project.target.cwd,
      rolloutDir: project.rollouts,
      model
    }) + '\n'
  )
  job.done = (async () => {
    const code = await closed
    if (job.aborted) return
    if (spawnFailed || code !== 0) {
      if (diagnostic)
        await writeFile(join(project.directory, 'child-error.log'), diagnostic, { mode: 0o600 })
      throw new Error('SDK memory child failed')
    }
    const receipt: unknown = JSON.parse(output.trim())
    if (
      !webSearchRecord(receipt) ||
      receipt.ok !== true ||
      receipt.started !== true ||
      !['summary', 'empty'].includes(String(receipt.status))
    )
      throw new Error('SDK memory completion was not confirmed')
    const summary =
      receipt.status === 'empty'
        ? ''
        : await readFile(
            join(getMemoryRoot(project.sdk, project.target.cwd), 'memory_summary.md'),
            'utf8'
          )
    if (receipt.status === 'summary' && !summary.trim())
      throw new Error('SDK memory produced no summary')
    await locked(project, async () => {
      guard(scope, project)
      if (job.aborted || project.manifest.epoch !== epoch || project.job !== job) return
      // One final synchronous publication after ownership checks; learned.md is independent.
      if (summary.trim())
        atomic(
          join(getMemoryRoot(project.target.agentDir, project.target.cwd), 'memory_summary.md'),
          summary
        )
      for (const imported of Object.values(project.manifest.imports)) imported.published = true
      persist(project)
    })
  })()
    .catch(async () => {
      await writeFile(
        join(project.directory, 'last-job-error.json'),
        JSON.stringify({ code: 'MEMORY_PIPELINE_FAILED' }),
        { mode: 0o600 }
      ).catch(() => {})
    })
    .finally(() => {
      if (project.job === job) project.job = undefined
    })
}
function scopeFor(params: unknown): { scope: Scope; record: Record<string, unknown> } {
  if (!webSearchRecord(params) || !rpcIdentifier(params.scopeId))
    throw new Error('Invalid memory scope')
  const scope = scopes.get(params.scopeId)
  if (!scope) throw new Error('Project memory scope is unavailable')
  return { scope, record: params }
}
async function call<T>(
  scope: Scope,
  requestId: unknown,
  operation: (project: Project, signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (!rpcIdentifier(requestId) || scope.calls.has(requestId))
    throw new Error('Invalid memory request')
  const controller = new AbortController()
  const signal = AbortSignal.any([scope.controller.signal, controller.signal])
  const done = (async () => {
    const project = await scope.project
    guard(scope, project, signal)
    return operation(project, signal)
  })()
  scope.calls.set(requestId, { controller, done })
  try {
    return await done
  } finally {
    scope.calls.delete(requestId)
  }
}
export async function createDesktopProjectMemory(
  params: unknown
): Promise<{ memoryBlock?: string }> {
  if (
    !webSearchRecord(params) ||
    !rpcIdentifier(params.scopeId) ||
    scopes.has(params.scopeId) ||
    !webSearchRecord(params.identity)
  )
    throw new Error('Invalid project memory creation')
  const identity = params.identity
  if (
    ![identity.runtimeSessionId, identity.sessionId, identity.projectId].every(rpcIdentifier) ||
    !webSearchPath(identity.cwd)
  )
    throw new Error('Invalid project memory identity')
  const target = targetOf(params)
  const scope: Scope = {
    id: params.scopeId,
    target,
    policy: normalizeProjectMemorySettings(params.policy),
    controller: new AbortController(),
    project: projectFor(target),
    calls: new Map()
  }
  scopes.set(scope.id, scope)
  try {
    const project = await scope.project
    scope.epoch = project.manifest.epoch
    guard(scope, project)
    const memoryBlock = scope.policy.enabled
      ? buildProjectMemoryPromptBlock(
          await readProjectMemoryFiles(getMemoryRoot(target.agentDir, target.cwd))
        )
      : undefined
    guard(scope, project)
    if (scope.policy.enabled)
      await locked(project, async () => {
        guard(scope, project)
        if (project.job) return
        const pending = Object.values(project.manifest.imports).find((value) => !value.published)
        if (pending) {
          try {
            await readFile(importedMemoryRolloutPath(project.rollouts, pending.id))
            guard(scope, project)
            // Reservation is synchronous inside the project queue; provider work stays outside it.
            if (!project.job) startJob(scope, project, 'startup-' + scope.id, pending.model)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      })
    return memoryBlock ? { memoryBlock } : {}
  } catch (error) {
    scope.controller.abort()
    scopes.delete(scope.id)
    throw error
  }
}
export async function ingestDesktopProjectMemory(params: unknown): Promise<{ accepted: boolean }> {
  const { scope, record } = scopeFor(params)
  if (!scope.policy.enabled) throw new Error('Project memory is disabled')
  if (!webSearchRecord(record.source)) throw new Error('Missing verified memory transcript')
  const source = record.source
  if (
    !rpcIdentifier(source.ompSessionId) ||
    !rpcIdentifier(source.runId) ||
    !webSearchPath(source.journalPath) ||
    !(source.leafId === null || rpcIdentifier(source.leafId)) ||
    !Number.isSafeInteger(source.messageCount) ||
    !Array.isArray(source.messages) ||
    source.messages.length !== source.messageCount ||
    !webSearchRecord(source.model) ||
    !rpcIdentifier(source.model.provider) ||
    !rpcIdentifier(source.model.id)
  )
    throw new Error('Invalid verified memory transcript')
  const messages = source.messages
  const body = JSON.stringify(messages)
  if (Buffer.byteLength(body) > 32 * 1024 * 1024)
    throw new Error('Memory transcript exceeds the accepted history bound')
  const model = { provider: source.model.provider, id: source.model.id }
  const fingerprint = digest(
    JSON.stringify([source.ompSessionId, source.journalPath, source.leafId, source.messageCount])
  )
  const sourceKey = digest(String(source.ompSessionId) + '\0' + String(source.journalPath))
  return call(scope, record.requestId, (project, signal) =>
    locked(project, async () => {
      guard(scope, project, signal)
      const previous = project.manifest.imports[sourceKey]
      if (previous?.fingerprint === fingerprint) return { accepted: false }
      const latest = Math.max(
        0,
        ...messages.map((value) =>
          webSearchRecord(value) && typeof value.timestamp === 'number' ? value.timestamp : 0
        )
      )
      if (!previous && latest <= project.manifest.clearCutoff) return { accepted: false }
      await cancelJob(project)
      guard(scope, project, signal)
      await mkdir(project.rollouts, { recursive: true, mode: 0o700 })
      await mkdir(project.sdk, { recursive: true, mode: 0o700 })
      const imported = await writeImportedMemoryRollout(
        project.target.cwd,
        project.rollouts,
        messages
      )
      const path = importedMemoryRolloutPath(project.rollouts, imported.id)
      await rename(imported.path, path)
      let accepted = false
      try {
        guard(scope, project, signal)
        project.manifest.imports[sourceKey] = { id: imported.id, fingerprint, model }
        persist(project)
        accepted = true
        if (previous) {
          removeImportedMemoryThread(project.sdk, previous.id)
          await rm(importedMemoryRolloutPath(project.rollouts, previous.id), { force: true })
        }
        guard(scope, project, signal)
        startJob(scope, project, String(record.requestId), model)
        return { accepted: true }
      } catch (error) {
        if (!accepted) await rm(path, { force: true })
        throw error
      }
    })
  )
}
export async function learnDesktopProjectMemory(params: unknown): Promise<{ stored: number }> {
  const { scope, record } = scopeFor(params)
  if (!scope.policy.enabled || !scope.policy.learn)
    throw new Error('Project lesson recording is disabled')
  if (
    !webSearchRecord(record.input) ||
    typeof record.input.content !== 'string' ||
    (record.input.context !== undefined && typeof record.input.context !== 'string')
  )
    throw new Error('Invalid project lesson')
  const input = {
    content: record.input.content,
    context: record.input.context as string | undefined,
    source: 'phi-learn',
    importance: 0.8
  }
  return call(scope, record.requestId, (project, signal) =>
    locked(project, async () => {
      guard(scope, project, signal)
      const stage = join(project.directory, 'learn-' + String(record.requestId))
      const stagedFile = join(getMemoryRoot(stage, project.target.cwd), 'learned.md')
      const canonical = join(
        getMemoryRoot(project.target.agentDir, project.target.cwd),
        'learned.md'
      )
      try {
        await mkdir(dirname(stagedFile), { recursive: true, mode: 0o700 })
        try {
          await writeFile(stagedFile, await readFile(canonical, 'utf8'), { mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        guard(scope, project, signal)
        const result = await saveLearnedLesson(stage, project.target.cwd, input)
        const contents = result.stored ? await readFile(stagedFile, 'utf8') : undefined
        guard(scope, project, signal)
        if (contents !== undefined) atomic(canonical, contents)
        return { stored: result.stored }
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    })
  )
}
export async function cancelDesktopProjectMemory(params: unknown): Promise<void> {
  if (!webSearchRecord(params) || !rpcIdentifier(params.scopeId))
    throw new Error('Invalid memory cancellation')
  const scope = scopes.get(params.scopeId)
  if (!scope) return
  const requestId = params.requestId
  if (requestId !== undefined && !rpcIdentifier(requestId))
    throw new Error('Invalid memory request cancellation')
  if (requestId === undefined) scope.controller.abort(new Error('Project memory scope retired'))
  else scope.calls.get(requestId)?.controller.abort(new Error('Project memory request cancelled'))
  await cancelJob(await scope.project, scope.id, requestId as string | undefined)
}
export async function closeDesktopProjectMemory(params: unknown): Promise<void> {
  if (!webSearchRecord(params) || !rpcIdentifier(params.scopeId))
    throw new Error('Invalid memory scope')
  const scope = scopes.get(params.scopeId)
  if (!scope) return
  await cancelDesktopProjectMemory({ scopeId: scope.id })
  await Promise.allSettled([...scope.calls.values()].map((value) => value.done))
  const project = await scope.project
  if (project.job?.owner === scope.id) await project.job.done
  scopes.delete(scope.id)
}
/** UI edits invalidate all stale writers in this project, while peer projects keep running. */
export async function mutateProjectMemory<T>(
  target: ProjectMemoryTarget,
  operation: () => Promise<T>,
  clear = false
): Promise<T> {
  const project = await projectFor(target)
  project.retiring++
  project.manifest.epoch++
  try {
    for (const scope of scopes.values())
      if (key(scope.target) === key(target))
        scope.controller.abort(new Error('Project memory changed'))
    const job = project.job
    await cancelJob(project)
    if (job) await job.done
    return await locked(project, async () => {
      if (clear) {
        project.manifest.clearCutoff = Date.now()
        for (const imported of Object.values(project.manifest.imports)) imported.published = true
      }
      persist(project)
      const value = await operation()
      if (clear) {
        await rm(project.sdk, { recursive: true, force: true })
        await rm(project.rollouts, { recursive: true, force: true })
      }
      return value
    })
  } finally {
    project.retiring--
  }
}
export async function closeAllDesktopProjectMemory(): Promise<void> {
  await Promise.allSettled(
    [...scopes.keys()].map((scopeId) => closeDesktopProjectMemory({ scopeId }))
  )
}
