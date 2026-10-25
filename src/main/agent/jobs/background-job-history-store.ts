import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { isRecord } from '../../../shared/guards'
import { getPhiAgentDir } from '../runtime-paths'

const MAX_BYTES = 128 * 1024
const MAX_RECORDS = 50

export function backgroundJobHistoryPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'background-jobs', 'history-v1.json')
}

export function readBackgroundJobHistory(agentDir = getPhiAgentDir()): string | null {
  let fd: number | undefined
  try {
    fd = openSync(backgroundJobHistoryPath(agentDir), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return null
    const value = readFileSync(fd, 'utf8')
    return Buffer.byteLength(value, 'utf8') <= MAX_BYTES ? value : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function writeBackgroundJobHistory(value: unknown, agentDir = getPhiAgentDir()): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES)
    throw new Error('Background job history exceeds its size limit')
  let document: unknown
  try {
    document = JSON.parse(value)
  } catch {
    throw new Error('Invalid background job history')
  }
  if (
    !isRecord(document) ||
    document.schema !== 1 ||
    !Array.isArray(document.records) ||
    document.records.length > MAX_RECORDS ||
    !isRecord(document.dismissed)
  )
    throw new Error('Invalid background job history')
  const dir = join(agentDir, 'background-jobs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.history-v1.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, backgroundJobHistoryPath(agentDir))
    chmodSync(backgroundJobHistoryPath(agentDir), 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}
