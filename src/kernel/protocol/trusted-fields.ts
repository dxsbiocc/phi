import type { KernelRequestFrame } from '../../shared/kernel-protocol'
import type { KernelBusinessMethod } from './types'

export function rejectsHostInternalFields(
  trusted: boolean,
  request: KernelRequestFrame,
  method: KernelBusinessMethod
): boolean {
  const prompt =
    method === 'session.prompt' ? (request.params as Record<string, unknown>) : undefined
  const hasInternalPromptFields = Boolean(
    prompt &&
    (prompt.modelSelection !== undefined ||
      prompt.synthetic !== undefined ||
      prompt.userInitiated !== undefined)
  )
  if (trusted && (method !== 'modelAccess.configure' || request.sessionId === undefined)) {
    return false
  }
  return hasInternalPromptFields || method === 'modelAccess.configure'
}
