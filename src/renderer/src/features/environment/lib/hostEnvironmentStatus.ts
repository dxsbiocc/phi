import { environmentUi } from './environmentUi'
import type { EnvironmentHostTool } from '../../../../../shared/environmentTypes'

export type HostToolPresentation = {
  label: string
  color: 'success' | 'warning' | 'default'
}

/** One presentation rule for host-tool status across environment cards and details. */
export function hostToolPresentation(tool: EnvironmentHostTool): HostToolPresentation {
  if (tool.status === 'invalid') return { label: environmentUi.invalidPath, color: 'warning' }
  if (tool.selected && tool.status === 'ready')
    return { label: environmentUi.enabled, color: 'success' }
  if (tool.status === 'ready') return { label: environmentUi.available, color: 'success' }
  if (tool.status === 'not-configured') return { label: environmentUi.detected, color: 'default' }
  if (tool.detectedPath) return { label: environmentUi.unavailable, color: 'warning' }
  return { label: environmentUi.notFound, color: 'default' }
}

export function hostToolDisplayVersion(tool: EnvironmentHostTool): string | undefined {
  if (!tool.version) return undefined
  if (tool.id !== 'nextflow') return tool.version
  return /\b\d+(?:\.\d+){1,3}\b/u.exec(tool.version)?.[0]
}
