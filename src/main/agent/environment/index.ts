export {
  HOST_UNMANAGED,
  detectEnvironmentTools,
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

import { detectAnalysisKernels, listAnalysisKernels } from '../notebook/analysis-kernels'
import { getActiveToolPath } from './store'

/** Kernel diagnostics using the Jupyter binary from environment settings when set. */
export function detectConfiguredAnalysisKernels(): ReturnType<typeof detectAnalysisKernels> {
  // Managed kernels first (phi-python is the default); host kernels are listed as unmanaged.
  return listAnalysisKernels({ hostJupyterCommand: getActiveToolPath('jupyter') ?? 'jupyter' })
}
