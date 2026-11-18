interface ChatPromptRequest {
  requestId: string
  /** Returns the current draft key only if its content still belongs to this receipt. */
  finish(accepted: boolean): string | null
}

export interface ChatPromptRequests {
  begin(key: string): ChatPromptRequest | null
  edited(key: string): void
  move(from: string, to: string): void
}

export function createChatPromptRequests(
  createRequestId: () => string = () => crypto.randomUUID()
): ChatPromptRequests {
  const attempts = new Map<string, { key: string; id: string; pending: boolean }>()
  return {
    begin(key) {
      const attempt = attempts.get(key) ?? { key, id: createRequestId(), pending: false }
      if (attempt.pending) return null
      attempts.set(key, attempt)
      attempt.pending = true
      return {
        requestId: attempt.id,
        finish(accepted) {
          if (attempts.get(attempt.key) !== attempt) return null
          attempt.pending = false
          // After a lost receipt, sending this unchanged draft uses the same request ID.
          if (!accepted) return null
          attempts.delete(attempt.key)
          return attempt.key
        }
      }
    },
    edited(key) {
      attempts.delete(key)
    },
    move(from, to) {
      if (from === to) return
      const attempt = attempts.get(from)
      if (!attempt) return
      attempts.delete(from)
      if (attempts.has(to)) return
      attempt.key = to
      attempts.set(to, attempt)
    }
  }
}
