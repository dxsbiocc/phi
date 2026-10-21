import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  SshHostAvailabilityRecord,
  SshHostAvailabilityStatus
} from '../../shared/sshHostAvailability'
import { getPhiAgentDir } from './runtime-paths'

const FILE_NAME = 'ssh-host-availability.json'
const MAX_RECORDS = 200

const STATUSES = new Set<SshHostAvailabilityStatus>(['available', 'unavailable', 'attention'])

function filePath(agentDir: string): string {
  return join(agentDir, FILE_NAME)
}

function validHostId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\r\n]/.test(value)
  )
}

function recordFrom(value: unknown): SshHostAvailabilityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (!validHostId(entry.hostId) || !STATUSES.has(entry.status as SshHostAvailabilityStatus))
    return null
  if (typeof entry.checkedAt !== 'string' || Number.isNaN(Date.parse(entry.checkedAt))) return null
  return {
    hostId: entry.hostId,
    status: entry.status as SshHostAvailabilityStatus,
    checkedAt: entry.checkedAt
  }
}

export function listSshHostAvailability(agentDir = getPhiAgentDir()): SshHostAvailabilityRecord[] {
  if (!existsSync(filePath(agentDir))) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath(agentDir), 'utf-8'))
    if (!Array.isArray(raw)) return []
    const records = new Map<string, SshHostAvailabilityRecord>()
    for (const item of raw) {
      const record = recordFrom(item)
      if (record) records.set(record.hostId, record)
    }
    return [...records.values()].slice(-MAX_RECORDS)
  } catch {
    return []
  }
}

export function saveSshHostAvailability(
  input: SshHostAvailabilityRecord,
  agentDir = getPhiAgentDir()
): SshHostAvailabilityRecord[] {
  const record = recordFrom(input)
  if (!record) throw new Error('SSH 服务器可用状态无效')
  const next = listSshHostAvailability(agentDir).filter((item) => item.hostId !== record.hostId)
  next.push(record)
  const stored = next.slice(-MAX_RECORDS)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(filePath(agentDir), `${JSON.stringify(stored, null, 2)}\n`, 'utf-8')
  return stored
}
