import type { EnablementItemKey } from '../../shared/enablementTypes'
import { isRecord } from '../../shared/guards'

export function isEnablementItemKey(value: unknown): value is EnablementItemKey {
  return (
    typeof value === 'string' &&
    (/^skill:[a-z0-9][a-z0-9-]{0,63}$/.test(value) ||
      /^(?:plugin|wrapper|mcp):[a-z][a-z0-9-]{1,63}$/.test(value))
  )
}

export function enablementScopeOptions(
  value: unknown,
  isRemoteResourceScope: (cwd?: string) => boolean
): { projectDir?: string } {
  if (!isRecord(value) || (value.type !== 'global' && value.type !== 'project')) {
    throw new Error('启用范围无效')
  }
  if (value.type === 'global') {
    if (Object.keys(value).some((key) => key !== 'type')) throw new Error('全局启用范围无效')
    return {}
  }
  if (
    Object.keys(value).some((key) => key !== 'type' && key !== 'projectCwd') ||
    typeof value.projectCwd !== 'string' ||
    value.projectCwd.trim().length === 0 ||
    isRemoteResourceScope(value.projectCwd)
  ) {
    throw new Error('项目启用范围无效')
  }
  return { projectDir: value.projectCwd }
}
