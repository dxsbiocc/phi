import type { KernelRuntimeRef } from '../session/runtime-reference'

export type PlanExecutionOwner = 'desktop' | 'kernel'

export function planExecutionOwner(
  manifest: { kernelRuntimeRef?: KernelRuntimeRef } | null | undefined
): PlanExecutionOwner {
  return manifest?.kernelRuntimeRef ? 'kernel' : 'desktop'
}
