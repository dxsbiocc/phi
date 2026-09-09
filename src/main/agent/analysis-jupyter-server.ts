import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'

export type JupyterServerState = 'stopped' | 'starting' | 'ready' | 'error' | 'exited'

export interface JupyterServerPublicStatus {
  projectCwd: string
  state: JupyterServerState
  startedAt?: string
  exitedAt?: string
  pid?: number
  hasEndpoint: boolean
  message?: string
}

type JupyterEndpoint = {
  url: string
  token?: string
}

export type JupyterServerConnection = {
  url: string
  token?: string
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

export type JupyterProcessFactory = (cwd: string) => ManagedJupyterProcess

type JupyterServerRecord = {
  projectCwd: string
  state: JupyterServerState
  process?: ManagedJupyterProcess
  startedAt?: string
  exitedAt?: string
  pid?: number
  endpoint?: JupyterEndpoint
  message?: string
  logs: string[]
}

const MAX_LOG_LINES = 20
const JUPYTER_LOCAL_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s'"]*/i

function defaultProcessFactory(cwd: string): ManagedJupyterProcess {
  return spawn(
    'jupyter',
    [
      'server',
      '--no-browser',
      '--ServerApp.ip=127.0.0.1',
      '--ServerApp.open_browser=False',
      '--ServerApp.allow_remote_access=False'
    ],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
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

export function extractJupyterEndpoint(text: string): JupyterEndpoint | null {
  const match = text.match(JUPYTER_LOCAL_URL_PATTERN)
  if (!match) return null

  try {
    const url = new URL(match[0])
    const token = url.searchParams.get('token') ?? undefined
    url.searchParams.delete('token')
    return {
      url: url.toString(),
      token
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
    hasEndpoint: Boolean(record.endpoint),
    message: record.message
  }
}

export class JupyterServerRegistry {
  private readonly records = new Map<string, JupyterServerRecord>()
  private readonly createProcess: JupyterProcessFactory
  private readonly now: () => Date

  constructor(options: { createProcess?: JupyterProcessFactory; now?: () => Date } = {}) {
    this.createProcess = options.createProcess ?? defaultProcessFactory
    this.now = options.now ?? (() => new Date())
  }

  status(workingDirectory: string): JupyterServerPublicStatus {
    const projectCwd = resolveProjectCwd(workingDirectory)
    return publicStatus(
      this.records.get(projectCwd) ?? {
        projectCwd,
        state: 'stopped',
        logs: []
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
      state: 'starting',
      startedAt: this.now().toISOString(),
      message: '正在启动 Jupyter Server',
      logs: []
    }
    this.records.set(projectCwd, record)

    try {
      const process = this.createProcess(projectCwd)
      record.process = process
      record.pid = process.pid
      process.unref?.()
      process.stdout?.on('data', (chunk) => this.consumeOutput(record, chunk))
      process.stderr?.on('data', (chunk) => this.consumeOutput(record, chunk))
      process.on('error', (error) => this.markError(record, error))
      process.on('exit', (code, signal) => this.markExited(record, code, signal))
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
    const text = chunk.toString()
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(sanitizeMessage)
    record.logs.push(...lines)
    record.logs.splice(0, Math.max(0, record.logs.length - MAX_LOG_LINES))
    record.message = lines.at(-1) ?? record.message

    const endpoint = extractJupyterEndpoint(text)
    if (endpoint) {
      record.endpoint = endpoint
      record.state = 'ready'
      record.message = 'Jupyter Server 已就绪'
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
    record.state = code === 0 ? 'exited' : 'error'
    record.exitedAt = this.now().toISOString()
    record.message =
      code === 0
        ? 'Jupyter Server 已退出'
        : `Jupyter Server 异常退出${code === null ? '' : ` (${code})`}${signal ? ` ${signal}` : ''}`
  }
}
