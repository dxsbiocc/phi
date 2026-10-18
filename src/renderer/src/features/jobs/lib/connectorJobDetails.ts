import { getUiLocale } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorJobCopy } from './connectorJobCopy'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { connectorJobDuration, connectorJobStatusLabel } from './backgroundJobs'

function startedAtLabel(setup: McpConnectorSetupProgress): string {
  if (!setup.startedAt || !Number.isFinite(Date.parse(setup.startedAt)))
    return connectorJobCopy.unknown
  return new Date(setup.startedAt).toLocaleString(getUiLocale(), { hour12: false })
}

export function connectorJobToolsLabel(setup: McpConnectorSetupProgress): string {
  return setup.toolNames?.length ? setup.toolNames.join(', ') : connectorJobCopy.noTools
}

export function buildConnectorJobDetailText(
  setup: McpConnectorSetupProgress,
  nowMs: number
): string {
  return [
    `${connectorJobCopy.connectorName}: ${setup.title ?? setup.id}`,
    `${resourceUi.status}: ${connectorJobStatusLabel(setup)}`,
    `${connectorJobCopy.command}:\n${setup.summary ?? setup.id}`,
    `${connectorJobCopy.startedAt}: ${startedAtLabel(setup)}`,
    `${connectorJobCopy.duration}: ${connectorJobDuration(setup, nowMs)}`,
    `${connectorJobCopy.error}:\n${setup.error ?? connectorJobCopy.noError}`,
    `${connectorJobCopy.processOutput}:\n${setup.detail ?? connectorJobCopy.noOutput}`,
    `${connectorJobCopy.toolList}: ${setup.phase === 'ready' ? connectorJobToolsLabel(setup) : connectorJobCopy.notApplicable}`
  ].join('\n')
}

export { startedAtLabel as connectorJobStartedAtLabel }
