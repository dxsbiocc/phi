export const planEnglish = {
  sessionModeMenuLabel: 'Work mode',
  chooseSessionMode: (label: string) => `Choose work mode: ${label}`,
  sessionModeAuto: 'Auto',
  sessionModeAutoDescription: 'Let the agent decide whether to act directly or plan first.',
  sessionModeAsk: 'Ask',
  sessionModeAskDescription: 'Ask for your approval before running commands or changing files.',
  sessionModePlan: 'Plan',
  sessionModePlanDescription: 'Research read-only and submit a plan for approval before acting.',
  sessionModePlanExecute: 'Plan and execute',
  sessionModePlanExecuteDescription:
    'Plan independent steps for approval, then schedule their execution.',
  sessionModeFull: 'Full access',
  sessionModeFullDescription: 'Act directly without approval. Use with caution.',
  agentSelectedPlan: (execute: boolean, reason: string) =>
    `Agent selected: ${execute ? 'Plan and execute' : 'Plan'} — ${reason}`,
  goal: 'Goal',
  progress: (completed: number, total: number) => `${completed}/${total} completed`,
  runStatus: (status: 'running' | 'paused' | 'completed' | 'stopped') =>
    ({ running: 'Running', paused: 'Paused', completed: 'Completed', stopped: 'Stopped' })[status],
  stepStatus: (
    status:
      | 'pending'
      | 'launching'
      | 'running'
      | 'unknown'
      | 'done'
      | 'failed'
      | 'skipped'
      | 'cancelled'
      | 'interrupted'
  ) =>
    ({
      pending: 'Pending',
      launching: 'Launching agent',
      running: 'Running',
      unknown: 'Launch unconfirmed',
      done: 'Done',
      failed: 'Failed',
      skipped: 'Skipped',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted'
    })[status],
  unknownStepExplanation:
    'The agent may still be running. Retry, skip, replan, and stop are unavailable until its launch is safely resolved.',
  missingInputs: (inputs: string) => `Needs: ${inputs}`,
  listSeparator: ', ',
  accessRead: 'Read',
  accessWrite: 'Write',
  attempts: (count: number) => `${count} attempts`,
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  retry: 'Retry',
  skip: 'Skip',
  replanRemaining: 'Replan remaining steps',
  replanSendFailed: 'Could not send the replan request. Try again from this session.',
  replanCancelFailed:
    'The pending replan request could not be cleared. If it already appears in chat, continue there; otherwise retry cancellation before replanning.',
  retryCancellation: 'Retry cancellation',
  confirmStopTitle: 'Stop this plan?',
  confirmStopBody: 'Stopping the entire plan cannot be undone.',
  confirmSkipTitle: 'Skip this step?',
  confirmSkipBody:
    'Skipping this step cannot be undone. Dependent steps may continue without its result.',
  confirmRetryTitle: 'Retry this write step?',
  confirmRetryBody:
    'This step may have changed files already. Review the workspace before running it again.',
  confirm: 'Confirm',
  cancel: 'Cancel',
  report: 'Report',
  error: 'Error',
  loading: 'Loading…',
  loadFailed: 'Unable to load plan details.',
  planRunCompleted: (goal: string) => `Plan completed: ${goal}`,
  planRunStopped: (goal: string) => `Plan stopped: ${goal}`,
  expandStep: (title: string) => `Expand step ${title}`,
  collapseStep: (title: string) => `Collapse step ${title}`,
  collapseSummary: 'Collapse plan summary',
  expandSummary: 'Expand plan summary',
  awaitingReview: 'Awaiting review',
  approvedToExecute: 'Approved to execute',
  changesRequested: 'Changes requested',
  cancelled: 'Cancelled',
  planReviewHistory: 'Plan review history',
  viewPlanDetails: 'View plan details',
  plan: 'Plan ·',
  revisionNotes: 'Revision notes:',
  planAwaitingReview: 'Plan awaiting review',
  planAwaitingReviewTitle: 'Plan awaiting review ·',
  revisionPlaceholder: 'Enter revision notes if changes are needed',
  planRevisionNotes: 'Plan revision notes',
  revisePlan: 'Revise',
  approveAndStartExecution: 'Approve',
  read: 'Read',
  write: 'Write',
  dependencies: (stepNumbers: string) => `Depends on step ${stepNumbers}`,
  agent: (name: string) => `Agent: ${name}`,
  stepDetails: 'Instructions and acceptance criteria',
  expandStepDetails: (title: string) => `Expand instructions and acceptance criteria for ${title}`,
  instructions: 'Instructions',
  acceptanceCriteria: 'Acceptance criteria'
}
