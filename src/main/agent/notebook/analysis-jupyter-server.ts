import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { request } from 'node:http'

export type JupyterServerState = 'stopped' | 'starting' | 'ready' | 'error' | 'exited'

export interface JupyterServerPublicStatus {
  projectCwd: string
  state: JupyterServerState
  startedAt?: string
  exitedAt?: string
  pid?: number
  port?: number
  hasEndpoint: boolean
  message?: string
}

type JupyterEndpoint = {
  url: string
  token?: string
  port?: number
}

export type JupyterServerConnection = {
  url: string
  token?: string
}

export type JupyterServerLaunch = {
  port: number
}

type StreamLike = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export interface ManagedJupyterProcess {
  pid?: number
  stdout?: StreamLike | null
  stderr?: StreamLike | null
  killed?: boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  unref?: () => void
}

export type JupyterProcessFactory = (
  cwd: string,
  launch: JupyterServerLaunch
) => ManagedJupyterProcess
export type JupyterServerReadyProbe = (url: string) => Promise<boolean>
export type JupyterServerIdentityProbe = (url: string) => Promise<boolean>

type JupyterServerRecord = {
  projectCwd: string
  state: JupyterServerState
  process?: ManagedJupyterProcess
  startedAt?: string
  exitedAt?: string
  pid?: number
  port: number
  endpoint?: JupyterEndpoint
  message?: string
  logs: string[]
  pendingOutput: string
}

const MAX_LOG_LINES = 20
const MAX_PENDING_OUTPUT_LENGTH = 4000
export const PHI_JUPYTER_PORT = 28888
const READY_PROBE_ATTEMPTS = 40
const READY_PROBE_INTERVAL_MS = 250
const READY_PROBE_TIMEOUT_MS = 500
const JUPYTER_LOCAL_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s'"]*/i

export function jupyterPortForProject(projectCwd: string): number {
  void projectCwd
  // A single app-level port makes abnormal leftovers visible on the next start.
  return PHI_JUPYTER_PORT
}

export function jupyterServerArgs(launch: JupyterServerLaunch): string[] {
  return [
    'server',
    '--no-browser',
    '--ServerApp.ip=127.0.0.1',
    `--ServerApp.port=${launch.port}`,
    '--ServerApp.port_retries=0',
    '--ServerApp.open_browser=False',
    '--ServerApp.token=',
    '--ServerApp.password=',
    '--ServerApp.allow_remote_access=False'
  ]
}

function defaultProcessFactory(cwd: string, launch: JupyterServerLaunch): ManagedJupyterProcess {
  return spawn('jupyter', jupyterServerArgs(launch), {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function resolveProjectCwd(workingDirectory: string): string {
  const projectCwd = realpathSync(workingDirectory)
  if (!statSync(projectCwd).isDirectory()) {
    throw new Error('项目路径不是目录')
  }
  return projectCwd
}

function sanitizeMessage(text: string): string {
  return text.replace(/([?&]token=)[^\s&'"]+/gi, '$1<redacted>').slice(0, 500)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    timeout.unref?.()
  })
}

function defaultReadyProbe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request(url, { method: 'GET', timeout: READY_PROBE_TIMEOUT_MS }, (response) => {
      response.resume()
      resolve(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.on('error', () => resolve(false))
    probe.end()
  })
}

function defaultServerIdentityProbe(url: string): Promise<boolean> {
  // Jupyter Server always exposes GET /api/status returning a small JSON
  // object (e.g. {"started": "...", "kernels": 0, ...}). Anything else
  // listening on the port won't answer that shape, so this is a cheap way to
  // tell "a Jupyter Server is already here" apart from "something unrelated
  // is squatting on our port."
  return new Promise((resolve) => {
    const target = new URL('/api/status', url)
    const probe = request(
      target,
      { method: 'GET', timeout: READY_PROBE_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
            resolve(
              Boolean(
                body &&
                typeof body === 'object' &&
                !Array.isArray(body) &&
                'started' in (body as Record<string, unknown>)
              )
            )
          } catch {
            resolve(false)
          }
        })
        response.on('error', () => resolve(false))
      }
    )
    probe.on('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.on('error', () => resolve(false))
    probe.end()
  })
}

export function extractJupyterEndpoint(text: string): JupyterEndpoint | null {
  const match = text.match(JUPYTER_LOCAL_URL_PATTERN)
  if (!match) return null

  try {
    const url = new URL(match[0])
    const token = url.searchParams.get('token') ?? undefined
    url.searchParams.delete('token')
    return {
      url: url.toString(),
      token,
      port: Number(url.port)
    }
  } catch {
    return null
  }
}

function publicStatus(record: JupyterServerRecord): JupyterServerPublicStatus {
  return {
    projectCwd: record.projectCwd,
    state: record.state,
    startedAt: record.startedAt,
    exitedAt: record.exitedAt,
    pid: record.pid,
    port: record.endpoint?.port ?? record.port,
    hasEndpoint: Boolean(record.endpoint),
    message: record.message
  }
}

export class JupyterServerRegistry {
  private readonly records = new Map<string, JupyterServerRecord>()
  private readonly createProcess: JupyterProcessFactory
  private readonly readyProbe: JupyterServerReadyProbe
  private readonly identityProbe: JupyterServerIdentityProbe
  private readonly readyProbeAttempts: number
  private readonly readyProbeIntervalMs: number
  private readonly now: () => Date

  constructor(
    options: {
      createProcess?: JupyterProcessFactory
      readyProbe?: JupyterServerReadyProbe
      identityProbe?: JupyterServerIdentityProbe
      readyProbeAttempts?: number
      readyProbeIntervalMs?: number
      now?: () => Date
    } = {}
  ) {
    this.createProcess = options.createProcess ?? defaultProcessFactory
    this.readyProbe = options.readyProbe ?? defaultReadyProbe
    this.identityProbe = options.identityProbe ?? defaultServerIdentityProbe
    this.readyProbeAttempts = options.readyProbeAttempts ?? READY_PROBE_ATTEMPTS
    this.readyProbeIntervalMs = options.readyProbeIntervalMs ?? READY_PROBE_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
  }

  status(workingDirectory: string): JupyterServerPublicStatus {
    const projectCwd = resolveProjectCwd(workingDirectory)
    return publicStatus(
      this.records.get(projectCwd) ?? {
        projectCwd,
        port: jupyterPortForProject(projectCwd),
        state: 'stopped',
        logs: [],
        pendingOutput: ''
      }
    )
  }

  connection(workingDirectory: string): JupyterServerConnection | null {
    const projectCwd = resolveProjectCwd(workingDirectory)
    const record = this.records.get(projectCwd)
    if (!record?.endpoint || record.state !== 'ready') return null
    return { ...record.endpoint }
  }

  start(workingDirectory: string): JupyterServerPublicStatus {
    const projectCwd = resolveProjectCwd(workingDirectory)
    const existing = this.records.get(projectCwd)
    if (existing && (existing.state === 'starting' || existing.state === 'ready')) {
      return publicStatus(existing)
    }

    const record: JupyterServerRecord = {
      projectCwd,
      port: jupyterPortForProject(projectCwd),
      state: 'starting',
      startedAt: this.now().toISOString(),
      message: '正在启动 Jupyter Server',
      logs: [],
      pendingOutput: ''
    }
    this.records.set(projectCwd, record)

    try {
      const process = this.createProcess(projectCwd, { port: record.port })
      record.process = process
      record.pid = process.pid
      process.unref?.()
      process.stdout?.on('data', (chunk) => this.consumeOutput(record, chunk))
      process.stderr?.on('data', (chunk) => this.consumeOutput(record, chunk))
      process.on('error', (error) => this.markError(record, error))
      process.on('exit', (code, signal) => this.markExited(record, code, signal))
      this.scheduleReadyProbe(record)
    } catch (error) {
      this.markError(record, error)
    }

    return publicStatus(record)
  }

  stop(workingDirectory: string): JupyterServerPublicStatus {
    const projectCwd = resolveProjectCwd(workingDirectory)
    const record = this.records.get(projectCwd)
    if (!record) {
      return this.status(projectCwd)
    }

    if (record.process && !record.process.killed) {
      record.process.kill('SIGTERM')
    }
    record.state = 'stopped'
    record.exitedAt = this.now().toISOString()
    record.message = 'Jupyter Server 已停止'
    return publicStatus(record)
  }

  disposeAll(): void {
    for (const record of this.records.values()) {
      if (record.process && !record.process.killed) {
        record.process.kill('SIGTERM')
      }
      record.state = 'stopped'
      record.exitedAt = this.now().toISOString()
      record.message = 'Jupyter Server 已停止'
    }
  }

  private consumeOutput(record: JupyterServerRecord, chunk: Buffer | string): void {
    // Buffer across chunks: a process pipe can split a single line (including
    // the ready-URL banner) across multiple 'data' events, so search for the
    // endpoint in the combined text before splitting into complete lines.
    const combined = record.pendingOutput + chunk.toString()

    const lastNewlineIndex = combined.lastIndexOf('\n')
    const completeText = lastNewlineIndex >= 0 ? combined.slice(0, lastNewlineIndex) : ''
    const remainder = lastNewlineIndex >= 0 ? combined.slice(lastNewlineIndex + 1) : combined
    record.pendingOutput = remainder.slice(-MAX_PENDING_OUTPUT_LENGTH)

    const lines = completeText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(sanitizeMessage)
    if (lines.length > 0) {
      record.logs.push(...lines)
      record.logs.splice(0, Math.max(0, record.logs.length - MAX_LOG_LINES))
      record.message = lines.at(-1) ?? record.message
    }

    // markReady (which sets a clean, sanitized status message) must run last
    // so it wins over the raw log line set above.
    const endpoint = extractJupyterEndpoint(combined)
    if (endpoint) {
      this.markReady(record, endpoint)
    }
  }

  private markReady(record: JupyterServerRecord, endpoint: JupyterEndpoint): void {
    record.endpoint = endpoint
    record.port = endpoint.port ?? record.port
    record.state = 'ready'
    record.message = 'Jupyter Server 已就绪'
  }

  private scheduleReadyProbe(record: JupyterServerRecord): void {
    void this.probeUntilReady(record)
  }

  private async probeUntilReady(record: JupyterServerRecord): Promise<void> {
    for (let attempt = 0; attempt < this.readyProbeAttempts; attempt += 1) {
      await delay(this.readyProbeIntervalMs)
      if (record.state !== 'starting' || record.process?.killed) return

      const url = `http://127.0.0.1:${record.port}/`
      if (await this.readyProbe(url)) {
        if (record.state !== 'starting' || record.process?.killed) return
        this.markReady(record, {
          url,
          port: record.port
        })
        return
      }
    }
  }

  private markError(record: JupyterServerRecord, error: unknown): void {
    record.state = 'error'
    record.message = sanitizeMessage(errorMessage(error))
    record.exitedAt = this.now().toISOString()
  }

  private markExited(
    record: JupyterServerRecord,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (record.state === 'stopped') return
    if (code !== 0) {
      // The process we just spawned can die immediately because our fixed
      // port is already held by a Jupyter Server left running from a prior
      // Phi session (spawned processes are intentionally unref()'d, so they
      // outlive an app restart or crash). Adopt that server instead of
      // surfacing a spurious "Jupyter Server won't start" failure -- the
      // user just wants a working kernel, not to know an old process leaked.
      void this.tryAdoptRunningServer(record, code, signal)
      return
    }
    record.state = 'exited'
    record.exitedAt = this.now().toISOString()
    record.message = 'Jupyter Server 已退出'
  }

  private async tryAdoptRunningServer(
    record: JupyterServerRecord,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const url = `http://127.0.0.1:${record.port}/`
    const isJupyterServer = await this.identityProbe(url)
    if (record.state === 'stopped') return
    if (isJupyterServer) {
      this.markReady(record, { url, port: record.port })
      return
    }
    record.state = 'error'
    record.exitedAt = this.now().toISOString()
    const portConflict = record.logs.some((line) =>
      /port .*(already in use|not available)/i.test(line)
    )
    record.message = portConflict
      ? `端口 ${record.port} 已被其他进程占用，且该进程不是可用的 Jupyter Server`
      : `Jupyter Server 异常退出${code === null ? '' : ` (${code})`}${signal ? ` ${signal}` : ''}`
  }
}
