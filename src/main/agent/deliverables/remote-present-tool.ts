import type { PhiTool } from '../engine/types'
import { PHI_REMOTE_PRESENT_FILES_DESCRIPTION } from '../engine/phi-extension'

export { PHI_REMOTE_PRESENT_FILES_DESCRIPTION } from '../engine/phi-extension'

import { buildPresentFilesTool, type PresentFilesRequest } from './present-tool'

export function buildRemotePresentFilesTool(
  runtimeSessionId: string,
  deliver: (
    request: PresentFilesRequest
  ) => Promise<{ files: import('../../../shared/presentedFileTypes').PresentedFile[] }>
): PhiTool {
  return {
    ...buildPresentFilesTool(runtimeSessionId, deliver),
    description: PHI_REMOTE_PRESENT_FILES_DESCRIPTION
  }
}
