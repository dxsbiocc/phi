import { cpSync, existsSync } from 'node:fs'
import { SessionManager } from '@oh-my-pi/pi-coding-agent'
import { readRuntimeSessionMessagesText } from '../../runtime/runtime-session-text'
import { isRecord, stringValue } from './common'

export async function listSessions(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const infos = await SessionManager.list(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
  return Promise.all(
    infos.map(async (info) => {
      const allMessagesText = await readRuntimeSessionMessagesText(info.path)
      return allMessagesText ? { ...info, allMessagesText } : info
    })
  )
}

export async function openSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const path = stringValue(record.path)
  const cwd = stringValue(record.cwd, process.cwd())
  const manager = await SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  const result = {
    cwd: manager.getCwd(),
    sessionFile: manager.getSessionFile(),
    name: manager.getSessionName()
  }
  await manager.close()
  return result
}

export function userMessageText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== 'user') return null
  if (message.synthetic === true) return null
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return null
  return message.content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('')
}

export async function forkSession(params: unknown): Promise<{ path: string }> {
  const record = isRecord(params) ? params : {}
  const path = stringValue(record.path)
  const cwd = stringValue(record.cwd)
  const userMessages = record.userMessages
  const selectedIndex = record.selectedIndex
  if (
    !path ||
    !cwd ||
    !Array.isArray(userMessages) ||
    !userMessages.every((value) => typeof value === 'string') ||
    typeof selectedIndex !== 'number' ||
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0 ||
    selectedIndex >= userMessages.length
  ) {
    throw new Error('无效的会话分叉请求')
  }
  const manager = await SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  try {
    const branch = manager.getBranch()
    let searchFrom = 0
    const matched: number[] = []
    for (const text of userMessages) {
      const index = branch.findIndex(
        (entry, index) =>
          index >= searchFrom && entry.type === 'message' && userMessageText(entry.message) === text
      )
      if (index < 0) throw new Error('会话历史与界面消息无法对应，请重新打开会话后重试')
      matched.push(index)
      searchFrom = index + 1
    }
    const nextUserIndex = matched[selectedIndex + 1]
    const leaf = branch[(nextUserIndex ?? branch.length) - 1]
    if (!leaf) throw new Error('无法定位会话分叉点')
    const forkPath = manager.createBranchedSession(leaf.id)
    if (!forkPath) throw new Error('无法保存分叉会话')
    if (path.endsWith('.jsonl') && forkPath.endsWith('.jsonl')) {
      const sourceArtifacts = path.slice(0, -6)
      if (existsSync(sourceArtifacts))
        cpSync(sourceArtifacts, forkPath.slice(0, -6), { recursive: true })
    }
    return { path: forkPath }
  } finally {
    await manager.close()
  }
}

export async function renameSession(params: unknown): Promise<void> {
  const record = isRecord(params) ? params : {}
  const path = stringValue(record.path)
  const name = stringValue(record.name)
  const manager = await SessionManager.open(path)
  await manager.setSessionName(name, 'user')
  await manager.close()
}
