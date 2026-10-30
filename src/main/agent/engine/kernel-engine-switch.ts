/** Dependency-free so shared session modules can read the switch without loading the kernel engine. */
export type KernelEngineMode = 'off' | 'local' | 'remote' | 'both'

/** The kernel is the default; any other explicit value is the rollback to the old route (K5). */
export function parseKernelEngineSwitch(value: string | undefined): KernelEngineMode {
  if (value === undefined || value === '' || value === '1' || value === 'both') return 'both'
  if (value === 'local' || value === 'remote') return value
  return 'off'
}

/** The main process imports this module once; later renderer or settings input cannot change it. */
export const PHI_KERNEL_ENGINE_MODE = parseKernelEngineSwitch(process.env.PHI_KERNEL_ENGINE)

export function kernelEngineHandles(mode: KernelEngineMode, remote: boolean): boolean {
  return mode === 'both' || mode === (remote ? 'remote' : 'local')
}
