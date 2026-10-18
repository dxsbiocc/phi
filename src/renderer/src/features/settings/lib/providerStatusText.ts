import { settingsUi } from './settingsUi'

/** Only known host status values are UI copy; custom provider diagnostics stay verbatim. */
export function providerStatusText(status: string): string {
  if (status === '未配置' || status === 'Not configured') return settingsUi.notConfigured
  if (status === '已配置' || status === 'Configured') return settingsUi.configured
  const labels = settingsUi.credentialSources
  return Object.hasOwn(labels, status) ? labels[status as keyof typeof labels] : status
}
