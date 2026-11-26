import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { PhiTool } from '../engine/types'
import { probeWsl, wslRequiredMessage, type WslProbe } from '../envs/wsl'
import type { SkillHostRequest } from './skill-tools'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'

const execFileAsync = promisify(execFile)

export const PHI_ENV_SETUP_WSL_DESCRIPTION =
  'Windows-only controlled helper that runs an allowlisted WSL2 setup action (install_wsl, install_ubuntu, or upgrade_to_wsl2) with explicit user approval and Windows UAC elevation, then re-checks WSL2 readiness. Never runs arbitrary shell commands.'

export type WslSetupAction = 'install_wsl' | 'install_ubuntu' | 'upgrade_to_wsl2'

const ALLOWED_ACTIONS: readonly WslSetupAction[] = [
  'install_wsl',
  'install_ubuntu',
  'upgrade_to_wsl2'
]

const SAFE_DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const PROPERTIES = {
  action: {
    type: 'string',
    enum: [...ALLOWED_ACTIONS],
    description:
      'Allowlisted WSL2 action: "install_wsl" (wsl --install), "install_ubuntu" (wsl --install -d Ubuntu), or "upgrade_to_wsl2" (wsl --set-version <distro> 2).'
  },
  distro: {
    type: 'string',
    description:
      'Target WSL distribution name for "upgrade_to_wsl2" (optional when probe detects the WSL1 distro).'
  },
  reason: {
    type: 'string',
    description: 'Short user-facing explanation of why WSL2 setup is requested.'
  }
} as const

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  details?: unknown
}

export interface EnvSetupWslToolOptions {
  runtimeSessionId: string
  agentRunId?: string
}

export interface WslSetupRpcResult {
  status: 'already_ready' | 'completed' | 'needs_reboot_or_init' | 'declined' | 'unsupported' | 'failed'
  action: WslSetupAction
  command?: string
  wslStatus?: WslProbe['status']
  distro?: string
  message: string
}

export function buildEnvSetupWslTool(
  request: SkillHostRequest,
  options: EnvSetupWslToolOptions
): PhiTool {
  return {
    name: 'env_setup_wsl',
    label: 'Set Up Windows WSL2',
    description: PHI_ENV_SETUP_WSL_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    // Explicit host approval card + Windows UAC elevation guard every invocation.
    approval: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: PROPERTIES
    },
    async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
      return runEnvSetupWsl(request, params, signal, options)
    }
  }
}

async function runEnvSetupWsl(
  request: SkillHostRequest,
  params: unknown,
  signal: AbortSignal | undefined,
  options: EnvSetupWslToolOptions
): Promise<ToolResult> {
  if (signal?.aborted) {
    return { content: [{ type: 'text', text: 'aborted' }], isError: true }
  }
  const input = isRecord(params) ? params : {}
  const action = parseAction(input.action)
  if (!action) {
    return {
      content: [{ type: 'text', text: `action must be one of: ${ALLOWED_ACTIONS.join(', ')}` }],
      isError: true
    }
  }
  const distro = optionalNonEmptyString(input.distro)
  if (distro !== undefined && !SAFE_DISTRO_NAME.test(distro)) {
    return {
      content: [{ type: 'text', text: `invalid WSL distribution name: ${distro}` }],
      isError: true
    }
  }
  const reason = optionalNonEmptyString(input.reason)

  try {
    const result = await request(
      'environments.setupWsl',
      {
        runtimeSessionId: options.runtimeSessionId,
        action,
        ...(distro ? { distro } : {}),
        ...(reason ? { reason } : {})
      },
      options.agentRunId ? { agentRunId: options.agentRunId } : undefined
    )
    if (!isWslSetupResult(result)) {
      return {
        content: [{ type: 'text', text: 'environments.setupWsl returned an unexpected result' }],
        isError: true
      }
    }
    const isError = result.status === 'declined' || result.status === 'failed' || result.status === 'unsupported'
    return {
      content: [{ type: 'text', text: result.message }],
      ...(isError ? { isError: true } : {}),
      details: result
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: errorMessage(error) }],
      isError: true
    }
  }
}

export interface HandleWslSetupDeps {
  platform?: NodeJS.Platform
  probeWsl?: () => WslProbe
  confirm?: (runtimeSessionId: string, summary: string) => Promise<boolean>
  runElevatedWsl?: (wslArgs: readonly string[]) => Promise<void>
}

export function wslArgsForAction(
  action: WslSetupAction,
  distro?: string
): { args: string[]; display: string } {
  if (action === 'install_wsl') {
    return { args: ['--install'], display: 'wsl --install' }
  }
  if (action === 'install_ubuntu') {
    return { args: ['--install', '-d', 'Ubuntu'], display: 'wsl --install -d Ubuntu' }
  }
  if (!distro || !SAFE_DISTRO_NAME.test(distro)) {
    throw new Error('upgrade_to_wsl2 requires a valid WSL distribution name')
  }
  return {
    args: ['--set-version', distro, '2'],
    display: `wsl --set-version ${distro} 2`
  }
}

async function defaultRunElevatedWsl(wslArgs: readonly string[]): Promise<void> {
  const psArgs = wslArgs.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(', ')
  const script = `$p = Start-Process -FilePath 'wsl.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(${psArgs}); if ($p.ExitCode -ne 0) { exit $p.ExitCode }`
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15 * 60 * 1000, windowsHide: false }
  )
}

/** Host RPC handler for `environments.setupWsl`. */
export async function handleWslSetupRequest(
  params: unknown,
  deps: HandleWslSetupDeps = {}
): Promise<WslSetupRpcResult> {
  const input = isRecord(params) ? params : {}
  const action = parseAction(input.action)
  if (!action) {
    return {
      status: 'failed',
      action: 'install_wsl',
      message: `Unsupported WSL setup action; expected one of ${ALLOWED_ACTIONS.join(', ')}`
    }
  }

  const hostPlatform = deps.platform ?? process.platform
  if (hostPlatform !== 'win32') {
    return {
      status: 'unsupported',
      action,
      message: '当前不是 Windows 系统，无需配置 WSL2。'
    }
  }

  const probe = deps.probeWsl ?? (() => probeWsl({ platform: hostPlatform }))
  const before = probe()
  if (before.status === 'ready') {
    return {
      status: 'already_ready',
      action,
      wslStatus: before.status,
      distro: before.distro,
      message: `本机 WSL2 已就绪（发行版：${before.distro}），无需重复安装。`
    }
  }

  const requestedDistro =
    optionalNonEmptyString(input.distro) ??
    (before.status === 'not-version-2' ? before.distro : undefined)

  let spec: { args: string[]; display: string }
  try {
    spec = wslArgsForAction(action, requestedDistro)
  } catch (error) {
    return {
      status: 'failed',
      action,
      wslStatus: before.status,
      message: errorMessage(error)
    }
  }

  const runtimeSessionId = optionalNonEmptyString(input.runtimeSessionId) ?? ''
  const reason = optionalNonEmptyString(input.reason)
  const summaryLines = [
    `以管理员权限（Windows UAC）执行受控 WSL2 配置：${spec.display}`,
    ...(reason ? [`原因：${reason}`] : []),
    '说明：系统会弹出 Windows 用户账户控制（UAC）确认窗口，同意后自动执行。'
  ]
  const approved = deps.confirm
    ? await deps.confirm(runtimeSessionId, summaryLines.join('\n'))
    : false
  if (!approved) {
    return {
      status: 'declined',
      action,
      command: spec.display,
      wslStatus: before.status,
      message: '用户取消了 WSL2 自动配置。如不想安装 WSL2，可在「设置 → 远程主机」配置远程 Linux/Slurm 服务器。'
    }
  }

  try {
    await (deps.runElevatedWsl ?? defaultRunElevatedWsl)(spec.args)
  } catch (error) {
    return {
      status: 'failed',
      action,
      command: spec.display,
      wslStatus: before.status,
      message: `执行 ${spec.display} 失败或 UAC 被取消：${errorMessage(error)}`
    }
  }

  const after = probe()
  if (after.status === 'ready') {
    return {
      status: 'completed',
      action,
      command: spec.display,
      wslStatus: after.status,
      distro: after.distro,
      message: `WSL2 已配置就绪（发行版：${after.distro}），现在可以直接构建并运行 Linux / Nextflow 环境。`
    }
  }

  return {
    status: 'needs_reboot_or_init',
    action,
    command: spec.display,
    wslStatus: after.status,
    message:
      `已执行 ${spec.display}，但 WSL2 尚未完成最终初始化（当前状态：${after.status}）。` +
      '如果是首次启用 WSL2，请重启 Windows 并打开一次 Ubuntu 完成初始化后，再回到 Phi 继续。' +
      `（详情：${wslRequiredMessage(after)}）`
  }
}

function parseAction(value: unknown): WslSetupAction | undefined {
  if (typeof value !== 'string') return undefined
  return (ALLOWED_ACTIONS as readonly string[]).includes(value)
    ? (value as WslSetupAction)
    : undefined
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isWslSetupResult(value: unknown): value is WslSetupRpcResult {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    typeof value.action === 'string' &&
    typeof value.message === 'string'
  )
}
