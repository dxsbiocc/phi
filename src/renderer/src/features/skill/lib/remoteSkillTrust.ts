import type { SkillSummary } from '../../../types'
import type { RemoteTrustResource } from '../../agent/AgentTrustPanel'

function trustRequest(
  resource: RemoteTrustResource,
  cwd: string
): { cwd: string; relativePath: string; contentHash: string } {
  if (!resource.relativePath || !resource.contentHash || resource.trustState === 'invalid') {
    throw new Error('该 Skill 不能更改信任状态')
  }
  return {
    cwd,
    relativePath: resource.relativePath,
    contentHash: resource.contentHash
  }
}

export async function mutateRemoteSkillTrust(
  resource: RemoteTrustResource,
  cwd: string,
  onChanged?: () => void | Promise<void>
): Promise<SkillSummary[]> {
  const input = trustRequest(resource, cwd)
  const entries = await (resource.trustState === 'trusted'
    ? window.api.revokeRemoteProjectSkillTrust(input)
    : window.api.trustRemoteProjectSkill(input))
  await onChanged?.()
  return entries
}
