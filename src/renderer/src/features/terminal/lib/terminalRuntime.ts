import * as XtermPackage from '@xterm/xterm'
import { FitAddon as XtermFitAddon } from '@xterm/addon-fit'

import { isMultilinePaste, terminalKeyAction } from './terminalInput'
import type {
  DisposableLike,
  FitAddonConstructor,
  TerminalConstructor,
  TerminalControllerDependencies,
  XtermTerminalLike
} from './terminalControllerTypes'

// xterm 6 ships a CommonJS main entry. Vite exposes named exports while Node's
// ESM loader places the same object under `default`, so support both shapes.
const XtermTerminal =
  XtermPackage.Terminal ??
  (Reflect.get(XtermPackage, 'default') as typeof XtermPackage | undefined)?.Terminal

function createHost(): HTMLElement {
  const host = document.createElement('div')
  host.className = 'phi-terminal-host'
  host.style.width = '100%'
  host.style.height = '100%'
  return host
}

export const defaultTerminalControllerDependencies: TerminalControllerDependencies = {
  Terminal: XtermTerminal as unknown as TerminalConstructor,
  FitAddon: XtermFitAddon as unknown as FitAddonConstructor,
  createHost,
  createRequestId: () => globalThis.crypto.randomUUID(),
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer)
}

export function bindTerminalInput(options: {
  terminal: XtermTerminalLike
  writeClipboard(text: string): Promise<void>
  onData(data: string): void
  onMultilinePaste(text: string): void
}): DisposableLike {
  options.terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const action = terminalKeyAction(event, options.terminal.hasSelection())
    switch (action) {
      case 'process':
      case 'paste':
        return true
      case 'copy': {
        const selection = options.terminal.getSelection()
        if (selection) void options.writeClipboard(selection).catch(() => undefined)
        event.preventDefault()
        return false
      }
      case 'clear':
        options.terminal.clear()
        event.preventDefault()
        return false
      case 'ignore':
        event.preventDefault()
        return false
    }
  })

  const dataDisposable = options.terminal.onData(options.onData)
  const textarea = options.terminal.textarea
  const pasteListener: EventListener = (rawEvent) => {
    const event = rawEvent as ClipboardEvent
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!isMultilinePaste(text)) return
    event.preventDefault()
    // xterm installs its own paste listener on this same textarea. Stopping
    // propagation alone still lets same-target listeners run and would send
    // the text before the user confirms the preview.
    event.stopImmediatePropagation()
    options.onMultilinePaste(text)
  }
  textarea?.addEventListener('paste', pasteListener, true)

  return {
    dispose: () => {
      textarea?.removeEventListener('paste', pasteListener, true)
      dataDisposable.dispose()
    }
  }
}
