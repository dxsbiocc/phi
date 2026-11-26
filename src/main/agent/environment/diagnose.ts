import {
  describeEnvironment,
  type EnvironmentDescriptor
} from '../content/environment-refs'
import {
  findPlatform,
  getRuntimeRoot,
  probeWsl,
  wslRequiredMessage,
  type PhiPlatform,
  type WslProbe
} from '../envs'
import { listAvailableRemoteHostProfiles, type RemoteHostProfile } from '../remote-hosts'
import { getPhiAgentDir } from '../runtime-paths'
import { detectHostDependencies } from './detect'
import { listManagedEnvironments } from './managed'

import type {
  EnvironmentHostDependency,
  ManagedEnvironmentEntry
} from '../../../shared/environmentTypes'
import { errorMessage } from '../../../shared/errorCodes'

export type EnvironmentBlockerCode =
  | 'wsl_missing'
  | 'wsl_no_distro'
  | 'wsl_version_1'
  | 'wsl_distro_unavailable'
  | 'nextflow_windows_profile'
  | 'env_not_built'
  | 'env_unavailable'

export interface EnvironmentRemediationOption {
  id: string
  title: string
  recommended?: boolean
  summary: string
  steps: string[]
  commands?: string[]
  settingsTarget?: 'environment' | 'remote-hosts'
}

export interface EnvironmentIssueGuidance {
  code: EnvironmentBlockerCode
  ref?: string
  summary: string
  detail: string
  options: EnvironmentRemediationOption[]
}

export type EnvironmentDiagnoseTopic = 'all' | 'nextflow' | 'wsl' | 'managed' | 'remote'

export interface EnvironmentDiagnosticRemoteHost {
  id: string
  label: string
  hostAlias: string
  source?: 'ssh-config'
}

export interface EnvironmentDiagnosticManagedEntry {
  ref: string
  name: string
  source: ManagedEnvironmentEntry['source']
  state: ManagedEnvironmentEntry['state']
  runtime?: 'native' | 'wsl2'
  unavailableReason?: ManagedEnvironmentEntry['unavailableReason']
}

export interface EnvironmentDiagnosticReport {
  platform: {
    os: NodeJS.Platform
    arch: string
    phiPlatform?: PhiPlatform
  }
  wsl?: {
    status: WslProbe['status']
    distro?: string
    version?: number
    message?: string
  }
  hostDependencies: Array<{
    id: EnvironmentHostDependency['id']
    label: string
    status: EnvironmentHostDependency['status']
    version?: string
    detail?: string
    messages?: string[]
  }>
  managedEnvironments: EnvironmentDiagnosticManagedEntry[]
  remoteHosts: EnvironmentDiagnosticRemoteHost[]
  guidance?: EnvironmentIssueGuidance
}

export interface DiagnoseEnvironmentIssueInput {
  platform?: PhiPlatform
  hostPlatform?: NodeJS.Platform
  ref?: string
  profile?: string
  descriptor?: EnvironmentDescriptor
  wslProbe?: WslProbe
  remoteHosts?: readonly Pick<RemoteHostProfile, 'id' | 'label' | 'hostAlias' | 'source'>[]
}

function remoteOption(
  remoteHosts: readonly Pick<RemoteHostProfile, 'label' | 'hostAlias'>[],
  purpose: string
): EnvironmentRemediationOption {
  if (remoteHosts.length > 0) {
    const names = remoteHosts.slice(0, 5).map((host) => `${host.label} (${host.hostAlias})`)
    return {
      id: 'use-remote-host',
      title: '使用已配置的远程 Linux / HPC 服务器（免装 WSL2）',
      summary: `当前已检测到 ${remoteHosts.length} 个可用 SSH 远程主机，可直接将 ${purpose} 调度到远程 Linux 执行。`,
      steps: [
        `可用远程主机：${names.join('、')}${remoteHosts.length > 5 ? ' 等' : ''}`,
        '在项目设置中绑定默认远程主机与远程工作目录，或在调用 Wrapper 时指定 target="remote"。'
      ],
      settingsTarget: 'remote-hosts'
    }
  }
  return {
    id: 'configure-remote-host',
    title: '配置远程 Linux / Slurm 服务器（免装 WSL2）',
    summary: `如果不想在 Windows 本机安装 WSL2，可将 ${purpose} 交给远程 Linux 服务器或 HPC 集群执行。`,
    steps: [
      '打开「设置 → 远程主机」，添加可免密 SSH 登录的 Linux 主机或导入 ~/.ssh/config 别名。',
      '在项目设置中关联该远程主机与远程工作目录，随后以 target="remote" 运行。'
    ],
    settingsTarget: 'remote-hosts'
  }
}

export function buildWslRemediationGuidance(input: {
  probe: WslProbe
  ref?: string
  remoteHosts?: readonly Pick<RemoteHostProfile, 'label' | 'hostAlias'>[]
}): EnvironmentIssueGuidance | undefined {
  const { probe, ref } = input
  if (probe.status === 'ready' || probe.status === 'unsupported') return undefined

  const remoteHosts = input.remoteHosts ?? []
  const targetLabel = ref ?? 'Linux 受管理环境'
  const baseMessage = wslRequiredMessage(probe)

  let code: EnvironmentBlockerCode
  let summary: string
  let wslTitle: string
  let wslSteps: string[]
  let wslCommands: string[]

  if (probe.status === 'no-distro') {
    code = 'wsl_no_distro'
    summary = `Windows 已检测到 WSL，但尚未安装可用的 Linux 发行版，无法构建或运行 ${targetLabel}。`
    wslTitle = '在 Windows 本机安装 WSL2 Ubuntu 发行版'
    wslCommands = ['wsl --install -d Ubuntu']
    wslSteps = [
      '以管理员身份打开 PowerShell，运行 `wsl --install -d Ubuntu`。',
      '首次打开 Ubuntu 完成用户名与密码初始化。',
      '回到 Phi「设置 → 环境」点击「重新检测」，再构建所需环境。'
    ]
  } else if (probe.status === 'not-version-2') {
    code = 'wsl_version_1'
    summary = `WSL 发行版 ${probe.distro} 当前为 WSL ${probe.version}，Phi 需要 WSL2 才能运行 ${targetLabel}。`
    wslTitle = `将 WSL 发行版 ${probe.distro} 升级到 WSL2`
    wslCommands = [`wsl --set-version ${probe.distro} 2`]
    wslSteps = [
      `在 PowerShell 中运行 \`wsl --set-version ${probe.distro} 2\`。`,
      '升级完成后回到 Phi「设置 → 环境」点击「重新检测」，再构建所需环境。'
    ]
  } else if (probe.status === 'distro-unavailable') {
    code = 'wsl_distro_unavailable'
    summary = `Phi 绑定的 WSL 发行版 ${probe.distro} 当前不可用，无法访问其中的受管理环境 ${targetLabel}。`
    wslTitle = `恢复 WSL2 发行版 ${probe.distro}`
    wslCommands = ['wsl -l -v']
    wslSteps = [
      '在 PowerShell 中运行 `wsl -l -v` 检查发行版状态。',
      `恢复或重新启动 ${probe.distro} 后，回到 Phi「设置 → 环境」点击「重新检测」。`
    ]
  } else {
    code = 'wsl_missing'
    summary = `当前 Windows 尚未安装 WSL2，无法在本机运行依赖 Linux 的 ${targetLabel}。`
    wslTitle = '在 Windows 本机启用 WSL2'
    wslCommands = ['wsl --install']
    wslSteps = [
      '以管理员身份打开 PowerShell，运行 `wsl --install`。',
      '重启 Windows，并首次打开默认 Ubuntu 终端完成初始化。',
      '回到 Phi「设置 → 环境」点击「重新检测」，再构建所需环境。'
    ]
  }

  return {
    code,
    ...(ref ? { ref } : {}),
    summary,
    detail: baseMessage,
    options: [
      {
        id: 'setup-wsl2',
        title: wslTitle,
        recommended: remoteHosts.length === 0,
        summary: '完成 WSL2 初始化后，Phi 会自动复用 Linux 锁文件在本地构建和运行该环境。',
        steps: wslSteps,
        commands: wslCommands,
        settingsTarget: 'environment'
      },
      {
        ...remoteOption(remoteHosts, targetLabel),
        recommended: remoteHosts.length > 0
      }
    ]
  }
}

export function buildNextflowWindowsProfileGuidance(input: {
  profile: string
  remoteHosts?: readonly Pick<RemoteHostProfile, 'label' | 'hostAlias'>[]
}): EnvironmentIssueGuidance {
  const remoteHosts = input.remoteHosts ?? []
  const profile = input.profile
  return {
    code: 'nextflow_windows_profile',
    ref: 'phi:nextflow@1',
    summary: `Windows 本机 WSL2 下的 Nextflow 不支持 ${profile} profile，请改用 conda profile 或切换到远程 Linux 服务器。`,
    detail: `Local Nextflow in WSL2 cannot use the ${profile} profile. Choose conda, or run this Wrapper on a configured Linux server.`,
    options: [
      {
        id: 'use-conda-profile',
        title: '在本地 WSL2 下切换为 conda profile',
        recommended: remoteHosts.length === 0,
        summary: '本地 WSL2 托管 Nextflow 支持通过 conda profile 自动准备模块依赖，无需本机容器运行时。',
        steps: [
          '重新运行该 Wrapper 时将执行 profile 改为 `conda`。',
          '若尚未构建 `phi:nextflow@1`，在「设置 → 环境」中构建后即可运行。'
        ],
        settingsTarget: 'environment'
      },
      {
        ...remoteOption(remoteHosts, `使用 ${profile} profile 的 Nextflow Wrapper`),
        recommended: remoteHosts.length > 0
      }
    ]
  }
}

export function formatEnvironmentGuidanceText(guidance: EnvironmentIssueGuidance): string {
  const lines = [guidance.detail, '', `建议处理方式（${guidance.summary}）：`]
  for (const [index, option] of guidance.options.entries()) {
    const tag = option.recommended ? '（推荐）' : ''
    lines.push(`${index + 1}. ${option.title}${tag}：${option.summary}`)
    for (const step of option.steps) {
      lines.push(`   - ${step}`)
    }
  }
  return lines.join('\n')
}

export function diagnoseEnvironmentIssue(
  input: DiagnoseEnvironmentIssueInput
): EnvironmentIssueGuidance | undefined {
  const hostPlatform = input.hostPlatform ?? process.platform
  const platform = input.platform ?? findPlatform(hostPlatform, process.arch)
  const isWindows = platform === 'win32-x64' || hostPlatform === 'win32'
  const remoteHosts = input.remoteHosts ?? []

  if (isWindows && input.ref === 'phi:nextflow@1' && input.profile && input.profile !== 'conda') {
    return buildNextflowWindowsProfileGuidance({ profile: input.profile, remoteHosts })
  }

  const needsWsl =
    input.descriptor?.runtime === 'wsl2' ||
    (isWindows && input.ref === 'phi:nextflow@1')
  if (isWindows && needsWsl) {
    const probe = input.wslProbe ?? probeWsl({ platform: hostPlatform })
    const wslGuidance = buildWslRemediationGuidance({
      probe,
      ref: input.ref ?? input.descriptor?.ref,
      remoteHosts
    })
    if (wslGuidance) return wslGuidance
  }

  return undefined
}

export interface DiagnoseLocalEnvironmentOptions {
  root?: string
  agentDir?: string
  environmentsDir?: string
  projectDir?: string
  hostPlatform?: NodeJS.Platform
  arch?: string
  platform?: PhiPlatform
  ref?: string
  profile?: string
  topic?: EnvironmentDiagnoseTopic
  probeWsl?: () => WslProbe
  detectHost?: typeof detectHostDependencies
  listManaged?: typeof listManagedEnvironments
  listRemoteHosts?: () => RemoteHostProfile[]
}

export async function diagnoseLocalEnvironment(
  options: DiagnoseLocalEnvironmentOptions = {}
): Promise<EnvironmentDiagnosticReport> {
  const hostPlatform = options.hostPlatform ?? process.platform
  const arch = options.arch ?? process.arch
  const phiPlatform = options.platform ?? findPlatform(hostPlatform, arch)
  const root = options.root ?? getRuntimeRoot()
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const topic = options.topic ?? 'all'
  const isWindows = phiPlatform === 'win32-x64' || hostPlatform === 'win32'

  const wslProbe = isWindows
    ? (options.probeWsl?.() ?? probeWsl({ platform: hostPlatform }))
    : undefined

  const hostDeps =
    topic === 'all' || topic === 'nextflow' || topic === 'wsl'
      ? (options.detectHost ?? detectHostDependencies)({
          platform: hostPlatform,
          ...(wslProbe ? { probeWsl: () => wslProbe } : {})
        })
      : []

  const remoteProfiles =
    topic === 'all' || topic === 'remote' || topic === 'nextflow' || topic === 'wsl'
      ? (options.listRemoteHosts ?? (() => listAvailableRemoteHostProfiles(agentDir)))()
      : []
  const remoteHosts: EnvironmentDiagnosticRemoteHost[] = remoteProfiles.map((host) => ({
    id: host.id,
    label: host.label,
    hostAlias: host.hostAlias,
    ...(host.source ? { source: host.source } : {})
  }))

  let managedEntries: ManagedEnvironmentEntry[] = []
  if (topic === 'all' || topic === 'managed' || topic === 'nextflow' || topic === 'wsl' || options.ref) {
    try {
      managedEntries = await (options.listManaged ?? listManagedEnvironments)({
        root,
        agentDir,
        ...(options.environmentsDir ? { environmentsDir: options.environmentsDir } : {}),
        ...(options.projectDir ? { projectDir: options.projectDir } : {}),
        ...(phiPlatform ? { platform: phiPlatform } : {}),
        includeDynamic: false
      })
    } catch {
      managedEntries = []
    }
  }

  const filteredManaged = options.ref
    ? managedEntries.filter((entry) => entry.ref === options.ref)
    : topic === 'nextflow'
      ? managedEntries.filter((entry) => entry.ref === 'phi:nextflow@1')
      : topic === 'wsl'
        ? managedEntries.filter((entry) => entry.runtime === 'wsl2')
        : managedEntries

  const managedEnvironments: EnvironmentDiagnosticManagedEntry[] = filteredManaged.map((entry) => ({
    ref: entry.ref,
    name: entry.label ?? entry.ref,
    source: entry.source,
    state: entry.state,
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {})
  }))

  let descriptor: EnvironmentDescriptor | undefined
  let descriptorError: string | undefined
  if (options.ref && phiPlatform) {
    try {
      descriptor = describeEnvironment(options.ref, {
        ...(options.environmentsDir ? { environmentsDir: options.environmentsDir } : {}),
        ...(options.projectDir ? { projectDir: options.projectDir } : {}),
        agentDir,
        platform: phiPlatform
      })
    } catch (error) {
      descriptorError = errorMessage(error)
    }
  }

  let guidance = diagnoseEnvironmentIssue({
    platform: phiPlatform,
    hostPlatform,
    ref: options.ref ?? (topic === 'nextflow' ? 'phi:nextflow@1' : undefined),
    profile: options.profile,
    descriptor,
    wslProbe,
    remoteHosts
  })

  if (!guidance && isWindows && wslProbe && wslProbe.status !== 'ready' && topic === 'wsl') {
    guidance = buildWslRemediationGuidance({ probe: wslProbe, remoteHosts })
  }

  if (!guidance && options.ref) {
    const matched = managedEntries.find((entry) => entry.ref === options.ref)
    if (matched?.state === 'unavailable') {
      guidance = {
        code: 'env_unavailable',
        ref: options.ref,
        summary: `受管理环境 ${options.ref} 当前平台不可用（原因：${matched.unavailableReason ?? 'missing-lock'}）。`,
        detail: descriptorError ?? `Environment ${options.ref} is unavailable on ${phiPlatform ?? hostPlatform}.`,
        options: [remoteOption(remoteHosts, options.ref)]
      }
    } else if (matched && matched.state !== 'ready') {
      guidance = {
        code: 'env_not_built',
        ref: options.ref,
        summary: `受管理环境 ${options.ref} 尚未构建完成（当前状态：${matched.state}）。`,
        detail: `Environment ${options.ref} is currently ${matched.state}.`,
        options: [
          {
            id: 'build-managed-env',
            title: `在「设置 → 环境」中构建 ${options.ref}`,
            recommended: true,
            summary:
              matched.runtime === 'wsl2'
                ? '本机 WSL2 已就绪，可以直接在环境面板点击构建该 WSL2 环境。'
                : '可以直接在环境面板点击构建，或触发对应功能时在确认弹窗中同意构建。',
            steps: [`打开「设置 → 环境」，找到 ${options.ref} 并点击构建。`],
            settingsTarget: 'environment'
          }
        ]
      }
    }
  }

  return {
    platform: {
      os: hostPlatform,
      arch,
      ...(phiPlatform ? { phiPlatform } : {})
    },
    ...(wslProbe
      ? {
          wsl: {
            status: wslProbe.status,
            ...('distro' in wslProbe && wslProbe.distro ? { distro: wslProbe.distro } : {}),
            ...('version' in wslProbe && wslProbe.version ? { version: wslProbe.version } : {}),
            ...(wslProbe.status !== 'ready' && wslProbe.status !== 'unsupported'
              ? { message: wslRequiredMessage(wslProbe) }
              : {})
          }
        }
      : {}),
    hostDependencies: hostDeps.map((dep) => ({
      id: dep.id,
      label: dep.label,
      status: dep.status,
      ...(dep.version ? { version: dep.version } : {}),
      ...(dep.detail ? { detail: dep.detail } : {}),
      ...(dep.messages && dep.messages.length > 0 ? { messages: dep.messages } : {})
    })),
    managedEnvironments,
    remoteHosts,
    ...(guidance ? { guidance } : {})
  }
}

export function formatDiagnosticReportSummary(report: EnvironmentDiagnosticReport): string {
  const lines: string[] = []
  lines.push(
    `运行平台：${report.platform.os}/${report.platform.arch}` +
      (report.platform.phiPlatform ? ` (${report.platform.phiPlatform})` : '')
  )

  if (report.wsl) {
    const detail = [
      report.wsl.status,
      report.wsl.distro ? `distro=${report.wsl.distro}` : '',
      report.wsl.version !== undefined ? `v${report.wsl.version}` : ''
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(`WSL2 状态：${detail}${report.wsl.message ? ` — ${report.wsl.message}` : ''}`)
  }

  if (report.hostDependencies.length > 0) {
    lines.push(
      '宿主机依赖：' +
        report.hostDependencies
          .map((dep) => `${dep.label}=${dep.status}${dep.version ? `(${dep.version})` : ''}`)
          .join('，')
    )
  }

  if (report.managedEnvironments.length > 0) {
    lines.push('受管理环境：')
    for (const env of report.managedEnvironments) {
      const runtime = env.runtime ? ` [${env.runtime}]` : ''
      const reason = env.unavailableReason ? ` (${env.unavailableReason})` : ''
      lines.push(`- ${env.ref}${runtime}: ${env.state}${reason}`)
    }
  }

  if (report.remoteHosts.length > 0) {
    lines.push(
      `已配置远程主机（${report.remoteHosts.length}）：` +
        report.remoteHosts.map((host) => `${host.label} (${host.hostAlias})`).join('、')
    )
  } else {
    lines.push('已配置远程主机：无')
  }

  if (report.guidance) {
    lines.push('')
    lines.push(formatEnvironmentGuidanceText(report.guidance))
  }

  return lines.join('\n')
}
