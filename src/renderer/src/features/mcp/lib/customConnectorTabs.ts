export type ConnectorTab = 'remote' | 'local'

export function resolveCustomConnectorTab(
  requested: ConnectorTab,
  localAvailable: boolean
): ConnectorTab {
  return requested === 'local' && !localAvailable ? 'remote' : requested
}
