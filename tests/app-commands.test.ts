import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  applyShortcut,
  type AppCommandDeps
} from '../src/renderer/src/lib/app-shell/useAppCommands'

type ShortcutContext = Pick<
  AppCommandDeps,
  | 'activeView'
  | 'isSettingsOpen'
  | 'isProviderDialogOpen'
  | 'isNewProjectDialogOpen'
  | 'closeProviderDialog'
  | 'setIsSettingsOpen'
  | 'setIsNewProjectDialogOpen'
  | 'navigateToView'
  | 'onNewChat'
>

function harness(overrides: Partial<ShortcutContext> = {}): {
  context: ShortcutContext
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    context: {
      activeView: 'chat',
      isSettingsOpen: false,
      isProviderDialogOpen: false,
      isNewProjectDialogOpen: false,
      closeProviderDialog: () => calls.push('closeProvider'),
      setIsSettingsOpen: (open) => calls.push(`settings:${open}`),
      setIsNewProjectDialogOpen: (open) => calls.push(`newProject:${open}`),
      navigateToView: (view) => calls.push(`view:${view}`),
      onNewChat: () => {
        calls.push('newChat')
      },
      ...overrides
    }
  }
}

function keydown(init: KeyboardEventInit & { key: string }): {
  event: KeyboardEvent
  prevented: () => boolean
} {
  let prevented = false
  const event = {
    ...init,
    preventDefault: () => {
      prevented = true
    }
  } as KeyboardEvent
  return { event, prevented: () => prevented }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
})

test('new chat navigates first and dispatches the new chat', () => {
  const { context, calls } = harness()
  const shortcut = keydown({ key: 'n', metaKey: true })
  applyShortcut(shortcut.event, context)
  assert.equal(shortcut.prevented(), true)
  assert.deepEqual(calls, ['view:chat', 'newChat'])
})

test('close dialogs only acts when a dialog is actually open', () => {
  const closed = harness()
  const ignored = keydown({ key: 'Escape' })
  applyShortcut(ignored.event, closed.context)
  assert.equal(ignored.prevented(), false)
  assert.deepEqual(closed.calls, [])

  for (const open of [
    { isSettingsOpen: true },
    { isProviderDialogOpen: true },
    { isNewProjectDialogOpen: true }
  ]) {
    const { context, calls } = harness(open)
    const event = keydown({ key: 'Escape' })
    applyShortcut(event.event, context)
    assert.equal(event.prevented(), true)
    assert.deepEqual(calls, ['settings:false', 'closeProvider', 'newProject:false'])
  }
})

test('focus selects the composer in chat and a text field elsewhere', () => {
  const focused: string[] = []
  const selectors: string[] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (selector: string) => {
        selectors.push(selector)
        return { focus: (options: unknown) => focused.push(JSON.stringify(options)) }
      }
    }
  })

  const chat = harness()
  applyShortcut(keydown({ key: 'k', ctrlKey: true }).event, chat.context)
  const settings = harness({ activeView: 'settings' })
  applyShortcut(keydown({ key: 'k', ctrlKey: true }).event, settings.context)

  assert.deepEqual(selectors, ['[data-phi-focus="chat-input"]', 'input[type="text"]'])
  assert.deepEqual(focused, ['{"preventScroll":true}', '{"preventScroll":true}'])
})

test('modified or composing shortcuts are ignored', () => {
  const { context, calls } = harness()
  for (const init of [
    { key: 'n', metaKey: true, shiftKey: true },
    { key: 'n', metaKey: true, isComposing: true },
    { key: 'p', metaKey: true }
  ]) {
    const event = keydown(init as KeyboardEventInit & { key: string })
    applyShortcut(event.event, context)
    assert.equal(event.prevented(), false)
  }
  assert.deepEqual(calls, [])
})
