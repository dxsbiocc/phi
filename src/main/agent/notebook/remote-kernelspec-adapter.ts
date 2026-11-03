import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import type { RemoteJupyterStartJobStepMetadata } from '../../../shared/remoteJupyterJobTypes'
import { bundledEnvironmentsDir } from '../content/environment-refs'
import { parseEnvironmentSpec } from '../envs'
import type { RemoteEnvironmentService } from '../remote-runtime/environment-service'
import type {
  OpenRemoteRuntimeWorkspace,
  RemoteEnvironmentHandle,
  RemoteRuntimeWorkspace
} from '../remote-runtime/types'
import type { AnalysisKernelDiagnostics, AnalysisKernelSummary } from './analysis-kernels'
import { HOST_KERNEL_LABEL, hostKernelName, type KernelSpecFile } from './managed-kernels'
import type { RemoteJupyterLaunchCommand } from './remote-jupyter-server'

const REMOTE_JUPYTER_REF = 'phi:jupyter@1'
const REMOTE_JUPYTER_SPEC = 'remote-environment.yml'
const MANAGED_KERNEL_NAME = 'phi-python'
const MANAGED_KERNEL_DISPLAY_NAME = 'Python 3.12 (phi-python)'
const SERVER_KERNEL_NAME = 'server-python'
// This value is persisted in kernelspec/notebook data; the renderer localizes SERVER_KERNEL_NAME.
const SERVER_KERNEL_LABEL = '服务器现有环境'
const DETECT_TIMEOUT_MS = 45_000

type RemoteEnvironmentGateway = Pick<RemoteEnvironmentService, 'request' | 'bindSession' | 'cancel'>

export type MissingRemoteJupyterResolution =
  { choice: 'path'; path: string } | { choice: 'install' } | { choice: 'cancel' }
type MissingRemoteJupyterRecovery = Exclude<MissingRemoteJupyterResolution, { choice: 'cancel' }>

export interface ResolveMissingRemoteJupyterInput {
  runtimeSessionId: string
  signal: AbortSignal | undefined
}

export type ResolveMissingRemoteJupyter = (
  input: ResolveMissingRemoteJupyterInput
) => Promise<MissingRemoteJupyterResolution>

export interface RemoteKernelspecAdapterOptions {
  environments: RemoteEnvironmentGateway
  openWorkspace: OpenRemoteRuntimeWorkspace
  environmentsDir?: string
  allowUserPrefixes?: boolean
  /** The Jupyter path saved in the host's remote settings; tried before PATH. */
  configuredJupyterPath?: () => string | undefined
  /** Pauses startup so the main process can ask how to recover from a missing Jupyter. */
  resolveMissingJupyter?: ResolveMissingRemoteJupyter
}

/** A Jupyter Server already installed on the server, with an ipykernel-capable Python. */
export interface ExistingRemoteJupyter {
  jupyter: string
  python: string
  version?: string
}

export interface PrepareRemoteJupyterInput {
  runtimeSessionId: string
  /** Active chat runtime used only to place the missing-tool card in the right conversation. */
  promptRuntimeSessionId?: string
  requestId?: string
  signal?: AbortSignal
  /** Human-readable steps for the startup log. */
  onProgress?: (text: string, metadata?: RemoteJupyterStartJobStepMetadata) => void
}

export interface ListRemoteKernelsInput {
  runtimeSessionId: string
  signal?: AbortSignal
}

export interface PreparedRemoteJupyterRuntime {
  kernels: AnalysisKernelDiagnostics
  launch: RemoteJupyterLaunchCommand
  /** Which Jupyter runs: one found on the server, or Phi's managed environment. */
  source: 'existing' | 'managed'
}

export interface RegisterRemoteUserPrefixInput {
  runtimeSessionId: string
  name: string
  prefix: string
}

function reportExistingJupyterCheck(input: PrepareRemoteJupyterInput, configured?: string): void {
  input.onProgress?.(
    configured
      ? `Checking Jupyter path ${configured} and the server login shell's PATH…`
      : "Checking the server login shell's PATH for an existing Jupyter…",
    configured
      ? { code: 'checking_configured_jupyter', params: { configuredPath: configured } }
      : { code: 'checking_server_path_jupyter' }
  )
}

function reportExistingJupyter(
  input: PrepareRemoteJupyterInput,
  existing: { jupyter: string; python: string; version?: string }
): void {
  input.onProgress?.(
    `Using existing server Jupyter: ${existing.jupyter}${existing.version ? ` (jupyter_server ${existing.version})` : ''}; kernel Python: ${existing.python}`,
    {
      code: 'using_existing_jupyter',
      params: {
        jupyterPath: existing.jupyter,
        pythonPath: existing.python,
        ...(existing.version ? { version: existing.version } : {})
      }
    }
  )
}

export class RemoteKernelspecAdapter {
  constructor(private readonly options: RemoteKernelspecAdapterOptions) {}

  async prepare(input: PrepareRemoteJupyterInput): Promise<AnalysisKernelDiagnostics> {
    await this.requestEnvironment(input)
    return this.list(input)
  }

  async prepareRuntime(input: PrepareRemoteJupyterInput): Promise<PreparedRemoteJupyterRuntime> {
    const existing = await this.prepareExistingRuntime(input)
    if (existing) return existing
    const readyManaged = await this.readyManagedEnvironment(input.runtimeSessionId, input.signal)
    if (readyManaged) return this.preparedManagedRuntime(input, readyManaged)
    const resolution = await this.resolveMissingJupyter(input)
    if (resolution.choice === 'path') {
      const selected = resolution.path.trim()
      if (!posix.isAbsolute(selected) || /[\0\r\n]/.test(selected)) {
        throw new Error(
          'blocked: the selected Jupyter path must be an absolute remote path; Phi did not install anything.'
        )
      }
      const prepared = await this.prepareExistingRuntime(input, selected)
      if (!prepared) {
        throw new Error(
          'blocked: the selected Jupyter path is not a usable Jupyter Server with ipykernel; Phi did not install anything.'
        )
      }
      return prepared
    }
    input.onProgress?.(
      'No usable Jupyter Server was found on the server (jupyter server and ipykernel are required). Using Phi managed environment phi:jupyter@1; first-time setup may take a few minutes.',
      {
        code: 'missing_jupyter_using_managed',
        params: { environmentRef: REMOTE_JUPYTER_REF }
      }
    )
    await this.requestEnvironment(input)
    input.signal?.throwIfAborted()
    const handle = await this.bindManagedEnvironment(input.runtimeSessionId, input.signal)
    return this.preparedManagedRuntime(input, handle)
  }

  private async preparedManagedRuntime(
    input: PrepareRemoteJupyterInput,
    handle: RemoteEnvironmentHandle
  ): Promise<PreparedRemoteJupyterRuntime> {
    const kernels = await this.list(input)
    const workspace = await this.options.openWorkspace(input.runtimeSessionId, input.signal)
    try {
      assertManagedPrefix(workspace, handle)
      await prepareJupyterDirectories(workspace)
      const jupyterPath = posix.join(handle.prefix, 'bin', 'jupyter')
      input.onProgress?.(`Using Jupyter from the managed environment: ${jupyterPath}`, {
        code: 'using_managed_jupyter',
        params: { jupyterPath }
      })
      return {
        kernels,
        launch: remoteJupyterLaunch(workspace, jupyterPath),
        source: 'managed'
      }
    } finally {
      await workspace.close?.().catch(() => undefined)
    }
  }

  /** Uses a Jupyter already on the server when one is complete enough to run notebooks. */
  private async prepareExistingRuntime(
    input: PrepareRemoteJupyterInput,
    selectedJupyterPath?: string
  ): Promise<PreparedRemoteJupyterRuntime | undefined> {
    const workspace = await this.options.openWorkspace(input.runtimeSessionId, input.signal)
    try {
      const configured =
        selectedJupyterPath ?? (this.options.configuredJupyterPath?.()?.trim() || undefined)
      reportExistingJupyterCheck(input, configured)
      const existing = await detectExistingRemoteJupyter(workspace, configured, input.signal)
      if (!existing) return undefined
      if (selectedJupyterPath && existing.jupyter !== selectedJupyterPath) return undefined
      input.signal?.throwIfAborted()
      reportExistingJupyter(input, existing)
      // The spec creates jupyter/ first; the parallel mkdirs below would race on it.
      await writeSpec(workspace, SERVER_KERNEL_NAME, serverPythonSpec(existing))
      await prepareJupyterDirectories(workspace)
      if (this.options.allowUserPrefixes !== true) await removeUserSpecs(workspace)
      return {
        kernels: existingDiagnostics(existing),
        launch: remoteJupyterLaunch(workspace, existing.jupyter),
        source: 'existing'
      }
    } finally {
      await workspace.close?.().catch(() => undefined)
    }
  }

  private async resolveMissingJupyter(
    input: PrepareRemoteJupyterInput
  ): Promise<MissingRemoteJupyterRecovery> {
    const resolver = this.options.resolveMissingJupyter
    if (!resolver) {
      throw new Error(
        'blocked: Jupyter is missing on the remote host; no missing-tool resolver is available, so Phi did not install anything.'
      )
    }
    input.signal?.throwIfAborted()
    const resolution = await resolver({
      runtimeSessionId: input.promptRuntimeSessionId ?? input.runtimeSessionId,
      signal: input.signal
    })
    input.signal?.throwIfAborted()
    const choice = (resolution as { choice?: unknown }).choice
    if (choice === 'cancel') {
      throw new Error(
        'blocked: Jupyter is missing on the remote host and the user cancelled recovery; Phi did not install anything.'
      )
    }
    if (choice === 'install') return { choice: 'install' }
    if (choice === 'path' && typeof (resolution as { path?: unknown }).path === 'string') {
      return { choice: 'path', path: (resolution as { path: string }).path }
    }
    throw new Error(
      'blocked: Jupyter recovery returned an invalid decision; Phi did not install anything.'
    )
  }

  private async requestEnvironment(input: PrepareRemoteJupyterInput): Promise<void> {
    const packages = remoteJupyterPackages(this.options.environmentsDir)
    const requestId = input.requestId ?? (input.signal ? `notebook-${randomUUID()}` : undefined)
    const cancel = (): void => this.options.environments.cancel({ requestId })
    input.signal?.throwIfAborted()
    input.signal?.addEventListener('abort', cancel, { once: true })
    const result = await this.options.environments
      .request({
        runtimeSessionId: input.runtimeSessionId,
        environment: REMOTE_JUPYTER_REF,
        packages,
        reason: 'Prepare a remote Notebook environment with Jupyter Server and ipykernel',
        ...(requestId ? { requestId } : {})
      })
      .finally(() => input.signal?.removeEventListener('abort', cancel))
    if (input.signal?.aborted)
      throw new Error('Remote Notebook environment preparation was cancelled')
    if ('declined' in result)
      throw new Error('Remote Notebook environment preparation was declined')
    if ('error' in result) throw remoteJupyterEnvironmentError(result.error)
  }

  async list(input: ListRemoteKernelsInput): Promise<AnalysisKernelDiagnostics> {
    const handle = await this.bindManagedEnvironment(input.runtimeSessionId, input.signal)
    await this.writeManagedSpec(input.runtimeSessionId, handle, input.signal)
    return managedDiagnostics(handle, remoteJupyterPackages(this.options.environmentsDir))
  }

  select(diagnostics: AnalysisKernelDiagnostics, name?: string): AnalysisKernelSummary {
    const selectedName = name ?? diagnostics.preferredKernelName
    const kernel = diagnostics.kernels.find((candidate) => candidate.name === selectedName)
    if (!kernel || kernel.status === 'not-built' || kernel.source === 'host') {
      throw new Error(`Remote Notebook kernel ${selectedName ?? '(default)'} is unavailable`)
    }
    return kernel
  }

  async registerUserPrefix(input: RegisterRemoteUserPrefixInput): Promise<AnalysisKernelSummary> {
    if (this.options.allowUserPrefixes !== true) {
      throw new Error('Remote Notebook user prefixes are disabled unless the caller opts in')
    }
    const kernel = checkedUserKernel(input.name)
    const prefix = checkedUserPrefix(input.prefix)
    const workspace = await this.options.openWorkspace(input.runtimeSessionId)
    try {
      await checkUserPrefix(workspace, prefix)
      await writeSpec(workspace, kernel.name, userPythonSpec(kernel.label, prefix))
      return userKernelSummary(kernel.label, kernel.name)
    } finally {
      await workspace.close?.().catch(() => undefined)
    }
  }

  private async bindManagedEnvironment(
    runtimeSessionId: string,
    signal?: AbortSignal
  ): Promise<RemoteEnvironmentHandle> {
    const handle = await this.readyManagedEnvironment(runtimeSessionId, signal)
    if (handle) return handle
    throw new Error('The remote Notebook environment has not been created')
  }

  private async readyManagedEnvironment(
    runtimeSessionId: string,
    signal?: AbortSignal
  ): Promise<RemoteEnvironmentHandle | undefined> {
    signal?.throwIfAborted()
    const bound = await this.options.environments.bindSession({
      runtimeSessionId,
      ref: REMOTE_JUPYTER_REF
    })
    signal?.throwIfAborted()
    if ('notReady' in bound) return undefined
    return remoteEnvironmentHandle(bound)
  }

  private async writeManagedSpec(
    runtimeSessionId: string,
    handle: RemoteEnvironmentHandle,
    signal?: AbortSignal
  ): Promise<void> {
    const workspace = await this.options.openWorkspace(runtimeSessionId, signal)
    try {
      signal?.throwIfAborted()
      assertManagedPrefix(workspace, handle)
      await writeSpec(workspace, MANAGED_KERNEL_NAME, managedPythonSpec(handle))
      if (this.options.allowUserPrefixes !== true) await removeUserSpecs(workspace)
      signal?.throwIfAborted()
    } finally {
      await workspace.close?.().catch(() => undefined)
    }
  }
}

async function prepareJupyterDirectories(workspace: RemoteRuntimeWorkspace): Promise<void> {
  await Promise.all(
    ['config', 'data', 'runtime'].map((name) =>
      workspace.runtimeHost.fs.mkdirp(posix.join('jupyter', name))
    )
  )
}

/**
 * Automatic choices are limited to the configured path and the login shell's PATH. Broader
 * conda/common-location matches are candidates for the missing-tool card and are never selected
 * without the user. A path counts only when `jupyter server --version` works and the Python
 * beside it imports ipykernel.
 */
export const DETECT_REMOTE_JUPYTER_SCRIPT = [
  'configured="$1"',
  'found=$(command -v jupyter 2>/dev/null || true)',
  'for candidate in "$configured" "$found"; do',
  '  case "$candidate" in /*) ;; *) continue ;; esac',
  '  [ -x "$candidate" ] || continue',
  '  dir=$(dirname "$candidate")',
  '  python="$dir/python"',
  '  [ -x "$python" ] || python="$dir/python3"',
  '  [ -x "$python" ] || continue',
  '  version=$("$candidate" server --version 2>/dev/null | tail -n 1) || continue',
  '  [ -n "$version" ] || continue',
  '  "$python" -c "import ipykernel" >/dev/null 2>&1 || continue',
  `  printf 'PHI_JUPYTER\\t%s\\t%s\\t%s\\n' "$candidate" "$python" "$version"`,
  '  exit 0',
  'done',
  'exit 3'
].join('\n')

export async function detectExistingRemoteJupyter(
  workspace: RemoteRuntimeWorkspace,
  configured: string | undefined,
  signal?: AbortSignal
): Promise<ExistingRemoteJupyter | undefined> {
  const result = await workspace.projectHost.exec.run(
    ['bash', '-lc', DETECT_REMOTE_JUPYTER_SCRIPT, 'phi-detect-jupyter', configured ?? ''],
    {
      cwd: workspace.projectRoot,
      timeoutMs: DETECT_TIMEOUT_MS,
      maxOutputBytes: 65_536,
      ...(signal ? { signal } : {})
    }
  )
  if (result.code !== 0 || result.terminationReason) return undefined
  return parseDetectedRemoteJupyter(result.stdout)
}

export function parseDetectedRemoteJupyter(stdout: string): ExistingRemoteJupyter | undefined {
  const line = stdout
    .split('\n')
    .reverse()
    .find((entry) => entry.startsWith('PHI_JUPYTER\t'))
  if (!line) return undefined
  const [, jupyter, python, version] = line.split('\t')
  const absolute = (path: string | undefined): path is string =>
    Boolean(path && posix.isAbsolute(path) && !/[\0\r\n]/.test(path))
  if (!absolute(jupyter) || !absolute(python)) return undefined
  const trimmed = version?.trim()
  return { jupyter, python, ...(trimmed ? { version: trimmed } : {}) }
}

function remoteJupyterLaunch(
  workspace: RemoteRuntimeWorkspace,
  jupyter: string
): RemoteJupyterLaunchCommand {
  const root = posix.join(workspace.runtimeRoot, 'jupyter')
  return {
    command: jupyter,
    args: [
      'server',
      `--KernelSpecManager.kernel_dirs=${posix.join(root, 'kernels')}`,
      '--KernelSpecManager.ensure_native_kernel=False'
    ],
    cwd: workspace.projectRoot,
    env: {
      IPYTHONDIR: posix.join(root, 'ipython'),
      JUPYTER_CONFIG_DIR: posix.join(root, 'config'),
      JUPYTER_DATA_DIR: posix.join(root, 'data'),
      JUPYTER_PATH: root,
      JUPYTER_RUNTIME_DIR: posix.join(root, 'runtime'),
      PYTHONNOUSERSITE: '1'
    }
  }
}

function remoteJupyterPackages(environmentsDir = bundledEnvironmentsDir()): string[] {
  const path = join(environmentsDir, 'phi-jupyter', REMOTE_JUPYTER_SPEC)
  const parsed = parseEnvironmentSpec(readFileSync(path, 'utf8'))
  if (!parsed.ok) {
    throw new Error(
      `The remote Notebook environment declaration is invalid: ${parsed.errors.join('; ')}`
    )
  }
  const packages = parsed.spec.dependencies.filter(
    (dependency): dependency is string => typeof dependency === 'string'
  )
  if (packages.length !== parsed.spec.dependencies.length) {
    throw new Error('The remote Notebook environment declaration may contain only conda packages')
  }
  return packages
}

function remoteJupyterEnvironmentError(message: string): Error {
  return new Error(
    `Unable to install the remote Notebook environment with Jupyter + ipykernel: ${message}`
  )
}

function remoteEnvironmentHandle(value: Record<string, unknown>): RemoteEnvironmentHandle {
  const required = ['ref', 'envId', 'name', 'prefix'] as const
  if (required.some((key) => typeof value[key] !== 'string')) {
    throw new Error('The remote Notebook environment binding result is invalid')
  }
  if (!Array.isArray(value.packages) || !Array.isArray(value.channels)) {
    throw new Error('The remote Notebook environment binding result is invalid')
  }
  return value as unknown as RemoteEnvironmentHandle
}

function assertManagedPrefix(
  workspace: RemoteRuntimeWorkspace,
  handle: RemoteEnvironmentHandle
): void {
  const expected = posix.join(workspace.runtimeRoot, 'envs', handle.envId)
  if (handle.prefix !== expected) {
    throw new Error(
      'The remote Notebook environment prefix is outside the managed runtime directory'
    )
  }
}

function managedPythonSpec(handle: RemoteEnvironmentHandle): KernelSpecFile {
  return {
    argv: [
      posix.join(handle.prefix, 'bin', 'python'),
      '-m',
      'ipykernel_launcher',
      '-f',
      '{connection_file}'
    ],
    display_name: MANAGED_KERNEL_DISPLAY_NAME,
    language: 'python',
    env: {
      PATH: `${posix.join(handle.prefix, 'bin')}:/usr/bin:/bin`,
      CONDA_PREFIX: handle.prefix,
      CONDA_DEFAULT_ENV: handle.name,
      CONDA_SHLVL: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      MPLBACKEND: 'module://matplotlib_inline.backend_inline',
      PHI_ENV_ID: handle.envId,
      PHI_ENV_PREFIX: handle.prefix
    },
    interrupt_mode: 'signal',
    metadata: {
      debugger: true,
      phi: { managed: true, ref: REMOTE_JUPYTER_REF, envId: handle.envId }
    }
  }
}

function serverPythonSpec(existing: ExistingRemoteJupyter): KernelSpecFile {
  const bin = posix.dirname(existing.python)
  return {
    argv: [existing.python, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    display_name: `Python (${SERVER_KERNEL_LABEL})`,
    language: 'python',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      PYTHONDONTWRITEBYTECODE: '1',
      MPLBACKEND: 'module://matplotlib_inline.backend_inline'
    },
    interrupt_mode: 'signal',
    metadata: { debugger: true, phi: { managed: false, serverExisting: true } }
  }
}

function existingDiagnostics(existing: ExistingRemoteJupyter): AnalysisKernelDiagnostics {
  const kernel: AnalysisKernelSummary = {
    name: SERVER_KERNEL_NAME,
    displayName: `Python (${SERVER_KERNEL_LABEL})`,
    language: 'python',
    rawLanguage: 'python',
    executable: existing.python,
    label: SERVER_KERNEL_LABEL,
    status: 'ready'
  }
  return {
    jupyterServer: {
      available: true,
      command: 'jupyter',
      managed: false,
      ...(existing.version ? { version: existing.version } : {})
    },
    kernels: [kernel],
    preferredKernelName: SERVER_KERNEL_NAME,
    hasPythonKernel: true,
    hasRKernel: false,
    messages: [`Using existing server Jupyter: ${existing.jupyter}`]
  }
}

function checkedUserKernel(value: string): { label: string; name: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value)) {
    throw new Error('The remote Notebook user kernel name is invalid')
  }
  return { label: value, name: hostKernelName(value) }
}

function checkedUserPrefix(value: string): string {
  const normalized = posix.normalize(value)
  if (!posix.isAbsolute(value) || normalized !== value || /[\0\r\n]/.test(value)) {
    throw new Error('The remote Notebook user prefix must be a normalized absolute server path')
  }
  return normalized
}

async function checkUserPrefix(workspace: RemoteRuntimeWorkspace, prefix: string): Promise<void> {
  const result = await workspace.projectHost.exec.run(
    [posix.join(prefix, 'bin', 'python'), '-c', 'import ipykernel'],
    { cwd: workspace.projectRoot, timeoutMs: 10_000, maxOutputBytes: 16_384 }
  )
  if (result.code !== 0 || result.terminationReason) {
    throw new Error(
      'The selected server Python prefix does not have a usable ipykernel; no kernelspec was registered'
    )
  }
}

function userPythonSpec(label: string, prefix: string): KernelSpecFile {
  return {
    argv: [
      posix.join(prefix, 'bin', 'python'),
      '-m',
      'ipykernel_launcher',
      '-f',
      '{connection_file}'
    ],
    display_name: `Python (${label}, user prefix)`,
    language: 'python',
    env: { PATH: `${posix.join(prefix, 'bin')}:/usr/bin:/bin`, PYTHONNOUSERSITE: '1' },
    interrupt_mode: 'signal',
    metadata: { debugger: true, phi: { managed: false, userPrefix: true } }
  }
}

function userKernelSummary(label: string, name: string): AnalysisKernelSummary {
  return {
    name,
    displayName: `Python (${label}, user prefix) · ${HOST_KERNEL_LABEL}`,
    language: 'python',
    rawLanguage: 'python',
    source: 'host',
    label: HOST_KERNEL_LABEL,
    status: 'ready',
    hostName: label
  }
}

async function writeSpec(
  workspace: RemoteRuntimeWorkspace,
  name: string,
  spec: KernelSpecFile
): Promise<void> {
  const directory = posix.join('jupyter', 'kernels', name)
  await workspace.runtimeHost.fs.mkdirp(directory)
  await workspace.runtimeHost.fs.writeAtomic(
    posix.join(directory, 'kernel.json'),
    `${JSON.stringify(spec, null, 2)}\n`
  )
}

async function removeUserSpecs(workspace: RemoteRuntimeWorkspace): Promise<void> {
  const directory = posix.join('jupyter', 'kernels')
  let cursor: string | undefined
  do {
    const page = await workspace.runtimeHost.fs.list(directory, {
      ...(cursor ? { cursor } : {}),
      limit: 100
    })
    for (const entry of page.entries) {
      if (entry.name.startsWith('host-')) {
        await workspace.runtimeHost.fs.remove(posix.join(directory, entry.name), {
          recursive: true,
          force: true
        })
      }
    }
    cursor = page.nextCursor
  } while (cursor)
}

function managedDiagnostics(
  handle: RemoteEnvironmentHandle,
  packages: readonly string[]
): AnalysisKernelDiagnostics {
  const kernel: AnalysisKernelSummary = {
    name: MANAGED_KERNEL_NAME,
    displayName: MANAGED_KERNEL_DISPLAY_NAME,
    language: 'python',
    rawLanguage: 'python',
    source: 'managed',
    status: 'ready',
    environment: { ref: REMOTE_JUPYTER_REF, envId: handle.envId }
  }
  return {
    jupyterServer: {
      available: true,
      command: 'jupyter',
      managed: true,
      environment: kernel.environment,
      version: packageVersion(packages, 'jupyter_server')
    },
    kernels: [kernel],
    preferredKernelName: MANAGED_KERNEL_NAME,
    hasPythonKernel: true,
    hasRKernel: false,
    messages: []
  }
}

function packageVersion(packages: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  return packages.find((dependency) => dependency.startsWith(prefix))?.slice(prefix.length)
}
