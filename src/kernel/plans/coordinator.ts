import type { PlanRunReplanRequest, PlanRunState, PlanSpec } from '../../shared/planRunTypes'
import { KERNEL_EVENT_PLAN_RUN_UPDATED, type JsonValue } from '../../shared/kernel-protocol'
import type { KernelPlanRuntime } from '../../main/agent/engine/in-process/kernel-services'
import {
  createPlanRunService,
  type PlanRunService,
  type PlanRunServiceStore
} from '../../main/agent/plan/plan-run-service'
import {
  listPlanRuns,
  listUnfinishedPlanRuns,
  readPlanRun,
  writePlanRun
} from '../../main/agent/plan/persistence/plan-run-store'
import { readMigration } from '../sessions/migration'
import { kernelSessionMigrationPaths } from '../sessions/paths'
import type { KernelProtocolCore } from '../protocol'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

export class KernelPlanCoordinator implements KernelPlanRuntime {
  private readonly loaded = new Set<string>()
  private readonly service: PlanRunService
  private core?: KernelProtocolCore

  constructor(
    private readonly agentDir: string,
    private readonly callWorker: WorkerCall,
    private readonly diagnostic: (message: string) => void,
    /** True when the agent-run journal proves a launch request has no live child. */
    private readonly launchSettled: (sessionId: string, requestId: string) => boolean = () => false
  ) {
    const store: PlanRunServiceStore = {
      write: (state) => writePlanRun(state, this.agentDir),
      read: (sessionId, runId) => readPlanRun(sessionId, runId, this.agentDir),
      list: (sessionId) => listPlanRuns(sessionId, this.agentDir),
      listUnfinished: (sessionId) => listUnfinishedPlanRuns(sessionId, this.agentDir)
    }
    this.service = createPlanRunService({
      engine: {
        agentRuns: {
          start: (params) =>
            this.callWorker('agentRun.start', params) as Promise<{ runId: string }>,
          stop: (params) => this.callWorker('agentRun.stop', params)
        }
      },
      resolveRuntimeSessionId: (sessionId) => (this.loaded.has(sessionId) ? sessionId : null),
      requiresDurableLaunch: () => true,
      enterReplanMode: (sessionId, replanRequestId) =>
        this.callWorker('session.plan.enter', {
          sessionId,
          execute: true,
          replanRequestId
        }),
      exitReplanMode: async (sessionId, replanRequestId) =>
        (await this.callWorker('session.plan.cancel', { sessionId, replanRequestId })) === true,
      timeline: {
        append: (_sessionId, event) => event,
        broadcast: (sessionId, event, finishedState) => {
          if (event.type !== 'plan_run_updated' && event.type !== 'plan_run_finished') return
          this.core?.emitEvent(
            KERNEL_EVENT_PLAN_RUN_UPDATED,
            {
              event: event.type,
              state: event.state as unknown as JsonValue,
              // The terminal event also carries the full run so the desktop can build the
              // continuation prompt from the step reports; the renderer keeps the snapshot.
              ...(event.type === 'plan_run_finished' && finishedState
                ? // Stored run state can hold undefined optionals the frame encoder rejects.
                  { fullState: JSON.parse(JSON.stringify(finishedState)) as JsonValue }
                : {})
            },
            { sessionId }
          )
        }
      },
      // The desktop host starts the automatic continuation after it persists the finish
      // event, so that follow-up turn goes through the normal prompt-run persistence path.
      continueConversation: () => undefined,
      logError: (error, metadata) => {
        this.diagnostic(`Plan ${metadata.runId} ${metadata.source} failed: ${String(error)}`)
      },
      store
    })
  }

  bind(core: KernelProtocolCore): void {
    this.core = core
  }

  async openSession(sessionId: string): Promise<void> {
    await this.importAdoptedRuns(sessionId)
    this.loaded.add(sessionId)
    await this.service.recoverSession(sessionId)
    // Agent-run receipts open first and settle every request the previous kernel left
    // open, so an unknown plan launch whose request is settled cannot still be running.
    await this.service.releaseSettledLaunches(sessionId, (requestId) =>
      this.launchSettled(sessionId, requestId)
    )
  }

  closeSession(sessionId: string): void {
    this.loaded.delete(sessionId)
  }

  async suspendSession(sessionId: string): Promise<void> {
    await this.service.suspendSession(sessionId)
  }

  async interruptRunningSteps(sessionId: string): Promise<void> {
    await this.service.interruptRunningSteps(sessionId)
  }

  private async importAdoptedRuns(sessionId: string): Promise<void> {
    const migration = await readMigration(
      kernelSessionMigrationPaths(this.agentDir, sessionId).migration
    ).catch(() => undefined)
    const sourceSessionId = migration?.source.phiSessionId
    if (!sourceSessionId || sourceSessionId === sessionId) return
    for (const legacy of listPlanRuns(sourceSessionId, this.agentDir)) {
      if (readPlanRun(sessionId, legacy.id, this.agentDir)) continue
      writePlanRun({ ...structuredClone(legacy), sessionId }, this.agentDir)
    }
  }

  approved(sessionId: string, spec: PlanSpec, replanRequestId?: string): Promise<PlanRunState> {
    return replanRequestId
      ? this.service.applyApprovedReplan(sessionId, sessionId, replanRequestId, spec)
      : this.service.startFromApprovedPlan(sessionId, spec, {
          expectedRuntimeSessionId: sessionId,
          assertCurrent: () => {
            if (!this.loaded.has(sessionId)) throw new Error('Plan review is no longer active.')
          }
        })
  }

  cancelled(sessionId: string, replanRequestId?: string): void {
    if (replanRequestId) this.service.cancelReplan(sessionId, replanRequestId)
  }

  list(sessionId: string): Promise<PlanRunState[]> {
    return this.service.list(sessionId)
  }

  hasActiveWork(sessionId: string): boolean {
    return this.service.hasActiveWork(sessionId)
  }

  get(sessionId: string, runId: string): Promise<PlanRunState | null> {
    return this.service.get(sessionId, runId)
  }

  retryStep(sessionId: string, runId: string, stepId: string): Promise<PlanRunState> {
    return this.service.retryStep(sessionId, runId, stepId)
  }

  skipStep(sessionId: string, runId: string, stepId: string): Promise<PlanRunState> {
    return this.service.skipStep(sessionId, runId, stepId)
  }

  replan(sessionId: string, runId: string): Promise<PlanRunReplanRequest> {
    return this.service.requestReplan(sessionId, runId)
  }

  stop(sessionId: string, runId: string): Promise<PlanRunState> {
    return this.service.stop(sessionId, runId)
  }
}
