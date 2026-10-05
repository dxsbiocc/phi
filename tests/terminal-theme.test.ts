import assert from 'node:assert/strict'
import test from 'node:test'
import { createMinimalTheme } from '../src/renderer/src/minimalTheme'
import { createTerminalTheme } from '../src/renderer/src/features/terminal/lib/terminalTheme'

test('terminal defaults use the same surface as the application cards', () => {
  for (const mode of ['light', 'dark'] as const) {
    assert.equal(
      createTerminalTheme(mode).background,
      createMinimalTheme(mode).palette.background.paper
    )
  }
})

test('terminal surfaces follow a supplied palette without changing ANSI or foreground colors', () => {
  for (const mode of ['light', 'dark'] as const) {
    const base = createTerminalTheme(mode)
    const background = mode === 'dark' ? '#123640' : '#F4F6F8'
    const themed = createTerminalTheme(mode, background)
    assert.equal(themed.background, background)
    assert.equal(themed.cursorAccent, background)
    for (const key of ['foreground', 'red', 'green', 'blue', 'brightCyan'] as const) {
      assert.equal(themed[key], base[key])
    }
    assert.notEqual(themed, base)
    assert.deepEqual(createTerminalTheme(mode), base)
  }
})
