import type {
  OfficeSelectionSummary,
  OfficeTargetInput
} from '../../../../../shared/officeProtocol'

export interface OfficeComposerTarget {
  artifactId: string
  label: string
  humanEdit?: 'cells' | 'none'
  selection?: OfficeSelectionSummary
}

export function visibleOfficeComposerTarget(
  readyTarget: OfficeComposerTarget | null,
  dismissedArtifactId: string | null
): OfficeComposerTarget | null {
  return readyTarget?.artifactId === dismissedArtifactId ? null : readyTarget
}

export function captureOfficeTarget(
  target: OfficeComposerTarget | null | undefined
): OfficeTargetInput | undefined {
  return target
    ? {
        artifactId: target.artifactId,
        ...(target.humanEdit !== 'none' && target.selection ? { includeSelection: true } : {})
      }
    : undefined
}

export function withCapturedOfficeTarget<T extends object>(
  prompt: T,
  target: OfficeComposerTarget | null | undefined,
  enabled: boolean
): T & { officeTarget?: OfficeTargetInput } {
  if (!enabled) return prompt
  const officeTarget = captureOfficeTarget(target)
  return officeTarget ? { ...prompt, officeTarget } : prompt
}

export function retargetCapturedOfficePrompt<
  T extends { officeTarget?: OfficeTargetInput },
  U extends object
>(prompt: T, identity: U): T & U {
  return { ...prompt, ...identity }
}
