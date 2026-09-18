export type DefaultProxyMode = 'auto' | 'enabled' | 'disabled'

export interface ProxyTransportStatus {
  systemTransportAvailable: boolean
  controlledProxyAvailable: boolean
  controlledProxyName?: string
  autoTransportName: string
  enabledModeAvailable: boolean
  unavailableReason?: string
}

export interface PhiAppSettings {
  defaultProxyMode: DefaultProxyMode
  enableDbConnectorTools: boolean
  noProjectTaskFolder: string
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  proxyTransportStatus: ProxyTransportStatus
}

export type PhiAppSettingsPatch = {
  defaultProxyMode?: DefaultProxyMode
  enableDbConnectorTools?: boolean
  noProjectTaskFolder?: string
  preventSleepDuringRuns?: boolean
  nextActionSuggestionsEnabled?: boolean
}

export const DEFAULT_PROXY_MODE: DefaultProxyMode = 'auto'
export const DEFAULT_DB_CONNECTOR_TOOLS_ENABLED = true
export const DEFAULT_PREVENT_SLEEP_DURING_RUNS = false
export const DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED = true

export const DEFAULT_PROXY_TRANSPORT_STATUS: ProxyTransportStatus = {
  systemTransportAvailable: true,
  controlledProxyAvailable: false,
  autoTransportName: 'system',
  enabledModeAvailable: false,
  unavailableReason: '尚未配置受控代理通道'
}
