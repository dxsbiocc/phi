import { execFile, fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

import type {
  EnvironmentGetResult,
  EnvironmentSnapshot,
  EnvironmentToolId
} from '../../../shared/environmentTypes'

type EnvironmentOperation =
  | { operation: 'get' | 'redetect' | 'dismissSummary' }
  | { operation: 'setToolPath'; toolId: EnvironmentToolId; path: string | null }

export type EnvironmentWorkerRequest = { agentDir: string } & EnvironmentOperation

export type EnvironmentWorkerResponse =
  | { result: EnvironmentGetResult | EnvironmentSnapshot }
  | { error: { name: string; message: string; stack?: string } }

function terminateScan(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      // Only this scan owns the detached group, including its synchronous tool probes.
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

export function createBackgroundEnvironment({
  agentDir,
  workerUrl = new URL('./environment-worker.mjs', import.meta.url)
}: {
  agentDir: string
  workerUrl?: URL
}): {
  get: () => Promise<EnvironmentGetResult>
  redetect: () => Promise<EnvironmentSnapshot>
  dismissSummary: () => Promise<EnvironmentSnapshot>
  setToolPath: (id: EnvironmentToolId, path: string | null) => Promise<EnvironmentSnapshot>
  dispose: () => Promise<void>
} {
  let queue = Promise.resolve()
  let disposed = false
  let disposal: Promise<void> | undefined
  let active:
    { child: ChildProcess; reject: (error: Error) => void; exited: Promise<void> } | undefined

  function run<T>(request: EnvironmentWorkerRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = fork(workerUrl, {
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      let response: EnvironmentWorkerResponse | undefined
      let failure: Error | undefined
      let stderr = ''
      let settled = false
      let resolveExit!: () => void
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve
      })
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (active?.child === child) active = undefined
        if (error) reject(error)
        else if (response && 'result' in response) resolve(response.result as T)
        else
          reject(
            new Error(`Environment worker exited without a result${stderr ? `: ${stderr}` : ''}`)
          )
      }
      active = { child, reject: finish, exited }
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
      })
      child.once('message', (message: EnvironmentWorkerResponse) => {
        response = message
        if ('error' in message) {
          failure = new Error(message.error.message)
          failure.name = message.error.name
          failure.stack = message.error.stack
        }
      })
      child.once('error', (error) => {
        failure = error
        if (!child.pid) {
          resolveExit()
          finish(error)
        }
      })
      child.once('exit', (code, signal) => {
        resolveExit()
        finish(
          failure ??
            (code !== 0
              ? new Error(
                  `Environment worker exited with ${signal ?? `code ${code}`}${stderr ? `: ${stderr}` : ''}`
                )
              : undefined)
        )
      })
      child.send(request, (error) => {
        if (!error || settled) return
        failure = error
        void terminateScan(child).catch((cause) => finish(cause))
      })
    })
  }

  function enqueue<T>(operation: EnvironmentOperation): Promise<T> {
    if (disposed) return Promise.reject(new Error('Environment service is disposed'))
    const result = queue.then(() => {
      if (disposed) throw new Error('Environment service is disposed')
      return run<T>({ ...operation, agentDir })
    })
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    get: () => enqueue({ operation: 'get' }),
    redetect: () => enqueue({ operation: 'redetect' }),
    dismissSummary: () => enqueue({ operation: 'dismissSummary' }),
    setToolPath: (toolId, path) => enqueue({ operation: 'setToolPath', toolId, path }),
    dispose: () => {
      if (disposal) return disposal
      disposed = true
      const current = active
      current?.reject(new Error('Environment service is disposed'))
      disposal = current
        ? terminateScan(current.child).then(() => current.exited)
        : Promise.resolve()
      return disposal
    }
  }
}
