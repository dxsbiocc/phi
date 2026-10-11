import type { PromptAgentSummary } from '../../../types'

function trustRequest(
  agent: PromptAgentSummary,
  cwd: string
): {
  cwd: string
  relativePath: string
  contentHash: string
} {
  if (
    agent.scope !== 'remote-project' ||
    !agent.relativePath ||
    !agent.contentHash ||
    agent.trustState === 'invalid'
  ) {
    throw new Error('该 agent 不能更改信任状态')
  }
  return { cwd, relativePath: agent.relativePath, contentHash: agent.contentHash }
}

export async function mutateRemoteAgentTrust(
  agent: PromptAgentSummary,
  cwd: string,
  onChanged?: () => void | Promise<void>
): Promise<PromptAgentSummary[]> {
  const input = trustRequest(agent, cwd)
  const entries = await (agent.trustState === 'trusted'
    ? window.api.revokeRemoteProjectAgentTrust(input)
    : window.api.trustRemoteProjectAgent(input))
  await onChanged?.()
  return entries
}
