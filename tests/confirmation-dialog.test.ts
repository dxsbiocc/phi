import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { createConfirmationController } from '../src/renderer/src/lib/confirmationController'
import { runTerminalEndAction } from '../src/renderer/src/features/terminal/lib/terminalEndAction'
import { terminalUi } from '../src/renderer/src/features/terminal/lib/terminalUi'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// The Node test runner has no DOM. These tests drive the same controller that
// useConfirmation binds with useSyncExternalStore; the prompt maps cancel/close
// to settle(false) and confirm to settle(true).
function installNativeConfirmTrap(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      confirm: () => {
        throw new Error('Native window.confirm must not be used')
      }
    }
  })
  return () => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('useConfirmation resolves true after the user confirms', async () => {
  const controller = createConfirmationController()
  const answer = controller.request({ title: 'Remove package', confirmLabel: 'Remove' })

  assert.equal(controller.getSnapshot()?.options.title, 'Remove package')
  controller.settle(true)

  assert.equal(await answer, true)
  assert.equal(controller.getSnapshot(), null)
})

test('useConfirmation resolves false when the user cancels or closes the dialog', async () => {
  const controller = createConfirmationController()

  const canceled = controller.request({ title: 'Canceled', confirmLabel: 'Remove' })
  controller.settle(false)
  assert.equal(await canceled, false)

  const closed = controller.request({ title: 'Closed', confirmLabel: 'Remove' })
  controller.settle(false)
  assert.equal(await closed, false)

  assert.equal(controller.getSnapshot(), null)
})

test('terminal title bar confirms a single terminal end in the application dialog', async () => {
  setUiLanguage('zh-CN')
  const restoreWindow = installNativeConfirmTrap()
  try {
    const controller = createConfirmationController()
    const ended: string[] = []
    let endedAll = 0
    const pending = runTerminalEndAction({
      intent: { kind: 'terminal', terminalId: 'terminal-1' },
      terminalCount: 1,
      confirm: controller.request,
      onEnd: (terminalId) => ended.push(terminalId),
      onEndAll: () => {
        endedAll += 1
      }
    })

    const prompt = controller.getSnapshot()
    assert.ok(prompt, 'ending a terminal must open the application confirmation')
    assert.equal(prompt.options.title, '结束终端')
    assert.equal(prompt.options.confirmLabel, '结束终端')
    assert.equal(prompt.options.destructive, true)
    assert.equal(
      prompt.options.description,
      terminalUi.closingThisTerminalWillTerminateItsRunningPrograms
    )
    assert.deepEqual(ended, [], 'the terminal must stay open until the user confirms')

    controller.settle(false)
    assert.equal(await pending, false)
    assert.deepEqual(ended, [])
    assert.equal(endedAll, 0)
  } finally {
    restoreWindow()
    setUiLanguage('en')
  }
})

test('terminal title bar confirms ending all terminals before calling onEndAll', async () => {
  setUiLanguage('zh-CN')
  const restoreWindow = installNativeConfirmTrap()
  try {
    const controller = createConfirmationController()
    const ended: string[] = []
    let endedAll = 0
    const pending = runTerminalEndAction({
      intent: { kind: 'all' },
      terminalCount: 3,
      confirm: controller.request,
      onEnd: (terminalId) => ended.push(terminalId),
      onEndAll: () => {
        endedAll += 1
      }
    })

    const prompt = controller.getSnapshot()
    assert.ok(prompt)
    assert.equal(prompt.options.title, '结束全部终端')
    assert.equal(prompt.options.confirmLabel, '全部结束')
    assert.equal(prompt.options.destructive, true)
    assert.match(String(prompt.options.description), /3/)
    assert.equal(endedAll, 0)

    controller.settle(true)
    assert.equal(await pending, true)
    assert.equal(endedAll, 1)
    assert.deepEqual(ended, [])
  } finally {
    restoreWindow()
    setUiLanguage('en')
  }
})

test('terminal title bar and upload flows no longer call native dialogs', () => {
  const titleBarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/terminal/components/TerminalTitleBar.tsx'),
    'utf8'
  )
  assert.match(titleBarSource, /useConfirmation\(\)/)
  assert.match(titleBarSource, /runTerminalEndAction\(/)
  assert.match(titleBarSource, /\{confirmationDialog\}/)
  assert.doesNotMatch(titleBarSource, /\bwindow\.confirm\s*\(/)

  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(appSource, /await confirm\(\{/)
  assert.match(appSource, /\{confirmationDialog\}/)
  assert.doesNotMatch(appSource, /\bwindow\.confirm\s*\(/)

  const uploadSource = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/wrapper/components/WrapperInputUploadDialog.tsx'
    ),
    'utf8'
  )
  assert.match(uploadSource, /await confirm\(\{/)
  assert.match(uploadSource, /cancelRemoteProjectUpload\(prepared\.id\)/)
  assert.match(uploadSource, /\{confirmationDialog\}/)
  assert.doesNotMatch(uploadSource, /\bwindow\.confirm\s*\(/)
})
