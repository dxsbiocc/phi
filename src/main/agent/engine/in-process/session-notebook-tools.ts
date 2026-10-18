import { buildNotebookCustomTools } from '../../notebook/notebook-tools'
import type { PhiTool } from '../types'
import type { HostRequestContext } from './common'

type HostRequester = (
  method: string,
  params: unknown,
  context?: HostRequestContext
) => Promise<unknown>

/**
 * Notebook tools for one in-process (worker) session. The main process verifies that a remote
 * notebook request comes from the runtime session it names (remoteRuntimeDispatchControl), so
 * the origin session id must travel with every request, not only inside the params.
 */
export function buildSessionNotebookTools(
  requestHost: HostRequester,
  sessionId: string,
  remoteProjectIdentity?: { sessionId: string; projectId: string }
): PhiTool[] {
  return buildNotebookCustomTools(
    async (request) => requestHost('notebookTool.execute', request, { originSessionId: sessionId }),
    remoteProjectIdentity
      ? {
          remoteProject: {
            runtimeSessionId: sessionId,
            sessionId: remoteProjectIdentity.sessionId,
            projectId: remoteProjectIdentity.projectId
          }
        }
      : {}
  )
}
