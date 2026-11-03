import type {
  AgentUserInteractionResponse,
  MissingToolChoice,
  MissingToolId,
  MissingToolPrompt
} from '../../../../../shared/agentInteractionTypes'

export type {
  MissingToolCandidateSource,
  MissingToolId
} from '../../../../../shared/agentInteractionTypes'

export type MissingToolPromptRequest = MissingToolPrompt & { requestId: string }

export type MissingToolPromptChoice =
  | { kind: 'candidate'; path: string }
  | { kind: 'path'; path: string }
  | { kind: 'install' }
  | { kind: 'cancel' }

export type MissingToolPromptDraft = {
  requestId: string
  candidatePath: string | null
  path: string
  reviewingInstall: boolean
}

export type MissingToolPromptDraftAction =
  | { type: 'select-candidate'; path: string }
  | { type: 'enter-path'; path: string }
  | { type: 'review-install' }
  | { type: 'close-install' }

export function createMissingToolPromptDraft(requestId: string): MissingToolPromptDraft {
  return { requestId, candidatePath: null, path: '', reviewingInstall: false }
}

export function reduceMissingToolPromptDraft(
  draft: MissingToolPromptDraft,
  action: MissingToolPromptDraftAction
): MissingToolPromptDraft {
  switch (action.type) {
    case 'select-candidate':
      return { ...draft, candidatePath: action.path, reviewingInstall: false }
    case 'enter-path':
      return { ...draft, path: action.path, reviewingInstall: false }
    case 'review-install':
      return { ...draft, reviewingInstall: true }
    case 'close-install':
      return { ...draft, reviewingInstall: false }
  }
}

export function missingToolPromptDraftForRequest(
  requestId: string,
  savedDraft: MissingToolPromptDraft | null
): MissingToolPromptDraft {
  return savedDraft?.requestId === requestId ? savedDraft : createMissingToolPromptDraft(requestId)
}

export function missingToolPromptResponse(
  requestId: string,
  toolId: MissingToolId,
  choice: MissingToolPromptChoice
): AgentUserInteractionResponse {
  const missingToolChoice: MissingToolChoice =
    choice.kind === 'candidate'
      ? { action: 'candidate', path: choice.path }
      : choice.kind === 'path'
        ? { action: 'path', path: choice.path }
        : choice.kind === 'install'
          ? { action: 'install' }
          : { action: 'cancel' }
  if (choice.kind === 'cancel') {
    return { requestId, answers: [], cancelled: true, missingToolChoice }
  }
  return {
    requestId,
    missingToolChoice,
    answers: [
      {
        questionIndex: 0,
        question: `missing_tool:${toolId}`,
        kind: choice.kind === 'path' ? 'custom' : 'option',
        answer: choice.kind === 'install' ? 'install' : choice.path
      }
    ]
  }
}
