import {
  RemoteSshConnectionError,
  type SshConnectionIssueCode
} from './wrappers/remote-ssh-diagnostics'

export const REMOTE_SETTINGS_GUIDANCE = '请在设置 → 远程中添加或修复服务器'

const SETTINGS_ISSUE_CODES: ReadonlySet<SshConnectionIssueCode> = new Set([
  'authentication_failed',
  'identity_not_loaded',
  'host_key_changed',
  'host_key_unknown',
  'host_key_unverified'
])

const TRANSPORTED_SETTINGS_FAILURES = [
  '远程项目的 SSH 服务器档案不可用',
  'SSH 非交互认证失败',
  'SSH 私钥尚未加载到 ssh-agent',
  'SSH 主机密钥与已信任的记录不一致',
  'SSH 主机密钥尚未被信任',
  'SSH 主机身份校验失败',
  'SSH 认证或主机信任失败后处于冷却期'
] as const

function needsSettingsGuidance(error: unknown): boolean {
  if (error instanceof RemoteSshConnectionError && SETTINGS_ISSUE_CODES.has(error.code)) {
    return true
  }
  const message = error instanceof Error ? error.message : ''
  return TRANSPORTED_SETTINGS_FAILURES.some((prefix) => message.startsWith(prefix))
}

export function remoteWorkspaceToolErrorMessage(error: unknown, fallback: string): string {
  if (needsSettingsGuidance(error)) return REMOTE_SETTINGS_GUIDANCE
  return error instanceof Error ? error.message : fallback
}
