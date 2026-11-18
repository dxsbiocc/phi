export function sessionDraftKey(input: {
  phiSessionId?: string | null
  draftId?: string | null
  path: string | null
  cwd: string
  sessionGeneration: number
}): string {
  if (input.phiSessionId) return `phi:${input.phiSessionId}`
  if (input.path) return `path:${input.path}`
  return input.draftId ? `draft:${input.draftId}` : `fresh:${input.cwd}:${input.sessionGeneration}`
}

export function updateSessionDraft(
  drafts: Record<string, string>,
  key: string,
  value: string
): Record<string, string> {
  if (!value) {
    const rest = { ...drafts }
    delete rest[key]
    return rest
  }
  return { ...drafts, [key]: value }
}

export function moveSessionDraft<T>(
  drafts: Record<string, T>,
  from: string,
  to: string
): Record<string, T> {
  if (from === to || drafts[from] === undefined || drafts[to] !== undefined) return drafts
  const next = { ...drafts, [to]: drafts[from] }
  delete next[from]
  return next
}
