import type { IpcRenderer } from 'electron'

import { IPC } from '../shared/ipcChannels'
import type {
  PlanRunIdInput,
  PlanRunRendererApi,
  PlanRunSessionInput,
  PlanRunStepInput
} from '../shared/planRunTypes'

export function createPlanRunApi(ipcRenderer: Pick<IpcRenderer, 'invoke'>): PlanRunRendererApi {
  const sessionInput = (phiSessionId: string): PlanRunSessionInput => ({ phiSessionId })
  const runInput = (phiSessionId: string, runId: string): PlanRunIdInput => ({
    phiSessionId,
    runId
  })
  const stepInput = (phiSessionId: string, runId: string, stepId: string): PlanRunStepInput => ({
    phiSessionId,
    runId,
    stepId
  })

  return {
    listPlanRuns: (phiSessionId) =>
      ipcRenderer.invoke(IPC.planRuns.list, sessionInput(phiSessionId)),
    getPlanRun: (phiSessionId, runId) =>
      ipcRenderer.invoke(IPC.planRuns.get, runInput(phiSessionId, runId)),
    pausePlanRun: (phiSessionId, runId) =>
      ipcRenderer.invoke(IPC.planRuns.pause, runInput(phiSessionId, runId)),
    resumePlanRun: (phiSessionId, runId) =>
      ipcRenderer.invoke(IPC.planRuns.resume, runInput(phiSessionId, runId)),
    stopPlanRun: (phiSessionId, runId) =>
      ipcRenderer.invoke(IPC.planRuns.stop, runInput(phiSessionId, runId)),
    retryPlanRunStep: (phiSessionId, runId, stepId) =>
      ipcRenderer.invoke(IPC.planRuns.retryStep, stepInput(phiSessionId, runId, stepId)),
    skipPlanRunStep: (phiSessionId, runId, stepId) =>
      ipcRenderer.invoke(IPC.planRuns.skipStep, stepInput(phiSessionId, runId, stepId))
  }
}
