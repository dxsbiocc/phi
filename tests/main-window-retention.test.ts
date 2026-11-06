import assert from 'node:assert/strict'
import test from 'node:test'
import { createMainWindowRetention, type RetainableWindow } from '../src/main/main-window-retention'

interface FakeWindow extends RetainableWindow {
  readonly calls: string[]
  state: {
    visible: boolean
    minimized: boolean
    fullscreen: boolean
    destroyed: boolean
    crashed: boolean
  }
  leaveFullScreen(): void
}

function fakeWindow(initial: Partial<FakeWindow['state']> = {}): FakeWindow {
  const state = {
    visible: true,
    minimized: false,
    fullscreen: false,
    destroyed: false,
    crashed: false,
    ...initial
  }
  const calls: string[] = []
  let onLeave: (() => void) | null = null
  return {
    calls,
    state,
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFullScreen: () => state.fullscreen,
    setFullScreen: (flag) => calls.push(`setFullScreen:${flag}`),
    once: (_event, listener) => {
      onLeave = listener
    },
    hide: () => {
      calls.push('hide')
      state.visible = false
    },
    show: () => {
      calls.push('show')
      state.visible = true
    },
    restore: () => {
      calls.push('restore')
      state.minimized = false
    },
    focus: () => calls.push('focus'),
    close: () => calls.push('close'),
    webContents: {
      isCrashed: () => state.crashed,
      reload: () => {
        calls.push('reload')
        state.crashed = false
      }
    },
    leaveFullScreen: () => {
      state.fullscreen = false
      onLeave?.()
    }
  }
}

function closeEvent(): { prevented: boolean; preventDefault(): void } {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
}

test('closing the main window on macOS hides it instead of destroying the renderer', () => {
  const retention = createMainWindowRetention('darwin')
  const window = fakeWindow()
  const event = closeEvent()

  assert.equal(retention.handleClose(window, event), 'hidden')
  assert.equal(event.prevented, true)
  assert.deepEqual(window.calls, ['hide'])
})

test('reopening reveals the same retained window', () => {
  const retention = createMainWindowRetention('darwin')
  const window = fakeWindow()
  retention.handleClose(window, closeEvent())

  assert.equal(retention.reveal(window), true)
  assert.deepEqual(window.calls, ['hide', 'show', 'focus'])
  assert.equal(window.state.visible, true)
})

test('reveal restores a minimized window and reports a missing one', () => {
  const retention = createMainWindowRetention('darwin')
  const minimized = fakeWindow({ minimized: true })
  assert.equal(retention.reveal(minimized), true)
  assert.deepEqual(minimized.calls, ['restore', 'focus'])

  assert.equal(retention.reveal(null), false)
  assert.equal(retention.reveal(fakeWindow({ destroyed: true })), false)
})

test('a fullscreen window leaves fullscreen before it hides', () => {
  const retention = createMainWindowRetention('darwin')
  const window = fakeWindow({ fullscreen: true })

  assert.equal(retention.handleClose(window, closeEvent()), 'hidden')
  assert.deepEqual(window.calls, ['setFullScreen:false'])
  window.leaveFullScreen()
  assert.deepEqual(window.calls, ['setFullScreen:false', 'hide'])
})

test('quitting closes the window for real', () => {
  const retention = createMainWindowRetention('darwin')
  const window = fakeWindow()
  const event = closeEvent()
  retention.markQuitting()

  assert.equal(retention.isQuitting(), true)
  assert.equal(retention.handleClose(window, event), 'closing')
  assert.equal(event.prevented, false)
  assert.deepEqual(window.calls, [])
})

test('other platforms keep closing the window', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const retention = createMainWindowRetention(platform)
    const event = closeEvent()
    assert.equal(retention.handleClose(fakeWindow(), event), 'closing')
    assert.equal(event.prevented, false)
  }
})

test('closeForReal releases a window that must not be retained', () => {
  const retention = createMainWindowRetention('darwin')
  const window = fakeWindow()

  retention.closeForReal(window)
  assert.deepEqual(window.calls, ['close'])
  const event = closeEvent()
  assert.equal(retention.handleClose(window, event), 'closing')
  assert.equal(event.prevented, false)

  const destroyed = fakeWindow({ destroyed: true })
  retention.closeForReal(destroyed)
  assert.deepEqual(destroyed.calls, [])
})

test('reveal reloads a renderer that died while the window was hidden', () => {
  const retention = createMainWindowRetention('darwin')
  const window = fakeWindow({ visible: false, crashed: true })

  assert.equal(retention.reveal(window), true)
  assert.deepEqual(window.calls, ['reload', 'show', 'focus'])
})

test('hide from the menu bar only hides a visible live window', () => {
  const retention = createMainWindowRetention('darwin')
  const visible = fakeWindow()
  retention.hide(visible)
  assert.deepEqual(visible.calls, ['hide'])

  const hidden = fakeWindow({ visible: false })
  retention.hide(hidden)
  retention.hide(null)
  retention.hide(fakeWindow({ destroyed: true }))
  assert.deepEqual(hidden.calls, [])
})
