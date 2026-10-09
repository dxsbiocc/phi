import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readLoginShellEnv } from './login-shell-env'

// The OMP worker runs under bun. An app launched from Finder/Dock inherits
// launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a bare
// `spawn('bun')` fails even when bun is installed. Resolve an absolute path
// instead, in this order:
//   1. PHI_BUN_PATH (explicit override)
//   2. the packaged bun runtime
//   3. the inherited PATH (terminal launches, dev)
//   4. well-known install locations (bun installer, Homebrew)
//   5. the user's login shell PATH (custom installs: asdf, mise, nix, ...)

export const BUN_PATH_ENV = 'PHI_BUN_PATH'

export type BunLookupOptions = {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  resourcesPath?: string
  /** Returns whether a candidate is an executable file. Injected by tests and shared callers. */
  isExecutableFile?: (filePath: string) => boolean
  /** Returns the login shell's PATH, or undefined. Injected by tests. */
  readLoginShellPath?: (env: NodeJS.ProcessEnv) => string | undefined
}

function bunFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun'
}

function bundledBunPath(
  resourcesPath: string | undefined,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  fileName: string
): string | undefined {
  return resourcesPath
    ? join(resourcesPath, 'runtime', 'bun', `${platform}-${arch}`, fileName)
    : undefined
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!isFile(filePath)) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findInPath(
  pathValue: string | undefined,
  fileName: string,
  isExecutable: (filePath: string) => boolean
): string | undefined {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, fileName)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

function wellKnownBunDirs(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  return [
    ...(env.BUN_INSTALL ? [join(env.BUN_INSTALL, 'bin')] : []),
    join(homeDir, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

export function readLoginShellPath(env: NodeJS.ProcessEnv): string | undefined {
  return readLoginShellEnv(env).PATH
}

export function findBunExecutable(options: BunLookupOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const fileName = bunFileName(platform)
  const isExecutable = options.isExecutableFile ?? isExecutableFile

  const explicit = env[BUN_PATH_ENV]
  if (explicit) return isExecutable(explicit) ? explicit : undefined

  const bundled = bundledBunPath(options.resourcesPath, platform, arch, fileName)
  if (bundled && isExecutable(bundled)) return bundled

  const fromPath = findInPath(env.PATH, fileName, isExecutable)
  if (fromPath) return fromPath

  const homeDir = options.homeDir ?? env.HOME ?? homedir()
  const fromKnownDirs = findInPath(
    wellKnownBunDirs(env, homeDir).join(delimiter),
    fileName,
    isExecutable
  )
  if (fromKnownDirs) return fromKnownDirs

  if (platform === 'win32') return undefined
  const loginPath = (options.readLoginShellPath ?? readLoginShellPath)(env)
  return findInPath(loginPath, fileName, isExecutable)
}

let cachedBunPath: string | undefined

/** Absolute path to bun; throws a user-facing error when it is not installed. */
export function resolveBunExecutable(options: BunLookupOptions = {}): string {
  const isExecutable = options.isExecutableFile ?? isExecutableFile
  if (cachedBunPath && isExecutable(cachedBunPath)) return cachedBunPath
  const found = findBunExecutable(options)
  if (!found) {
    const explicit = (options.env ?? process.env)[BUN_PATH_ENV]
    const platform = options.platform ?? process.platform
    const bundled = bundledBunPath(
      options.resourcesPath,
      platform,
      options.arch ?? process.arch,
      bunFileName(platform)
    )
    const bundledFailure = bundled && isFile(bundled) && !isExecutable(bundled)
    throw new Error(
      explicit
        ? `${BUN_PATH_ENV} 指向的 bun 不可执行：${explicit}`
        : `${bundledFailure ? `内置 bun 不可执行：${bundled}。` : ''}找不到 bun：Phi 的智能体需要 bun 才能运行。请安装 bun（https://bun.sh），或用 ${BUN_PATH_ENV} 指定其路径后重启 Phi。`
    )
  }
  cachedBunPath = found
  return found
}

/** PATH for the worker: bun's own directory first, so `bun`/`bunx` resolve inside it too. */
export function workerPathWithBun(bunPath: string, pathValue: string | undefined): string {
  const bunDir = dirname(bunPath)
  const rest = (pathValue ?? '').split(delimiter).filter((dir) => dir && dir !== bunDir)
  return [bunDir, ...rest].join(delimiter)
}
