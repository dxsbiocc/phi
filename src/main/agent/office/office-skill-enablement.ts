import { readEnablementState, setEnabled, type EnablementOptions } from '../enablement'

export const PHI_OFFICE_SKILL_NAME = 'phi-office'
const PHI_OFFICE_SKILL_KEY = `skill:${PHI_OFFICE_SKILL_NAME}` as const

export function initializePhiOfficeSkillDefault(
  officeEnabled: boolean,
  options?: EnablementOptions
): void {
  if (!officeEnabled) return
  const state = readEnablementState(options)
  if (Object.hasOwn(state.global, PHI_OFFICE_SKILL_KEY)) return
  setEnabled(PHI_OFFICE_SKILL_KEY, true, options)
}

export function filterOfficeSkillForAvailability<T extends { readonly name: string }>(
  skills: readonly T[],
  officeEnabled: boolean
): T[] {
  return officeEnabled
    ? [...skills]
    : skills.filter((skill) => skill.name !== PHI_OFFICE_SKILL_NAME)
}
