import type { ProxyTransportStatus } from '../../../shared/appSettingsTypes'
import { DEFAULT_PROXY_TRANSPORT_STATUS } from '../../../shared/appSettingsTypes'
import type { DbEgressTransport } from './policy'

export function getDbProxyTransport(): DbEgressTransport | undefined {
  return undefined
}

export function getDbProxyTransportStatus(): ProxyTransportStatus {
  const proxyTransport = getDbProxyTransport()
  if (!proxyTransport) return DEFAULT_PROXY_TRANSPORT_STATUS

  return {
    systemTransportAvailable: true,
    controlledProxyAvailable: true,
    controlledProxyName: proxyTransport.name ?? 'proxy',
    autoTransportName: proxyTransport.name ?? 'proxy',
    enabledModeAvailable: true
  }
}
