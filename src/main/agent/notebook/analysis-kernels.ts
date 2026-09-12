import { execFileSync } from 'node:child_process'

export type AnalysisKernelLanguage = 'python' | 'r' | 'other'

export interface AnalysisKernelSummary {
  name: string
  displayName: string
  language: AnalysisKernelLanguage
  rawLanguage: string
  resourceDir?: string
  executable?: string
}

export interface JupyterServerStatus {
  available: boolean
  command: 'jupyter'
  version?: string
  error?: string
}

export interface AnalysisKernelDiagnostics {
  jupyterServer: JupyterServerStatus
  kernels: AnalysisKernelSummary[]
  preferredKernelName?: string
  hasPythonKernel: boolean
  hasRKernel: boolean
  messages: string[]
}

type RawKernelspec = {
  resource_dir?: unknown
  spec?: {
    argv?: unknown
    display_name?: unknown
    language?: unknown
  }
}

type CommandRunner = (command: string, args: string[]) => string

function runCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Jupyter kernelspec output must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function normalizeLanguage(language: unknown): AnalysisKernelLanguage {
  if (typeof language !== 'string') return 'other'
  const value = language.toLocaleLowerCase()
  if (value === 'python' || value.startsWith('python')) return 'python'
  if (value === 'r' || value === 'ir') return 'r'
  return 'other'
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function executableFromArgv(argv: unknown): string | undefined {
  return Array.isArray(argv) ? firstString(argv[0]) : undefined
}

function normalizeKernel(name: string, raw: RawKernelspec): AnalysisKernelSummary {
  const spec = raw.spec ?? {}
  const displayName = firstString(spec.display_name) ?? name
  const rawLanguage = firstString(spec.language) ?? 'unknown'
  return {
    name,
    displayName,
    language: normalizeLanguage(rawLanguage),
    rawLanguage,
    resourceDir: firstString(raw.resource_dir),
    executable: executableFromArgv(spec.argv)
  }
}

function normalizeKernelspecs(text: string): AnalysisKernelSummary[] {
  const payload = parseJsonObject(text)
  const rawKernelspecs = payload.kernelspecs
  if (!rawKernelspecs || typeof rawKernelspecs !== 'object' || Array.isArray(rawKernelspecs)) {
    throw new Error('Jupyter kernelspec output is missing kernelspecs')
  }

  return Object.entries(rawKernelspecs as Record<string, RawKernelspec>)
    .map(([name, raw]) => normalizeKernel(name, raw))
    .sort((a, b) => {
      if (a.language !== b.language) {
        const priority = { python: 0, r: 1, other: 2 }
        return priority[a.language] - priority[b.language]
      }
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    })
}

function preferredKernel(kernels: AnalysisKernelSummary[]): string | undefined {
  return (
    kernels.find((kernel) => kernel.name === 'python3')?.name ??
    kernels.find((kernel) => kernel.language === 'python')?.name ??
    kernels.find((kernel) => kernel.language === 'r')?.name
  )
}

export function detectAnalysisKernels(
  runner: CommandRunner = runCommand
): AnalysisKernelDiagnostics {
  const messages: string[] = []
  let jupyterServer: JupyterServerStatus

  try {
    const version = runner('jupyter', ['server', '--version']).trim()
    jupyterServer = {
      available: true,
      command: 'jupyter',
      version: version || undefined
    }
  } catch (error) {
    jupyterServer = {
      available: false,
      command: 'jupyter',
      error: errorMessage(error)
    }
    messages.push('未检测到可用的 Jupyter Server。')
  }

  let kernels: AnalysisKernelSummary[] = []
  if (jupyterServer.available) {
    try {
      kernels = normalizeKernelspecs(runner('jupyter', ['kernelspec', 'list', '--json']))
    } catch (error) {
      messages.push(`无法读取 Jupyter kernelspec: ${errorMessage(error)}`)
    }
  }

  const hasPythonKernel = kernels.some((kernel) => kernel.language === 'python')
  const hasRKernel = kernels.some((kernel) => kernel.language === 'r')
  if (jupyterServer.available && !hasPythonKernel) {
    messages.push('未检测到 Python kernel。')
  }
  if (jupyterServer.available && !hasRKernel) {
    messages.push('未检测到 R kernel。')
  }

  return {
    jupyterServer,
    kernels,
    preferredKernelName: preferredKernel(kernels),
    hasPythonKernel,
    hasRKernel,
    messages
  }
}
