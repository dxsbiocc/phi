import { sanitizeOfficeTargetInput, type OfficeTargetInput } from '../shared/officeProtocol'

export function sanitizePromptTargetForIpc<T extends object>(
  target: T | undefined
): (T & { officeTarget?: OfficeTargetInput }) | undefined {
  if (!target) return undefined
  const value = (target as { officeTarget?: unknown }).officeTarget
  if (value === undefined) return target
  const officeTarget = sanitizeOfficeTargetInput(value)
  if (!officeTarget) throw new Error('关联的 Office 文档目标无效')
  return { ...target, officeTarget }
}
