export function rejectKernelAuthPrompt(
  requestId: string,
  diagnostic: (message: string) => void
): void {
  void import('../../main/agent/engine/in-process/state')
    .then(({ pendingAuthPrompts }) => {
      const pending = pendingAuthPrompts.get(requestId)
      if (!pending) return
      pendingAuthPrompts.delete(requestId)
      pending.reject(new Error('authentication prompt unavailable in kernel v1'))
    })
    .catch((error: unknown) => {
      diagnostic(`Failed to reject kernel authentication prompt: ${String(error)}`)
    })
}
