import { isAbsolute, join, posix, resolve } from 'node:path'

export type KernelE2eTarget = 'local' | 'ssh'
export type KernelE2eScenario =
  | 'baseline'
  | 'tools'
  | 'plan'
  | 'isolation'
  | 'fork'
  | 'desktop-services'
  | 'desktop-engine'
  | 'reconnect'
  | 'grace-expiry'
  | 'model-proxy-reconnect'

export interface KernelE2eCliOptions {
  target: KernelE2eTarget
  runtimeRoot: string
  host?: string
  buildDirectory: string
  output?: string
  scenario: KernelE2eScenario
  helperPath?: string
  deadlineMinutes: number
}

export function kernelE2eUsage(): string {
  return [
    'Usage: bun scripts/kernel-e2e.ts --target local|ssh --runtime-root <absolute-path>',
    '       [--host <ssh-alias>] [--build-dir <target-build-directory>]',
    '       [--scenario baseline|tools|plan|isolation|fork|desktop-services|desktop-engine|reconnect|grace-expiry|model-proxy-reconnect]',
    '       [--helper-path <local-phi-helper>]',
    '       [--deadline-min <minutes, default 30>]',
    '       [--out <report.json>]',
    '',
    'SSH mode requires --host. The provider bearer token is random and valid only for this run.'
  ].join('\n')
}

export function parseKernelE2eArgs(argv: string[], packageVersion: string): KernelE2eCliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${kernelE2eUsage()}\n`)
    process.exit(0)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (
      ![
        '--target',
        '--host',
        '--runtime-root',
        '--build-dir',
        '--scenario',
        '--helper-path',
        '--deadline-min',
        '--out'
      ].includes(key)
    ) {
      throw new Error(`Unknown argument: ${key}\n${kernelE2eUsage()}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}\n${kernelE2eUsage()}`)
    }
    values.set(key, value)
  }

  const target = values.get('--target')
  if (target !== 'local' && target !== 'ssh') {
    throw new Error(`--target is required\n${kernelE2eUsage()}`)
  }
  const runtimeRoot = values.get('--runtime-root')
  if (!runtimeRoot || !isAbsolute(runtimeRoot) || /[\0\r\n]/.test(runtimeRoot)) {
    throw new Error('--runtime-root must be an absolute path without control characters')
  }
  const host = values.get('--host')
  if (target === 'ssh' && !host) throw new Error(`SSH mode requires --host\n${kernelE2eUsage()}`)
  const scenario = values.get('--scenario') ?? 'baseline'
  if (
    scenario !== 'baseline' &&
    scenario !== 'tools' &&
    scenario !== 'plan' &&
    scenario !== 'isolation' &&
    scenario !== 'fork' &&
    scenario !== 'desktop-services' &&
    scenario !== 'desktop-engine' &&
    scenario !== 'reconnect' &&
    scenario !== 'grace-expiry' &&
    scenario !== 'model-proxy-reconnect'
  ) {
    throw new Error(`Invalid --scenario: ${scenario}\n${kernelE2eUsage()}`)
  }
  if (
    scenario !== 'baseline' &&
    scenario !== 'tools' &&
    scenario !== 'plan' &&
    scenario !== 'isolation' &&
    scenario !== 'fork' &&
    target !== 'ssh'
  ) {
    throw new Error(`--scenario ${scenario} requires --target ssh`)
  }
  if (scenario === 'isolation' && target !== 'local') {
    throw new Error('--scenario isolation requires --target local')
  }
  const helperPath = values.get('--helper-path')
  if (helperPath && (!isAbsolute(helperPath) || /[\0\r\n]/.test(helperPath))) {
    throw new Error('--helper-path must be an absolute path without control characters')
  }
  const deadlineMinutes = Number(values.get('--deadline-min') ?? '30')
  if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) {
    throw new Error('--deadline-min must be a positive number')
  }
  const defaultTarget = target === 'ssh' ? 'linux-x64' : 'darwin-arm64'
  return {
    target,
    scenario,
    runtimeRoot: target === 'ssh' ? posix.normalize(runtimeRoot) : resolve(runtimeRoot),
    ...(host ? { host } : {}),
    buildDirectory: resolve(
      values.get('--build-dir') ?? join('.phi-build', 'kernel', packageVersion, defaultTarget)
    ),
    deadlineMinutes,
    ...(values.has('--out') ? { output: resolve(values.get('--out')!) } : {}),
    ...(helperPath ? { helperPath: resolve(helperPath) } : {})
  }
}
