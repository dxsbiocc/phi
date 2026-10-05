import {
  officePromptTargetFailure,
  type OfficePromptTargetFailure,
  type OfficeTargetInput
} from '../../../shared/officeProtocol'
import type { OfficeRunTarget } from './office-targets'

interface OfficeTargetBindingService {
  bindPromptTarget(target: OfficeRunTarget, includeSelection: boolean): Promise<void>
}

type OfficeRunIdentity = Omit<OfficeRunTarget, 'artifactId' | 'selection'>

export async function bindOfficePromptTarget(
  target: OfficeTargetInput | null | undefined,
  identity: OfficeRunIdentity,
  service: OfficeTargetBindingService | null
): Promise<OfficePromptTargetFailure | null> {
  if (target === undefined) return null
  if (!target || !service) return officePromptTargetFailure('target_not_found')
  try {
    await service.bindPromptTarget(
      { ...identity, artifactId: target.artifactId },
      target.includeSelection === true
    )
    return null
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    if (
      code === 'target_session_mismatch' ||
      code === 'target_not_found' ||
      code === 'selection_unavailable' ||
      code === 'selection_too_large'
    ) {
      return officePromptTargetFailure(code)
    }
    throw error
  }
}

export async function prepareOfficePromptSubmission<T>(
  target: OfficeTargetInput | null | undefined,
  identity: OfficeRunIdentity,
  service: OfficeTargetBindingService | null,
  onAccepted: () => T
): Promise<{ ok: true; value: T } | OfficePromptTargetFailure> {
  const failure = await bindOfficePromptTarget(target, identity, service)
  return failure ?? { ok: true, value: onAccepted() }
}
