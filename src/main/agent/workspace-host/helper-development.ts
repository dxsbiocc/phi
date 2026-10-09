import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  helperPlatform,
  remoteHelperDevelopmentRoot,
  resolveRemoteHelperArtifact,
  type RemoteHelperArtifact
} from './helper-installer'
import type { ProbedHostCapabilityProfile } from './probe-parse'

type BuildHelper = (root: string, target: string, signal: AbortSignal) => Promise<void>

interface HelperBuild {
  controller: AbortController
  promise: Promise<void>
  users: number
  settled: boolean
}

const builds = new Map<string, HelperBuild>()

function cancelled(): Error {
  const error = new Error('Development remote helper preparation was cancelled')
  error.name = 'AbortError'
  return error
}

function terminateCompiler(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      // This detached group belongs only to this build, including Go and download children.
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(error)
    }
    return Promise.resolve()
  }
  const taskkill = join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'taskkill.exe'
  )
  return new Promise((resolve, reject) => {
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) reject(error)
      else resolve()
    })
  })
}

export function buildDevelopmentHelper(
  root: string,
  target: string,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts', 'build-helper.mjs'), '--target', target],
      {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
    let stderr = ''
    let failure: Error | undefined
    const stop = (error: Error): void => {
      failure ??= error
      void terminateCompiler(child).catch((cause) => {
        failure = cause
      })
    }
    const abort = (): void => stop(cancelled())
    const timer = setTimeout(
      () => stop(new Error('Development remote helper preparation timed out')),
      120_000
    )
    timer.unref()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
    })
    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new Error(
            `Development remote helper build failed (${exitSignal ?? code})${stderr ? `: ${stderr}` : ''}`
          )
        )
      else resolve()
    })
  })
}

async function sharedBuild(
  root: string,
  target: string,
  runBuild: BuildHelper,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw cancelled()
  const key = `${resolve(root)}:${target}`
  let build = builds.get(key)
  if (!build || build.controller.signal.aborted) {
    const controller = new AbortController()
    const current: HelperBuild = {
      controller,
      promise: Promise.resolve().then(() => runBuild(root, target, controller.signal)),
      users: 0,
      settled: false
    }
    build = current
    builds.set(key, current)
    void current.promise
      .finally(() => {
        current.settled = true
        if (builds.get(key) === current) builds.delete(key)
      })
      .catch(() => undefined)
  }
  build.users += 1
  let onAbort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(cancelled())
      signal?.addEventListener('abort', onAbort, { once: true })
      build.promise.then(resolve, reject)
      if (signal?.aborted) onAbort()
    })
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    build.users -= 1
    if (build.users === 0 && !build.settled) {
      build.controller.abort()
      await build.promise.catch(() => undefined)
    }
  }
}

export function resolveRemoteHelperPreparation(
  profile: ProbedHostCapabilityProfile,
  options: {
    resourceRoot?: string
    developmentRoot?: string
    isPackaged?: boolean
    runBuild?: BuildHelper
  } = {}
):
  | {
      artifact: RemoteHelperArtifact
      prepareArtifact?: (signal?: AbortSignal) => Promise<RemoteHelperArtifact>
    }
  | undefined {
  const developmentRoot =
    options.isPackaged === true
      ? undefined
      : (options.developmentRoot ??
        (options.resourceRoot ? undefined : remoteHelperDevelopmentRoot()))
  const root = developmentRoot ? resolve(developmentRoot) : undefined
  const resourceRoot =
    options.resourceRoot ?? (root ? join(root, 'resources', 'remote-helper') : undefined)
  const artifact = resolveRemoteHelperArtifact(profile, resourceRoot)
  const target = helperPlatform(profile)
  if (!root || !target || !existsSync(join(root, 'scripts', 'build-helper.mjs'))) {
    return artifact ? { artifact } : undefined
  }
  let version: string
  try {
    version = readFileSync(join(root, 'helper', 'VERSION'), 'utf8').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) return artifact ? { artifact } : undefined
  } catch {
    return artifact ? { artifact } : undefined
  }
  return {
    artifact:
      artifact?.version === version ? artifact : { version, localPath: '', sha256: '0'.repeat(64) },
    async prepareArtifact(signal) {
      await sharedBuild(root, target, options.runBuild ?? buildDevelopmentHelper, signal)
      if (signal?.aborted) throw cancelled()
      const prepared = resolveRemoteHelperArtifact(profile, resourceRoot)
      if (!prepared || prepared.version !== version || !prepared.localPath) {
        throw new Error('Development remote helper build did not produce the requested artifact')
      }
      const actual = createHash('sha256')
        .update(await readFile(prepared.localPath))
        .digest('hex')
      if (actual !== prepared.sha256) throw new Error('Development remote helper sha256 mismatch')
      if (signal?.aborted) throw cancelled()
      return prepared
    }
  }
}
