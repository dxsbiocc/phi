import { execFile } from 'node:child_process'
import { get as getHttp } from 'node:http'
import { createServer } from 'node:net'

import type { OfficeCliRunResult } from './office-driver'
import { officeCliEnv, runOfficeCli } from './office-driver'
import type { OfficeArtifact } from './office-files'

const LOOPBACK_HOST = '127.0.0.1'
const WATCH_READY_TIMEOUT_MS = 15_000
const WATCH_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export interface WatchProcessHandle {
  artifact: OfficeArtifact
  binaryPath: string
  pid: number
  port: number
  stop: () => Promise<void>
}

export class OfficeWatchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OfficeWatchError'
  }
}

export function assertOfficeWatchCleanupResult(result: OfficeCliRunResult): void {
  if (result.spawnError || result.timedOut || result.truncated || result.exitCode !== 0) {
    throw new OfficeWatchError('unwatch-failed', 'Office watch 停止失败')
  }
}

export function availableOfficePreviewPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new OfficeWatchError('port-unavailable', '无法分配 Office 预览端口'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = getHttp(
      { hostname: LOOPBACK_HOST, port, path: '/', timeout: 500 },
      (response) => {
        response.resume()
        resolve((response.statusCode ?? 500) < 500)
      }
    )
    request.once('timeout', () => request.destroy())
    request.once('error', () => resolve(false))
  })
}

export function isOwnedLoopbackListener(pid: number, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf8' },
      (_error, stdout) => resolve(stdout.includes(`TCP 127.0.0.1:${port} (LISTEN)`))
    )
  })
}

function watchExitError(result: OfficeCliRunResult): OfficeWatchError {
  return new OfficeWatchError(
    result.stderr.includes('Address already in use') ? 'port-conflict' : 'watch-failed',
    'Office watch 启动失败'
  )
}

async function waitUntilReady(
  port: number,
  pid: number,
  exited: () => OfficeCliRunResult | undefined
): Promise<void> {
  const deadline = Date.now() + WATCH_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const beforeProbe = exited()
    if (beforeProbe) throw watchExitError(beforeProbe)
    if (pid > 0 && (await isOwnedLoopbackListener(pid, port)) && (await probe(port))) {
      const afterProbe = exited()
      if (afterProbe) throw watchExitError(afterProbe)
      return
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new OfficeWatchError('watch-timeout', 'Office watch 启动超时')
}

export async function startOfficeWatchProcess(
  binaryPath: string,
  artifact: OfficeArtifact,
  port: number
): Promise<WatchProcessHandle> {
  const controller = new AbortController()
  let pid = 0
  let exitResult: OfficeCliRunResult | undefined
  const result = runOfficeCli(binaryPath, ['watch', artifact.draftPath, '--port', String(port)], {
    timeoutMs: 0,
    signal: controller.signal,
    env: officeCliEnv(process.env, WATCH_ENV),
    onSpawn: (spawnedPid) => {
      pid = spawnedPid
    }
  }).then((value) => {
    exitResult = value
    return value
  })
  try {
    await waitUntilReady(port, pid, () => exitResult)
  } catch (error) {
    controller.abort()
    await result.catch(() => undefined)
    throw error
  }
  if (pid <= 0) throw new OfficeWatchError('watch-failed', '无法登记 Office watch 进程')
  return {
    artifact,
    binaryPath,
    pid,
    port,
    stop: async () => {
      const stopped = await runOfficeCli(binaryPath, ['unwatch', artifact.draftPath], {
        timeoutMs: 5_000,
        env: officeCliEnv(process.env, WATCH_ENV)
      })
      assertOfficeWatchCleanupResult(stopped)
      controller.abort()
      await result.catch(() => undefined)
    }
  }
}
