import type { EnvironmentHostTool } from '../../../../../shared/environmentTypes'

export type HostToolPresentation = {
  label: '已启用' | '可用' | '已发现' | '不可用' | '路径无效' | '未发现'
  color: 'success' | 'warning' | 'default'
}

/** One presentation rule for host-tool status across environment cards and details. */
export function hostToolPresentation(tool: EnvironmentHostTool): HostToolPresentation {
  if (tool.status === 'invalid') return { label: '路径无效', color: 'warning' }
  if (tool.selected && tool.status === 'ready') return { label: '已启用', color: 'success' }
  if (tool.status === 'ready') return { label: '可用', color: 'success' }
  if (tool.status === 'not-configured') return { label: '已发现', color: 'default' }
  if (tool.detectedPath) return { label: '不可用', color: 'warning' }
  return { label: '未发现', color: 'default' }
}

export function hostToolDisplayVersion(tool: EnvironmentHostTool): string | undefined {
  if (!tool.version) return undefined
  if (tool.id !== 'nextflow') return tool.version
  return /\b\d+(?:\.\d+){1,3}\b/u.exec(tool.version)?.[0]
}
