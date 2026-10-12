import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

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
const SERVER_KERNEL_LABEL = '服务器现有环境'
const DETECT_TIMEOUT_MS = 45_000

type RemoteEnvironmentGateway = Pick<RemoteEnvironmentService, 'request' | 'bindSession' | 'cancel'>

export interface RemoteKernelspecAdapterOptions {
  environments: RemoteEnvironmentGateway
  openWorkspace: OpenRemoteRuntimeWorkspace
  environmentsDir?: string
  allowUserPrefixes?: boolean
  /** The Jupyter path saved in the host's remote settings; tried before PATH. */
  configuredJupyterPath?: () => string | undefined
}

/** A Jupyter Server already installed on the server, with an ipykernel-capable Python. */
export interface ExistingRemoteJupyter {
  jupyter: string
  python: string
  version?: string
}

export interface PrepareRemoteJupyterInput {
  runtimeSessionId: string
  requestId?: string
  signal?: AbortSignal
  /** Human-readable steps for the startup log. */
  onProgress?: (text: string) => void
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

export class RemoteKernelspecAdapter {
  constructor(private readonly options: RemoteKernelspecAdapterOptions) {}

  async prepare(input: PrepareRemoteJupyterInput): Promise<AnalysisKernelDiagnostics> {
    await this.requestEnvironment(input)
    return this.list(input)
  }

  async prepareRuntime(input: PrepareRemoteJupyterInput): Promise<PreparedRemoteJupyterRuntime> {
    const existing = await this.prepareExistingRuntime(input)
    if (existing) return existing
    input.onProgress?.(
      '服务器上没有可用的 Jupyter Server（需要 jupyter server 与 ipykernel）；改用 Phi 受管环境 phi:jupyter@1，首次创建可能需要几分钟。'
    )
    const kernels = await this.prepare(input)
    input.signal?.throwIfAborted()
    const handle = await this.bindManagedEnvironment(input.runtimeSessionId, input.signal)
    const workspace = await this.options.openWorkspace(input.runtimeSessionId, input.signal)
    try {
      assertManagedPrefix(workspace, handle)
      await prepareJupyterDirectories(workspace)
      input.onProgress?.(`使用受管环境中的 Jupyter：${posix.join(handle.prefix, 'bin', 'jupyter')}`)
      return {
        kernels,
        launch: remoteJupyterLaunch(workspace, posix.join(handle.prefix, 'bin', 'jupyter')),
        source: 'managed'
      }
    } finally {
      await workspace.close?.().catch(() => undefined)
    }
  }

  /** Uses a Jupyter already on the server when one is complete enough to run notebooks. */
  private async prepareExistingRuntime(
    input: PrepareRemoteJupyterInput
  ): Promise<PreparedRemoteJupyterRuntime | undefined> {
    const workspace = await this.options.openWorkspace(input.runtimeSessionId, input.signal)
    try {
      const configured = this.options.configuredJupyterPath?.()?.trim() || undefined
      input.onProgress?.(
        configured
          ? `正在检查设置中的 Jupyter 路径 ${configured}，以及服务器 PATH 与常见 conda 位置…`
          : '正在检测服务器上已有的 Jupyter（登录 shell 的 PATH 与常见 conda 位置）…'
      )
      const existing = await detectExistingRemoteJupyter(workspace, configured, input.signal)
      if (!existing) return undefined
      input.signal?.throwIfAborted()
      input.onProgress?.(
        `使用服务器已有的 Jupyter：${existing.jupyter}${existing.version ? `（jupyter_server ${existing.version}）` : ''}，kernel Python：${existing.python}`
      )
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
        reason: '准备含 Jupyter Server 与 ipykernel 的远程 Notebook 环境',
        ...(requestId ? { requestId } : {})
      })
      .finally(() => input.signal?.removeEventListener('abort', cancel))
    if (input.signal?.aborted) throw new Error('远程 Notebook 环境准备已取消')
    if ('declined' in result) throw new Error('已取消准备远程 Notebook 环境')
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
      throw new Error(`远程 Notebook kernel ${selectedName ?? '(default)'} 不可用`)
    }
    return kernel
  }

  async registerUserPrefix(input: RegisterRemoteUserPrefixInput): Promise<AnalysisKernelSummary> {
    if (this.options.allowUserPrefixes !== true) {
      throw new Error('远程 Notebook 用户 prefix 开关默认关闭；需由调用方显式启用')
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
    signal?.throwIfAborted()
    const bound = await this.options.environments.bindSession({
      runtimeSessionId,
      ref: REMOTE_JUPYTER_REF
    })
    signal?.throwIfAborted()
    if ('notReady' in bound) {
      const value = bound.notReady as { message?: unknown }
      throw new Error(
        typeof value.message === 'string' ? value.message : '远程 Notebook 环境尚未创建'
      )
    }
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
 * Candidates in order: the configured path, `jupyter` on the login shell's PATH (module and
 * conda setups live there), then common conda installs. A candidate counts only when
 * `jupyter server --version` works and the Python beside it imports ipykernel.
 */
export const DETECT_REMOTE_JUPYTER_SCRIPT = [
  'configured="$1"',
  'found=$(command -v jupyter 2>/dev/null || true)',
  'for candidate in "$configured" "$found" "${CONDA_PREFIX:+$CONDA_PREFIX/bin/jupyter}" \\',
  '  "$HOME/miniforge3/bin/jupyter" "$HOME/mambaforge/bin/jupyter" "$HOME/miniconda3/bin/jupyter" \\',
  '  "$HOME/anaconda3/bin/jupyter" /opt/conda/bin/jupyter /usr/local/bin/jupyter /usr/bin/jupyter; do',
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
  if (!parsed.ok) throw new Error(`远程 Notebook 环境声明无效：${parsed.errors.join('；')}`)
  const packages = parsed.spec.dependencies.filter(
    (dependency): dependency is string => typeof dependency === 'string'
  )
  if (packages.length !== parsed.spec.dependencies.length) {
    throw new Error('远程 Notebook 环境声明只能包含 conda 包')
  }
  return packages
}

function remoteJupyterEnvironmentError(message: string): Error {
  return new Error(`无法安装含 Jupyter + ipykernel 的远程 Notebook 环境：${message}`)
}

function remoteEnvironmentHandle(value: Record<string, unknown>): RemoteEnvironmentHandle {
  const required = ['ref', 'envId', 'name', 'prefix'] as const
  if (required.some((key) => typeof value[key] !== 'string')) {
    throw new Error('远程 Notebook 环境绑定结果无效')
  }
  if (!Array.isArray(value.packages) || !Array.isArray(value.channels)) {
    throw new Error('远程 Notebook 环境绑定结果无效')
  }
  return value as unknown as RemoteEnvironmentHandle
}

function assertManagedPrefix(
  workspace: RemoteRuntimeWorkspace,
  handle: RemoteEnvironmentHandle
): void {
  const expected = posix.join(workspace.runtimeRoot, 'envs', handle.envId)
  if (handle.prefix !== expected) throw new Error('远程 Notebook 环境 prefix 不在受管运行时目录中')
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
    messages: [`使用服务器已有的 Jupyter：${existing.jupyter}`]
  }
}

function checkedUserKernel(value: string): { label: string; name: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value)) {
    throw new Error('远程 Notebook 用户 kernel 名称无效')
  }
  return { label: value, name: hostKernelName(value) }
}

function checkedUserPrefix(value: string): string {
  const normalized = posix.normalize(value)
  if (!posix.isAbsolute(value) || normalized !== value || /[\0\r\n]/.test(value)) {
    throw new Error('远程 Notebook 用户 prefix 必须是规范的服务器绝对路径')
  }
  return normalized
}

async function checkUserPrefix(workspace: RemoteRuntimeWorkspace, prefix: string): Promise<void> {
  const result = await workspace.projectHost.exec.run(
    [posix.join(prefix, 'bin', 'python'), '-c', 'import ipykernel'],
    { cwd: workspace.projectRoot, timeoutMs: 10_000, maxOutputBytes: 16_384 }
  )
  if (result.code !== 0 || result.terminationReason) {
    throw new Error('所选服务器 Python prefix 缺少可用的 ipykernel；未登记 kernelspec')
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
