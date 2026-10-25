import type { WrapperWorkflow } from '../types'

/** Keep group identities bounded and separate from task parameters or shell input. */
export function parseWrapperWorkflow(value: unknown): WrapperWorkflow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ||
    !name ||
    name.length > 80 ||
    /[\r\n\0]/.test(name)
  )
    return undefined
  const step = typeof input.step === 'string' ? input.step.trim() : undefined
  if (input.step !== undefined && (!step || step.length > 80 || /[\r\n\0]/.test(step)))
    return undefined
  const totalSteps = input.totalSteps
  if (
    totalSteps !== undefined &&
    (!Number.isInteger(totalSteps) || Number(totalSteps) < 1 || Number(totalSteps) > 100)
  )
    return undefined
  return {
    id,
    name,
    ...(step ? { step } : {}),
    ...(totalSteps !== undefined ? { totalSteps: Number(totalSteps) } : {})
  }
}
