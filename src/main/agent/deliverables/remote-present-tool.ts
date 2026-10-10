import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { buildPresentFilesTool, type PresentFilesRequest } from './present-tool'

export const PHI_REMOTE_PRESENT_FILES_DESCRIPTION =
  'Declare existing result files from the current SSH project as final deliverables. Paths are validated on the server and returned as remote preview links; Phi never resolves them against the local session anchor.'

export function buildRemotePresentFilesTool(
  runtimeSessionId: string,
  deliver: (
    request: PresentFilesRequest
  ) => Promise<{ files: import('../../../shared/presentedFileTypes').PresentedFile[] }>
): CustomTool {
  return {
    ...buildPresentFilesTool(runtimeSessionId, deliver),
    description: PHI_REMOTE_PRESENT_FILES_DESCRIPTION
  }
}
