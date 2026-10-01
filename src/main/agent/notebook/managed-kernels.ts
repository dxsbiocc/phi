// Managed notebook kernels (runtime foundation §5, roadmap 5.3).
//
// Phi owns one kernelspec directory, `<runtime root>/jupyter/kernels`. The managed Jupyter
// server searches only that directory. Managed kernels (`phi-python`, `phi-r`) are written
// there from their built environments; host kernels the user may pick explicitly are copied
// there as `host-<name>`, wrapped so they run with the host PATH instead of Phi's isolation.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import {
  EnvironmentNotReadyError,
  describeEnvironment,
  readyEnvironment,
  type EnvironmentDescriptor
} from '../content/environment-refs'
import { environmentVariables, type EnvHandle, type PhiPlatform } from '../envs'

export const HOST_KERNEL_LABEL = 'host (unmanaged)'
export const NOT_BUILT_KERNEL_LABEL = 'not built'
export const HOST_KERNEL_PREFIX = 'host-'

export type ManagedKernelName = 'phi-python' | 'phi-r'

export interface ManagedKernelDefinition {
  name: ManagedKernelName
  ref: string
  displayName: string
  language: string
}

/** Order is the default order: `phi-python` is the default kernel. */
export const MANAGED_KERNELS: readonly ManagedKernelDefinition[] = [
  {
    name: 'phi-python',
    ref: 'phi:python@1',
    displayName: 'Python 3.12 (phi-python)',
    language: 'python'
  },
  { name: 'phi-r', ref: 'phi:r@1', displayName: 'R 4.4 (phi-r)', language: 'R' }
]

export interface ManagedEnvironmentContext {
  /** Runtime root, normally `getRuntimeRoot()`. */
  root: string
  environmentsDir?: string
  platform?: PhiPlatform
  /** Host variables to read (defaults to `process.env`). */
  baseEnv?: NodeJS.ProcessEnv
  /** Host platform for the locale default (defaults to `process.platform`). */
  hostPlatform?: NodeJS.Platform
}

export interface KernelSpecFile {
  argv: string[]
  display_name: string
  language: string
  env?: Record<string, string>
  interrupt_mode?: 'signal' | 'message'
  metadata?: Record<string, unknown>
}

export type ManagedKernelState =
  | {
      definition: ManagedKernelDefinition
      status: 'ready'
      envId: string
      handle: EnvHandle
      resourceDir: string
      spec: KernelSpecFile
    }
  | {
      definition: ManagedKernelDefinition
      status: 'not-built'
      envId?: string
      message: string
    }

export interface HostKernelSource {
  name: string
  displayName: string
  resourceDir?: string
}

// Variables that make a Phi prefix, not the host, own a process. A host kernel launched by
// the managed server inherits them from the server and must shed them.
const ISOLATION_NAMES = [
  'PYTHONNOUSERSITE',
  'PYTHONDONTWRITEBYTECODE',
  'R_LIBS_USER',
  'R_LIBS_SITE',
  'R_PROFILE_USER',
  'R_ENVIRON_USER',
  'MPLBACKEND',
  'MPLCONFIGDIR',
  'NUMBA_CACHE_DIR',
  'XDG_CACHE_HOME',
  'PHI_ENV_ID',
  'PHI_ENV_PREFIX',
  'LC_ALL',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_SHLVL',
  'CONDA_PROMPT_MODIFIER'
] as const

// ipykernel only installs its inline backend when MPLBACKEND is unset; the isolation
// default (`Agg`) would make `plt.show()` in a notebook print nothing.
const PYTHON_KERNEL_EXTRA_ENV = { MPLBACKEND: 'module://matplotlib_inline.backend_inline' }

const LOCALE_NAME = /^(LANG|LC_[A-Z_]+)$/

export function jupyterHome(root: string): string {
  return join(root, 'jupyter')
}

export function managedKernelsDir(root: string): string {
  return join(jupyterHome(root), 'kernels')
}

/**
 * Variables that point Jupyter at Phi's own directories so the user's
 * `~/Library/Jupyter`, `~/.local/share/jupyter`, and `~/.jupyter` are never read.
 */
export function jupyterDirectoryVariables(root: string): Record<string, string> {
  const home = jupyterHome(root)
  return {
    JUPYTER_PATH: home,
    JUPYTER_DATA_DIR: join(home, 'data'),
    JUPYTER_CONFIG_DIR: join(home, 'config'),
    JUPYTER_RUNTIME_DIR: join(home, 'runtime')
  }
}

export function describeManagedEnvironment(
  ref: string,
  ctx: ManagedEnvironmentContext
): EnvironmentDescriptor {
  return describeEnvironment(ref, {
    ...(ctx.environmentsDir ? { environmentsDir: ctx.environmentsDir } : {}),
    ...(ctx.platform ? { platform: ctx.platform } : {})
  })
}

/** The environment when it is built and ready; otherwise `notBuilt` with the gate's wording. */
export function managedEnvironmentState(
  ref: string,
  ctx: ManagedEnvironmentContext
): { handle: EnvHandle } | { notBuilt: { envId?: string; message: string } } {
  try {
    return { handle: readyEnvironment(ctx.root, describeManagedEnvironment(ref, ctx)) }
  } catch (error) {
    if (error instanceof EnvironmentNotReadyError) {
      return {
        notBuilt: {
          envId: error.envId,
          message: `environment ${error.ref} is not ready; the user must build it first`
        }
      }
    }
    return { notBuilt: { message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * The kernel's own variables: the environment's `environmentVariables` without the kept host
 * variables (the server already passes those, and proxies may carry credentials that should
 * not be written to disk). Locale variables are kept so the locale default matches the host.
 */
export function kernelEnvironmentVariables(
  definition: ManagedKernelDefinition,
  handle: EnvHandle,
  ctx: Pick<ManagedEnvironmentContext, 'baseEnv' | 'hostPlatform'> = {}
): Record<string, string> {
  const host = ctx.baseEnv ?? process.env
  const locale: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(host)) {
    if (LOCALE_NAME.test(name) && value !== undefined) locale[name] = value
  }
  return environmentVariables(handle, {
    baseEnv: locale,
    ...(ctx.hostPlatform ? { platform: ctx.hostPlatform } : {}),
    ...(definition.language === 'python' ? { extraEnv: PYTHON_KERNEL_EXTRA_ENV } : {})
  })
}

const DEFAULT_IRKERNEL_ARGV = [
  'R',
  '--slave',
  '-e',
  'IRkernel::main()',
  '--args',
  '{connection_file}'
]

/** IRkernel's own installed spec when present, with its `R` replaced by the prefix's. */
function irkernelArgv(prefix: string): string[] {
  const installed = join(prefix, 'share', 'jupyter', 'kernels', 'ir', 'kernel.json')
  let argv = DEFAULT_IRKERNEL_ARGV
  try {
    const parsed = JSON.parse(readFileSync(installed, 'utf8')) as { argv?: unknown }
    if (
      Array.isArray(parsed.argv) &&
      parsed.argv.length > 0 &&
      parsed.argv.every((item) => typeof item === 'string') &&
      parsed.argv.includes('{connection_file}')
    ) {
      argv = parsed.argv as string[]
    }
  } catch {
    // Not installed there (or unreadable): use IRkernel's documented argv.
  }
  const [command, ...rest] = argv
  const r =
    command && command.includes('/') && command.startsWith(prefix)
      ? command
      : join(prefix, 'bin', 'R')
  return [r, ...rest]
}

export function managedKernelSpec(
  definition: ManagedKernelDefinition,
  handle: EnvHandle,
  ctx: Pick<ManagedEnvironmentContext, 'baseEnv' | 'hostPlatform'> = {}
): KernelSpecFile {
  const env = kernelEnvironmentVariables(definition, handle, ctx)
  const metadata = { phi: { managed: true, ref: definition.ref, envId: handle.envId } }
  if (definition.language === 'python') {
    return {
      argv: [
        join(handle.prefix, 'bin', 'python'),
        '-m',
        'ipykernel_launcher',
        '-f',
        '{connection_file}'
      ],
      display_name: definition.displayName,
      language: 'python',
      env,
      interrupt_mode: 'signal',
      metadata: { ...metadata, debugger: true }
    }
  }
  return {
    argv: irkernelArgv(handle.prefix),
    display_name: definition.displayName,
    language: 'R',
    env,
    interrupt_mode: 'signal',
    metadata
  }
}

function writeIfChanged(file: string, text: string): void {
  try {
    if (readFileSync(file, 'utf8') === text) return
  } catch {
    // Missing: write it.
  }
  writeFileSync(file, text)
}

function specText(spec: KernelSpecFile): string {
  return `${JSON.stringify(spec, null, 2)}\n`
}

/**
 * Writes the kernelspec of every built managed environment and removes the spec of any
 * environment that is not built, so the server never launches a missing prefix. A spec is
 * rewritten whenever its content changes, which includes every envId change.
 */
export function syncManagedKernels(ctx: ManagedEnvironmentContext): ManagedKernelState[] {
  const dir = managedKernelsDir(ctx.root)
  mkdirSync(dir, { recursive: true })
  return MANAGED_KERNELS.map((definition): ManagedKernelState => {
    const resourceDir = join(dir, definition.name)
    const state = managedEnvironmentState(definition.ref, ctx)
    if ('notBuilt' in state) {
      rmSync(resourceDir, { recursive: true, force: true })
      return {
        definition,
        status: 'not-built',
        message: state.notBuilt.message,
        ...(state.notBuilt.envId ? { envId: state.notBuilt.envId } : {})
      }
    }
    const spec = managedKernelSpec(definition, state.handle, ctx)
    mkdirSync(resourceDir, { recursive: true })
    writeIfChanged(join(resourceDir, 'kernel.json'), specText(spec))
    return {
      definition,
      status: 'ready',
      envId: state.handle.envId,
      handle: state.handle,
      resourceDir,
      spec
    }
  })
}

export function hostKernelName(name: string): string {
  return `${HOST_KERNEL_PREFIX}${name.toLocaleLowerCase()}`
}

/**
 * A host kernel launched by the managed server: `/usr/bin/env` restores the host's value of
 * every isolation variable (or unsets it) and the host PATH, then runs the host argv as is.
 */
export function hostKernelArgv(argv: string[], hostEnv: NodeJS.ProcessEnv): string[] {
  const wrapper = ['/usr/bin/env']
  const assignments: string[] = []
  for (const name of ISOLATION_NAMES) {
    const value = hostEnv[name]
    if (value === undefined) wrapper.push('-u', name)
    else assignments.push(`${name}=${value}`)
  }
  assignments.push(`PATH=${hostEnv.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`)
  return [...wrapper, ...assignments, ...argv]
}

function readKernelJson(resourceDir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(resourceDir, 'kernel.json'), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const argv = (parsed as { argv?: unknown }).argv
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((item) => typeof item === 'string')
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Copies each host kernelspec into Phi's kernel directory as `host-<name>`, with its argv
 * wrapped by `hostKernelArgv`. Stale `host-*` copies are removed. Returns the names written.
 */
export function syncHostKernels(
  root: string,
  kernels: readonly HostKernelSource[],
  hostEnv: NodeJS.ProcessEnv = process.env
): Set<string> {
  const dir = managedKernelsDir(root)
  mkdirSync(dir, { recursive: true })
  const written = new Set<string>()
  const managed = new Set<string>(MANAGED_KERNELS.map((kernel) => kernel.name))
  for (const kernel of kernels) {
    if (!kernel.resourceDir) continue
    const name = hostKernelName(kernel.name)
    if (managed.has(name) || !/^[a-z0-9._-]+$/.test(name)) continue
    const raw = readKernelJson(kernel.resourceDir)
    if (!raw) continue
    const target = join(dir, name)
    rmSync(target, { recursive: true, force: true })
    cpSync(kernel.resourceDir, target, { recursive: true, dereference: true })
    const spec = {
      ...raw,
      argv: hostKernelArgv(raw.argv as string[], hostEnv),
      display_name: kernel.displayName,
      metadata: {
        ...(typeof raw.metadata === 'object' && raw.metadata !== null ? raw.metadata : {}),
        phi: { managed: false, hostName: kernel.name, hostResourceDir: kernel.resourceDir }
      }
    }
    writeFileSync(join(target, 'kernel.json'), `${JSON.stringify(spec, null, 2)}\n`)
    written.add(name)
  }
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(HOST_KERNEL_PREFIX) && !written.has(entry)) {
        rmSync(join(dir, entry), { recursive: true, force: true })
      }
    }
  }
  return written
}
