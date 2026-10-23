import type { BrowserWindow } from 'electron'

import type { PhiEngine } from '../engine/types'
import {
  createPlanReviewRequest,
  type PlanReviewRequestDeps
} from '../host-requests/plan-review-request'

type ReviewDeps<StoredEvent> = PlanReviewRequestDeps<StoredEvent>

export interface PlanReviewHostServiceDeps<StoredEvent> {
  host: PhiEngine['host']
  optionalStringField: ReviewDeps<StoredEvent>['fields']['optionalStringField']
  findActivePromptRunByRuntimeSessionId: ReviewDeps<StoredEvent>['runs']['findByRuntimeSessionId']
  getProject: ReviewDeps<StoredEvent>['projects']['getById']
  findPhiSessionById: ReviewDeps<StoredEvent>['sessions']['findById']
  phiOnlySessionPath: ReviewDeps<StoredEvent>['sessions']['sessionPath']
  getActiveWindow(): BrowserWindow | null
  canRequestAgentUserInteraction: ReviewDeps<StoredEvent>['renderer']['canRequest']
  waitForAgentUserInteraction: ReviewDeps<StoredEvent>['renderer']['waitForResponse']
  appendSessionEvent: ReviewDeps<StoredEvent>['timeline']['append']
  broadcastSessionTimelineEvent: ReviewDeps<StoredEvent>['timeline']['broadcast']
  createRunId: ReviewDeps<StoredEvent>['state']['createId']
  runnerRegistry: Pick<
    ReviewDeps<StoredEvent>['state'],
    'markNeedsInput' | 'markInputCancelled' | 'markInputAnswered'
  >
  notifySessionChanged: ReviewDeps<StoredEvent>['state']['notifySessionChanged']
  planRuns?: ReviewDeps<StoredEvent>['planRuns']
}

export function registerPlanReviewHostService<StoredEvent>(
  deps: PlanReviewHostServiceDeps<StoredEvent>
): () => void {
  const handler = createPlanReviewRequest({
    fields: { optionalStringField: deps.optionalStringField },
    runs: { findByRuntimeSessionId: deps.findActivePromptRunByRuntimeSessionId },
    projects: { getById: deps.getProject },
    sessions: {
      findById: deps.findPhiSessionById,
      sessionPath: deps.phiOnlySessionPath
    },
    renderer: {
      getActiveWindow: deps.getActiveWindow,
      canRequest: deps.canRequestAgentUserInteraction,
      waitForResponse: deps.waitForAgentUserInteraction
    },
    timeline: {
      append: deps.appendSessionEvent,
      broadcast: deps.broadcastSessionTimelineEvent
    },
    state: {
      createId: deps.createRunId,
      markNeedsInput: (sessionId, reviewId, state) =>
        deps.runnerRegistry.markNeedsInput(sessionId, reviewId, state),
      markInputCancelled: (sessionId, reviewId) =>
        deps.runnerRegistry.markInputCancelled(sessionId, reviewId),
      markInputAnswered: (sessionId, reviewId) =>
        deps.runnerRegistry.markInputAnswered(sessionId, reviewId),
      notifySessionChanged: deps.notifySessionChanged
    },
    ...(deps.planRuns ? { planRuns: deps.planRuns } : {})
  })
  return deps.host.register('planReview.request', handler)
}
