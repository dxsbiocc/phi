import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import {
  ENVIRONMENT_TOOL_IDS,
  ENVIRONMENT_TOOL_LABELS,
  type EnvironmentHostDependency,
  type EnvironmentHostKernel,
  type EnvironmentHostTool,
  type EnvironmentToolId,
  type EnvironmentToolState
} from '../../../shared/environmentTypes'
import { detectAnalysisKernels } from '../notebook/analysis-kernels'
import {
  MIN_NEXTFLOW_VERSION,
  isNextflowVersionSupported,
  parseNextflowVersion
} from '../wrappers/composition/nextflow-version'

/** Label for a tool the user pointed Phi at explicitly; Phi does not manage it (§5.2). */
export const HOST_UNMANAGED = 'host (unmanaged)'

/**
 * A tool state plus how it is managed. `management` is additive: readers that only know
 * `EnvironmentToolState` keep working. Only a custom nextflow sets it today; wrappers use
 * the managed `phi:nextflow@1` environment unless one is chosen.
 */
/** Kept as an alias: `management` now lives on `EnvironmentToolState` itself. */
export type ManagedToolState = EnvironmentToolState

export type CommandRunner = (command: string, args: string[]) => string

export type WhichResolver = (name: string) => string | undefined

function defaultRunner(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8_000
  })
}

function defaultWhich(name: string): string | undefined {
  try {
    const found = execFileSync('which', [name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000
    })
      .trim()
      .split('\n')[0]
      ?.trim()
    return found && existsSync(found) ? found : undefined
  } catch {
    return undefined
  }
}

function findExecutable(dir: string, name: string): string | undefined {
  const candidate = join(dir, name)
  return existsSync(candidate) ? candidate : undefined
}

function condaEnvBinCandidates(names: string[]): string[] {
  const envRoots = ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].map((d) =>
    join(homedir(), d, 'envs')
  )
  const found: string[] = []
  for (const root of envRoots) {
    if (!existsSync(root)) continue
    let envNames: string[]
    try {
      envNames = readdirSync(root)
    } catch {
      continue
    }
    for (const envName of envNames) {
      for (const name of names) {
        const bin = findExecutable(join(root, envName, 'bin'), name)
        if (bin) found.push(bin)
      }
    }
  }
  return found
}

function homeBinCandidates(names: string[]): string[] {
  const roots = [
    join(homedir(), '.phi', 'runtimes', 'micromamba'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const found: string[] = []
  for (const root of roots) {
    for (const name of names) {
      const bin = findExecutable(root, name)
      if (bin) found.push(bin)
      // micromamba sometimes lives as the prefix itself
      if (name === 'micromamba' && existsSync(root) && statSync(root).isFile()) {
        found.push(root)
      }
    }
  }
  return found
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const path of paths) {
    if (path && existsSync(path)) {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    }
  }
  return undefined
}

function probeVersion(runner: CommandRunner, binary: string, args: string[]): string | undefined {
  try {
    const out = runner(binary, args).trim()
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean)
    return line || undefined
  } catch {
    return undefined
  }
}

function missingTool(id: EnvironmentToolId, messages?: string[]): EnvironmentToolState {
  return {
    id,
    label: ENVIRONMENT_TOOL_LABELS[id],
    status: 'missing',
    source: 'none',
    ...(messages?.length ? { messages } : {})
  }
}

function readyTool(
  id: EnvironmentToolId,
  path: string,
  version?: string,
  detail?: string,
  messages?: string[]
): EnvironmentToolState {
  return {
    id,
    label: ENVIRONMENT_TOOL_LABELS[id],
    status: 'ready',
    detectedPath: path,
    activePath: path,
    source: 'detected',
    ...(version ? { detectedVersion: version } : {}),
    ...(detail ? { detail } : {}),
    ...(messages?.length ? { messages } : {})
  }
}

function resolveNamedBinary(names: string[], which: WhichResolver): string | undefined {
  for (const name of names) {
    const fromWhich = which(name)
    if (fromWhich) return fromWhich
  }
  return firstExisting([...homeBinCandidates(names), ...condaEnvBinCandidates(names)])
}

function detectMicromambaFamily(runner: CommandRunner, which: WhichResolver): EnvironmentToolState {
  const path = resolveNamedBinary(['micromamba', 'mamba', 'conda'], which)
  if (!path) return missingTool('micromamba')
  const base = path.split(sep).pop() ?? 'micromamba'
  const version =
    probeVersion(runner, path, ['--version']) ??
    probeVersion(runner, path, ['-V']) ??
    probeVersion(runner, path, ['info'])
  return readyTool('micromamba', path, version, `检测到 ${base}`)
}

function detectNextflow(runner: CommandRunner, which: WhichResolver): EnvironmentToolState {
  if (process.env.NEXTFLOW_BIN && existsSync(process.env.NEXTFLOW_BIN)) {
    const path = process.env.NEXTFLOW_BIN
    return readyTool(
      'nextflow',
      path,
      probeVersion(runner, path, ['-version']),
      '来自 NEXTFLOW_BIN'
    )
  }
  const path = resolveNamedBinary(['nextflow'], which)
  if (!path) return missingTool('nextflow')
  return readyTool('nextflow', path, probeVersion(runner, path, ['-version']))
}

function detectDocker(runner: CommandRunner, which: WhichResolver): EnvironmentToolState {
  const path = resolveNamedBinary(['docker'], which)
  if (!path) return missingTool('docker')
  return readyTool('docker', path, probeVersion(runner, path, ['--version']))
}

function detectSingularity(runner: CommandRunner, which: WhichResolver): EnvironmentToolState {
  const path = resolveNamedBinary(['apptainer', 'singularity'], which)
  if (!path) return missingTool('singularity')
  const base = path.split(sep).pop() ?? 'singularity'
  return readyTool('singularity', path, probeVersion(runner, path, ['--version']), `检测到 ${base}`)
}

function detectJupyter(runner: CommandRunner, which: WhichResolver): EnvironmentToolState {
  const path = resolveNamedBinary(['jupyter'], which)
  if (!path) return missingTool('jupyter', ['未检测到 jupyter 可执行文件。'])

  const diagnostics = detectAnalysisKernels(runner, path)

  const messages = [...diagnostics.messages]
  if (!diagnostics.jupyterServer.available) {
    return {
      id: 'jupyter',
      label: ENVIRONMENT_TOOL_LABELS.jupyter,
      status: 'missing',
      detectedPath: path,
      source: 'none',
      messages: messages.length
        ? messages
        : [diagnostics.jupyterServer.error ?? 'Jupyter Server 不可用']
    }
  }

  const detailParts = [
    diagnostics.jupyterServer.version ? `server ${diagnostics.jupyterServer.version}` : undefined,
    `${diagnostics.kernels.length} 个 kernel`,
    diagnostics.hasPythonKernel ? 'Python' : undefined,
    diagnostics.hasRKernel ? 'R' : undefined
  ].filter(Boolean)

  return readyTool(
    'jupyter',
    path,
    diagnostics.jupyterServer.version,
    detailParts.join(' · '),
    messages.length ? messages : undefined
  )
}

function detectRscript(runner: CommandRunner, which: WhichResolver): EnvironmentToolState {
  const managed = firstExisting([
    join(homedir(), '.phi', 'runtimes', 'figures', 'bin', 'Rscript'),
    ...['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].flatMap((d) => [
      join(homedir(), d, 'bin', 'Rscript'),
      join(homedir(), d, 'envs', 'figures', 'bin', 'Rscript')
    ])
  ])
  const path = managed ?? resolveNamedBinary(['Rscript'], which)
  if (!path) return missingTool('rscript')
  return readyTool('rscript', path, probeVersion(runner, path, ['--version']))
}

function hostDependency(
  id: EnvironmentHostDependency['id'],
  label: string,
  path: string | undefined,
  runner: CommandRunner,
  versionArgs: string[],
  detail?: string
): EnvironmentHostDependency {
  if (!path) return { id, label, status: 'missing' }
  const version = probeVersion(runner, path, versionArgs)
  if (!version) {
    return {
      id,
      label,
      status: 'unavailable',
      path,
      messages: ['已找到命令，但无法读取版本或执行检查。']
    }
  }
  return {
    id,
    label,
    status: 'ready',
    path,
    ...(version ? { version } : {}),
    ...(detail ? { detail } : {})
  }
}

/** Host-only dependencies are checked and reported; Phi never installs them. */
export function detectHostDependencies(
  options: DetectEnvironmentOptions = {}
): EnvironmentHostDependency[] {
  const runner = options.runner ?? defaultRunner
  const which = options.which ?? defaultWhich

  const dockerPath = resolveNamedBinary(['docker'], which)
  let docker: EnvironmentHostDependency
  if (!dockerPath) {
    docker = { id: 'docker', label: 'Docker', status: 'missing' }
  } else {
    try {
      const serverVersion = runner(dockerPath, ['info', '--format', '{{.ServerVersion}}']).trim()
      docker = {
        id: 'docker',
        label: 'Docker',
        status: 'ready',
        path: dockerPath,
        ...(serverVersion ? { version: serverVersion.split('\n')[0]?.trim() } : {})
      }
    } catch (error) {
      docker = {
        id: 'docker',
        label: 'Docker',
        status: 'unavailable',
        path: dockerPath,
        version: probeVersion(runner, dockerPath, ['--version']),
        messages: [
          `Docker 命令可用，但无法连接 daemon：${error instanceof Error ? error.message : String(error)}`
        ]
      }
    }
  }

  const singularityPath = resolveNamedBinary(['apptainer', 'singularity'], which)
  const singularityName = singularityPath?.split(sep).pop()
  const singularity = hostDependency(
    'singularity',
    'Singularity / Apptainer',
    singularityPath,
    runner,
    ['--version'],
    singularityName ? `检测到 ${singularityName}` : undefined
  )

  const libreOfficePath =
    firstExisting([
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/lib/libreoffice/program/soffice'
    ]) ?? resolveNamedBinary(['soffice'], which)
  const libreOffice = hostDependency('libreoffice', 'LibreOffice', libreOfficePath, runner, [
    '--version'
  ])

  return [docker, singularity, libreOffice]
}

function hostKernels(
  diagnostics: ReturnType<typeof detectAnalysisKernels>
): EnvironmentHostKernel[] {
  return diagnostics.kernels.map((kernel) => ({
    id: kernel.name,
    displayName: kernel.displayName,
    language: kernel.rawLanguage,
    ...(kernel.resourceDir ? { path: kernel.resourceDir } : {})
  }))
}

function probeHostKernelSpecs(runner: CommandRunner, jupyterPath: string): EnvironmentHostKernel[] {
  try {
    const payload = JSON.parse(runner(jupyterPath, ['kernelspec', 'list', '--json'])) as {
      kernelspecs?: Record<
        string,
        { resource_dir?: unknown; spec?: { display_name?: unknown; language?: unknown } }
      >
    }
    if (!payload.kernelspecs || typeof payload.kernelspecs !== 'object') return []
    return Object.entries(payload.kernelspecs)
      .map(([id, value]) => ({
        id,
        displayName:
          typeof value.spec?.display_name === 'string' && value.spec.display_name.trim()
            ? value.spec.display_name.trim()
            : id,
        language:
          typeof value.spec?.language === 'string' && value.spec.language.trim()
            ? value.spec.language.trim()
            : 'unknown',
        ...(typeof value.resource_dir === 'string' && value.resource_dir
          ? { path: value.resource_dir }
          : {})
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
  } catch {
    return []
  }
}

/** Optional host versions. They are always labelled unmanaged and never become defaults. */
export function detectEnvironmentHostTools(
  tools: EnvironmentToolState[],
  customPaths: Partial<Record<EnvironmentToolId, string>>,
  options: DetectEnvironmentOptions = {}
): EnvironmentHostTool[] {
  const runner = options.runner ?? defaultRunner
  const nextflow = tools.find((tool) => tool.id === 'nextflow')
  const customNextflow = customPaths.nextflow
  const nextflowTool: EnvironmentHostTool = {
    id: 'nextflow',
    label: 'Nextflow',
    status: customNextflow
      ? (nextflow?.status ?? 'invalid')
      : nextflow?.status === 'ready'
        ? 'not-configured'
        : 'missing',
    management: 'host-unmanaged',
    selected: Boolean(customNextflow && nextflow?.status === 'ready'),
    ...(customNextflow ? { path: customNextflow } : {}),
    ...(nextflow?.detectedPath ? { detectedPath: nextflow.detectedPath } : {}),
    ...(nextflow?.detectedVersion ? { version: nextflow.detectedVersion } : {}),
    ...(nextflow?.detail ? { detail: nextflow.detail } : {}),
    ...(nextflow?.messages ? { messages: nextflow.messages } : {})
  }

  const jupyter = tools.find((tool) => tool.id === 'jupyter')
  const jupyterPath = jupyter?.activePath ?? jupyter?.detectedPath
  const diagnostics = jupyterPath ? detectAnalysisKernels(runner, jupyterPath) : undefined
  const detectedKernels = diagnostics ? hostKernels(diagnostics) : []
  const kernels =
    detectedKernels.length > 0 || !jupyterPath
      ? detectedKernels
      : probeHostKernelSpecs(runner, jupyterPath)
  const jupyterTool: EnvironmentHostTool = {
    id: 'jupyter',
    label: 'Jupyter kernels',
    status: kernels.length > 0 ? 'ready' : (jupyter?.status ?? 'missing'),
    management: 'host-unmanaged',
    selected: jupyter?.source === 'custom',
    ...(jupyter?.source === 'custom' && jupyter.activePath ? { path: jupyter.activePath } : {}),
    ...(jupyter?.detectedPath ? { detectedPath: jupyter.detectedPath } : {}),
    ...(diagnostics?.jupyterServer.version
      ? { version: diagnostics.jupyterServer.version }
      : jupyter?.detectedVersion
        ? { version: jupyter.detectedVersion }
        : {}),
    detail: kernels.length > 0 ? `${kernels.length} 个本机 kernel` : '未检测到本机 kernel',
    ...(kernels.length === 0 && diagnostics?.messages.length
      ? { messages: diagnostics.messages }
      : {}),
    kernels
  }

  return [nextflowTool, jupyterTool]
}

export interface DetectEnvironmentOptions {
  runner?: CommandRunner
  which?: WhichResolver
  now?: () => string
}

/** Fresh detection of all toolchain tools (no user overrides applied). */
export function detectEnvironmentTools(
  options: DetectEnvironmentOptions = {}
): EnvironmentToolState[] {
  const runner = options.runner ?? defaultRunner
  const which = options.which ?? defaultWhich
  const byId: Record<EnvironmentToolId, EnvironmentToolState> = {
    micromamba: detectMicromambaFamily(runner, which),
    nextflow: detectNextflow(runner, which),
    docker: detectDocker(runner, which),
    singularity: detectSingularity(runner, which),
    jupyter: detectJupyter(runner, which),
    rscript: detectRscript(runner, which)
  }
  return ENVIRONMENT_TOOL_IDS.map((id) => byId[id])
}

/**
 * Probe a user-supplied absolute path for a tool. Returns a tool state with
 * source 'custom', or invalid if the probe fails.
 */
export function probeCustomToolPath(
  id: EnvironmentToolId,
  absolutePath: string,
  options: DetectEnvironmentOptions = {}
): ManagedToolState {
  const runner = options.runner ?? defaultRunner
  const label = ENVIRONMENT_TOOL_LABELS[id]
  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      id,
      label,
      status: 'invalid',
      activePath: absolutePath || undefined,
      source: 'custom',
      messages: ['路径不存在']
    }
  }

  let version: string | undefined
  let detail: string | undefined
  let messages: string[] | undefined

  try {
    if (id === 'jupyter') {
      const diagnostics = detectAnalysisKernels(runner, absolutePath)
      if (!diagnostics.jupyterServer.available) {
        return {
          id,
          label,
          status: 'invalid',
          activePath: absolutePath,
          source: 'custom',
          messages: [diagnostics.jupyterServer.error ?? '无法用该路径启动 Jupyter Server 探测']
        }
      }
      version = diagnostics.jupyterServer.version
      detail = `${diagnostics.kernels.length} 个 kernel`
      messages = diagnostics.messages.length ? diagnostics.messages : undefined
    } else if (id === 'nextflow') {
      return probeCustomNextflow(runner, absolutePath)
    } else if (id === 'docker' || id === 'singularity' || id === 'micromamba') {
      version =
        probeVersion(runner, absolutePath, ['--version']) ??
        probeVersion(runner, absolutePath, ['-V'])
    } else if (id === 'rscript') {
      version = probeVersion(runner, absolutePath, ['--version'])
    }
  } catch (error) {
    return {
      id,
      label,
      status: 'invalid',
      activePath: absolutePath,
      source: 'custom',
      messages: [error instanceof Error ? error.message : String(error)]
    }
  }

  return {
    id,
    label,
    status: 'ready',
    activePath: absolutePath,
    source: 'custom',
    ...(version ? { detectedVersion: version } : {}),
    ...(detail ? { detail } : {}),
    ...(messages ? { messages } : {})
  }
}

export function dirnameOfBinary(path: string): string {
  return dirname(path)
}

/**
 * A custom nextflow is accepted only when `-version` reports at least the wrappers'
 * minimum; it is then labelled {@link HOST_UNMANAGED}. Too old or unreadable is invalid,
 * and the wrapper executor refuses it too instead of falling back.
 */
function probeCustomNextflow(runner: CommandRunner, absolutePath: string): ManagedToolState {
  const label = ENVIRONMENT_TOOL_LABELS.nextflow
  const output = runner(absolutePath, ['-version'])
  const version = parseNextflowVersion(output)
  if (!version || !isNextflowVersionSupported(version)) {
    return {
      id: 'nextflow',
      label,
      status: 'invalid',
      activePath: absolutePath,
      source: 'custom',
      ...(version ? { detectedVersion: version } : {}),
      messages: [
        version
          ? `该 Nextflow 版本是 ${version}，Wrapper 需要 ${MIN_NEXTFLOW_VERSION} 或更新的版本`
          : `无法从 nextflow -version 读出版本，Wrapper 需要 ${MIN_NEXTFLOW_VERSION} 或更新的版本`
      ]
    }
  }
  return {
    id: 'nextflow',
    label,
    status: 'ready',
    activePath: absolutePath,
    source: 'custom',
    detectedVersion: version,
    detail: HOST_UNMANAGED,
    management: 'host-unmanaged'
  }
}
