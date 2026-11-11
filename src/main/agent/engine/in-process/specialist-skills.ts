import { installedCapabilitySkillFiles } from './capability-refresh'
import { isRecord } from './common'

/**
 * The kernel keeps only policy booleans from session resources, so a specialist
 * loader cannot rely on the conversation's additionalSkillFiles. Merge the
 * installed capability skills (plugins and skill packages) the main session
 * already sees, then let the agent's declared skill list select from them.
 */
export function specialistSkillFiles(value: unknown, agentDir: string, cwd: string): string[] {
  const record = isRecord(value) ? value : {}
  const existing = Array.isArray(record.additionalSkillFiles)
    ? record.additionalSkillFiles.filter((file): file is string => typeof file === 'string')
    : []
  return [...new Set([...existing, ...installedCapabilitySkillFiles(agentDir, cwd)])]
}
