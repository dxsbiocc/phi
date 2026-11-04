export function packageSelectionKey(entry: {
  type: string
  id: string
  pendingSubmissionId?: string
  submissionId?: string
}): string {
  const submissionId = entry.pendingSubmissionId ?? entry.submissionId
  return submissionId
    ? `submission:${submissionId}:${entry.type}:${entry.id}`
    : `${entry.type}:${entry.id}`
}
