import type { CapabilityApprovalRequest } from './capability-service'

const labels = { wrapper: 'Wrapper', mcp: 'Connector', skill: 'Skill', plugin: 'Plugin' }
const sourceLabel = (source: string): string => (source === 'Phi 官网' ? 'Phi Website' : source)

export function capabilityApprovalSummary(request: CapabilityApprovalRequest): string {
  return [
    `${request.action === 'enable' ? 'Enable' : 'Install'} ${labels[request.root.type]}: ${request.root.id} @ ${request.root.version}`,
    `Purpose: ${request.reason}`,
    `Source: ${sourceLabel(request.source)} (${request.trust === 'official' ? 'official signed source' : 'configured source'})`,
    'Included packages and dependencies:',
    ...request.packages.map(
      (item) =>
        `• ${labels[item.type]} ${item.title} (${item.id} @ ${item.version}) — ${sourceLabel(item.source)}${item.alreadyInstalled ? ', already installed' : ''}`
    ),
    `Estimated download: ${(request.totalSize / 1024 / 1024).toFixed(2)} MB`,
    ...(request.environments.length
      ? [`Required environments: ${request.environments.join(', ')}`]
      : [])
  ].join('\n')
}
