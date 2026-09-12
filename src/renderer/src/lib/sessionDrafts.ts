export function sessionDraftKey(input: {
  phiSessionId?: string | null
  path: string | null
  cwd: string
  sessionGeneration: number
}): string {
  if (input.phiSessionId) return `phi:${input.phiSessionId}`
  return input.path ? `path:${input.path}` : `fresh:${input.cwd}:${input.sessionGeneration}`
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
