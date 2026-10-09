import { RemoteSshConnectionError, type SshConnectionIssueCode } from './remote-ssh-diagnostics'

export const DEFAULT_SSH_AUTH_COOLDOWN_MS = 15 * 60 * 1_000

const BLOCKING_CODES: ReadonlySet<SshConnectionIssueCode> = new Set([
  'authentication_failed',
  'host_key_changed',
  'host_key_unknown',
  'host_key_unverified'
])

interface SshBlock {
  code: SshConnectionIssueCode
  blockedUntil: number
}

export interface RemoteSshAuthGate {
  recordSshFailure(hostKey: string, code: SshConnectionIssueCode): void
  assertSshNotBlocked(hostKey: string): void
  clearSshBlock(hostKey: string): void
}

export interface RemoteSshAuthGateOptions {
  now?: () => number
  cooldownMs?: number
}

export function createRemoteSshAuthGate(options: RemoteSshAuthGateOptions = {}): RemoteSshAuthGate {
  const now = options.now ?? Date.now
  const cooldownMs = options.cooldownMs ?? DEFAULT_SSH_AUTH_COOLDOWN_MS
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    throw new Error('SSH 认证失败冷却时长必须是正数')
  }
  let blocks: ReadonlyMap<string, SshBlock> = new Map()

  return {
    recordSshFailure(hostKey, code) {
      if (!BLOCKING_CODES.has(code)) return
      blocks = new Map(blocks).set(hostKey, { code, blockedUntil: now() + cooldownMs })
    },
    assertSshNotBlocked(hostKey) {
      const block = blocks.get(hostKey)
      if (!block) return
      const remainingMs = block.blockedUntil - now()
      if (remainingMs <= 0) {
        const next = new Map(blocks)
        next.delete(hostKey)
        blocks = next
        return
      }
      const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000))
      throw new RemoteSshConnectionError({
        code: block.code,
        message: `SSH 认证或主机信任失败后处于冷却期，剩余约 ${remainingMinutes} 分钟`,
        suggestion:
          '在设置里点测试连接可立即重试；不要自行更换 -i、端口或 StrictHostKeyChecking 反复连接。'
      })
    },
    clearSshBlock(hostKey) {
      if (!blocks.has(hostKey)) return
      const next = new Map(blocks)
      next.delete(hostKey)
      blocks = next
    }
  }
}

const processSshAuthGate = createRemoteSshAuthGate()

export const recordSshFailure = processSshAuthGate.recordSshFailure
export const assertSshNotBlocked = processSshAuthGate.assertSshNotBlocked
export const clearSshBlock = processSshAuthGate.clearSshBlock
