import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MAX_WORKSPACE_DIFF_BYTES,
  type WorkspaceDiffReference
} from '../../../shared/workspaceChangeTypes'
import { findPhiSessionById, getSessionDir } from './session-store'

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DIFF_ID_PATTERN = /^[0-9a-f]{64}$/

export function persistWorkspaceDiff(
  sessionId: string,
  patch: string
): WorkspaceDiffReference | null {
  const bytes = Buffer.from(patch, 'utf8')
  if (!SESSION_ID_PATTERN.test(sessionId) || !findPhiSessionById(sessionId)) return null
  if (bytes.length === 0 || bytes.length > MAX_WORKSPACE_DIFF_BYTES) return null
  const id = createHash('sha256').update(bytes).digest('hex')
  const dir = join(getSessionDir(sessionId), 'artifacts', 'workspace-diffs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.diff`)
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error('差异文件校验失败')
  } else {
    writeFileSync(path, bytes, { flag: 'wx' })
  }
  return { sessionId, id, bytes: bytes.length }
}

export function readWorkspaceDiff(input: unknown): string {
  if (!input || typeof input !== 'object') throw new Error('差异引用无效')
  const ref = input as Record<string, unknown>
  if (
    typeof ref.sessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(ref.sessionId) ||
    !findPhiSessionById(ref.sessionId) ||
    typeof ref.id !== 'string' ||
    !DIFF_ID_PATTERN.test(ref.id)
  ) {
    throw new Error('差异引用无效')
  }
  const path = join(getSessionDir(ref.sessionId), 'artifacts', 'workspace-diffs', `${ref.id}.diff`)
  const bytes = readFileSync(path)
  if (
    bytes.length > MAX_WORKSPACE_DIFF_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== ref.id
  ) {
    throw new Error('差异文件校验失败')
  }
  return bytes.toString('utf8')
}
