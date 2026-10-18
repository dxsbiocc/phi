import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from './connectorCopy'
import type {
  FeaturedMcpConnector,
  McpConnectorSetupPhase,
  McpConnectorSetupProgress
} from '../../../../../shared/mcpConnectorCatalog'

export function connectorSetupActive(setup?: McpConnectorSetupProgress): boolean {
  return Boolean(
    setup && ['downloading', 'installing', 'environment', 'starting'].includes(setup.phase)
  )
}

export function connectorSetupLabel(phase: McpConnectorSetupPhase): string {
  return {
    downloading: connectorCopy.setupDownloading,
    installing: connectorCopy.setupInstalling,
    environment: connectorCopy.setupEnvironment,
    starting: connectorCopy.setupStarting,
    ready: connectorCopy.connectionVerified,
    installed: resourceUi.installed,
    removed: connectorCopy.notInstalled,
    failed: connectorCopy.setupFailed
  }[phase]
}

export function localConnectorToolsPrerequisite(connector: FeaturedMcpConnector): string | null {
  if (connector.transport !== 'stdio') return null
  if (connectorSetupActive(connector.setup)) return connectorCopy.toolsPreparing
  if (!connector.added) return connectorCopy.toolsAfterAdd
  if (connector.environmentState === 'not-built') return connectorCopy.toolsAfterEnvironment
  return null
}
