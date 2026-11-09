import type { ConfirmationOptions } from '../../../lib/confirmationController'
import { terminalUi } from './terminalUi'

export type TerminalEndIntent = { kind: 'terminal'; terminalId: string } | { kind: 'all' }

export function terminalEndConfirmationOptions(
  intent: TerminalEndIntent,
  terminalCount: number
): ConfirmationOptions {
  if (intent.kind === 'terminal') {
    return {
      title: terminalUi.closeTerminal,
      description: terminalUi.closingThisTerminalWillTerminateItsRunningPrograms,
      confirmLabel: terminalUi.endTerminal,
      destructive: true
    }
  }
  return {
    title: terminalUi.closeAllTerminals,
    description: terminalUi.closeAllValueTerminalsInThisWorkspaceRunning(terminalCount),
    confirmLabel: terminalUi.endAllTerminals,
    destructive: true
  }
}

/** Runs a title-bar end action only after the shared confirmation resolves true. */
export async function runTerminalEndAction({
  intent,
  terminalCount,
  confirm,
  onEnd,
  onEndAll
}: {
  intent: TerminalEndIntent
  terminalCount: number
  confirm(options: ConfirmationOptions): Promise<boolean>
  onEnd(terminalId: string): void
  onEndAll(): void
}): Promise<boolean> {
  if (intent.kind === 'all' && terminalCount === 0) return false
  const confirmed = await confirm(terminalEndConfirmationOptions(intent, terminalCount))
  if (!confirmed) return false
  if (intent.kind === 'terminal') onEnd(intent.terminalId)
  else onEndAll()
  return true
}
