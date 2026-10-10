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

const REMOTE_JUPYTER_REF = 'phi:jupyter@1'
const REMOTE_JUPYTER_SPEC = 'remote-environment.yml'
const MANAGED_KERNEL_NAME = 'phi-python'
const MANAGED_KERNEL_DISPLAY_NAME = 'Python 3.12 (phi-python)'

type RemoteEnvironmentGateway = Pick<RemoteEnvironmentService, 'request' | 'bindSession'>

export interface RemoteKernelspecAdapterOptions {
  environments: RemoteEnvironmentGateway
  openWorkspace: OpenRemoteRuntimeWorkspace
  environmentsDir?: string
  allowUserPrefixes?: boolean
}

export interface PrepareRemoteJupyterInput {
  runtimeSessionId: string
  requestId?: string
}

export interface ListRemoteKernelsInput {
  runtimeSessionId: string
}

export interface RegisterRemoteUserPrefixInput {
  runtimeSessionId: string
  name: string
  prefix: string
}

export class RemoteKernelspecAdapter {
  constructor(private readonly options: RemoteKernelspecAdapterOptions) {}

  async prepare(input: PrepareRemoteJupyterInput): Promise<AnalysisKernelDiagnostics> {
    const packages = remoteJupyterPackages(this.options.environmentsDir)
    const result = await this.options.environments.request({
      runtimeSessionId: input.runtimeSessionId,
      environment: REMOTE_JUPYTER_REF,
      packages,
      reason: '准备含 Jupyter Server 与 ipykernel 的远程 Notebook 环境',
      ...(input.requestId ? { requestId: input.requestId } : {})
    })
    if ('declined' in result) throw new Error('已取消准备远程 Notebook 环境')
    if ('error' in result) throw remoteJupyterEnvironmentError(result.error)
    return this.list(input)
  }

  async list(input: ListRemoteKernelsInput): Promise<AnalysisKernelDiagnostics> {
    const handle = await this.bindManagedEnvironment(input.runtimeSessionId)
    await this.writeManagedSpec(input.runtimeSessionId, handle)
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

  private async bindManagedEnvironment(runtimeSessionId: string): Promise<RemoteEnvironmentHandle> {
    const bound = await this.options.environments.bindSession({
      runtimeSessionId,
      ref: REMOTE_JUPYTER_REF
    })
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
    handle: RemoteEnvironmentHandle
  ): Promise<void> {
    const workspace = await this.options.openWorkspace(runtimeSessionId)
    try {
      assertManagedPrefix(workspace, handle)
      await writeSpec(workspace, MANAGED_KERNEL_NAME, managedPythonSpec(handle))
      if (this.options.allowUserPrefixes !== true) await removeUserSpecs(workspace)
    } finally {
      await workspace.close?.().catch(() => undefined)
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
