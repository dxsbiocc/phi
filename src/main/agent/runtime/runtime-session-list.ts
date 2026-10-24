import { getPhiEngine } from '../engine/in-process-engine'
import type { SessionInfo } from '../engine/types'
import { getPhiAgentDir } from '../runtime-paths'

export async function listRuntimeSessions(cwd: string): Promise<SessionInfo[]> {
  const infos = await getPhiEngine().history.list({ agentDir: getPhiAgentDir(), cwd })
  return infos.map((info) => ({
    ...info,
    created: new Date(info.created),
    modified: new Date(info.modified),
    name: info.name ?? info.title
  }))
}
