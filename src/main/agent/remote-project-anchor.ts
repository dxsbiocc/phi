import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { getPhiAgentDir } from './runtime-paths'

const ANCHORS_DIR = 'remote-project-anchors'

function assertProjectId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('远程项目 ID 无效')
}

export function remoteProjectAnchorPath(projectId: string, agentDir = getPhiAgentDir()): string {
  assertProjectId(projectId)
  return join(agentDir, ANCHORS_DIR, projectId)
}

export function isRemoteProjectAnchorPath(path: string, agentDir = getPhiAgentDir()): boolean {
  if (!isAbsolute(path)) return false
  const anchors = resolve(agentDir, ANCHORS_DIR)
  const nested = relative(anchors, resolve(path))
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
}

/** Stable, Phi-private SDK cwd. It never contains a copy of remote project files. */
export function ensureRemoteProjectAnchor(projectId: string, agentDir = getPhiAgentDir()): string {
  const anchors = join(agentDir, ANCHORS_DIR)
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  mkdirSync(anchors, { recursive: true, mode: 0o700 })
  const agentReal = realpathSync(agentDir)
  const anchorsReal = realpathSync(anchors)
  if (relative(agentReal, anchorsReal) !== ANCHORS_DIR) {
    throw new Error('远程项目锚点目录不在 Phi 私有目录内')
  }
  chmodSync(anchors, 0o700)
  const anchor = remoteProjectAnchorPath(projectId, agentDir)
  if (!existsSync(anchor)) mkdirSync(anchor, { mode: 0o700 })
  if (realpathSync(anchor) !== join(anchorsReal, projectId)) {
    throw new Error('远程项目锚点路径无效')
  }
  chmodSync(anchor, 0o700)
  return anchor
}
