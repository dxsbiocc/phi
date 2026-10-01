export {
  HOST_UNMANAGED,
  detectEnvironmentHostTools,
  detectEnvironmentTools,
  detectHostDependencies,
  probeCustomToolPath,
  type ManagedToolState,
  type CommandRunner,
  type DetectEnvironmentOptions,
  type WhichResolver
} from './detect'
export {
  dismissEnvironmentSummary,
  getActiveToolPath,
  getCustomToolPath,
  getEnvironment,
  getEnvironmentPath,
  mergeDetectedWithCustoms,
  redetectEnvironment,
  readEnvironmentSnapshot,
  scanAndPersistEnvironment,
  setEnvironmentToolPath
} from './store'
export { listManagedEnvironments } from './managed'
export type {
  ListManagedEnvironmentsOptions,
  ManagedEnvironmentConsumerDeclaration
} from './managed'
export { createManagedEnvironmentActions } from './actions'
export type { ManagedEnvironmentActionDependencies, ManagedEnvironmentActions } from './actions'

import { detectAnalysisKernels, listAnalysisKernels } from '../notebook/analysis-kernels'
import { getActiveToolPath } from './store'

/** Kernel diagnostics using the Jupyter binary from environment settings when set. */
export function detectConfiguredAnalysisKernels(): ReturnType<typeof detectAnalysisKernels> {
  // Managed kernels first (phi-python is the default); host kernels are listed as unmanaged.
  return listAnalysisKernels({ hostJupyterCommand: getActiveToolPath('jupyter') ?? 'jupyter' })
}
