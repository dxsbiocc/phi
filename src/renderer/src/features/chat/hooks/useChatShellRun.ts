import { useCallback, useRef, useState } from 'react'
import type {
  BackgroundShellJob,
  StartChatShellJobRequest
} from '../../../../../shared/backgroundJobTypes'
import { chatCodeCopy } from '../lib/chatCodeCopy'

type ShellRunTarget = StartChatShellJobRequest & { cwd: string }

export function useChatShellRun({
  start,
  requestOverlay,
  onError
}: {
  start: (input: StartChatShellJobRequest) => Promise<BackgroundShellJob>
  requestOverlay: (key: string, publish: () => void) => void
  onError: (error: unknown, fallback: string) => void
}): {
  pending: ShellRunTarget | null
  request: (target: ShellRunTarget) => void
  dismiss: () => void
  confirm: () => void
} {
  const [pending, setPending] = useState<ShellRunTarget | null>(null)
  const pendingRef = useRef<ShellRunTarget | null>(null)
  const request = useCallback(
    (target: ShellRunTarget): void => {
      requestOverlay('chat-shell-run', () => {
        pendingRef.current = target
        setPending(target)
      })
    },
    [requestOverlay]
  )
  const dismiss = useCallback((): void => {
    pendingRef.current = null
    setPending(null)
  }, [])
  const confirm = useCallback((): void => {
    const target = pendingRef.current
    if (!target) return
    dismiss()
    void start({ sessionId: target.sessionId, command: target.command }).catch((error) => {
      onError(error, chatCodeCopy.startFailed)
    })
  }, [dismiss, onError, start])

  return { pending, request, dismiss, confirm }
}
