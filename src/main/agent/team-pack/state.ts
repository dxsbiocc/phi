import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { teamPackError } from './errors'
import { jsonBytes, parseTeamState, type TeamState } from './format'
import { assertManagedFile, writeAtomic } from './files'

export function teamStateRoot(stateDir: string, teamId: string): string {
  return join(stateDir, teamId)
}

export function readTeamState(stateDir: string, teamId: string): TeamState | null {
  const path = join(teamStateRoot(stateDir, teamId), 'state.json')
  assertManagedFile(path, '团队包状态文件')
  if (!existsSync(path)) return null
  try {
    return parseTeamState(readFileSync(path))
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '本地团队包状态无效', error)
  }
}

export function writeTeamState(
  stateDir: string,
  teamId: string,
  teamKeyId: string,
  release: number,
  manifestSha256: string
): void {
  const state: TeamState = {
    version: 1,
    teamKeyId,
    highestRelease: release,
    manifestSha256
  }
  try {
    writeAtomic(join(teamStateRoot(stateDir, teamId), 'state.json'), jsonBytes(state), 0o600)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法持久化团队包版本状态', error)
  }
}
