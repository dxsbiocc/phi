import assert from 'node:assert/strict'
import test from 'node:test'

import { TERMINAL_MAX_INPUT_BYTES } from '../src/shared/terminalTypes'
import {
  isMultilinePaste,
  isTerminalInputWithinLimit,
  terminalInputByteLength,
  terminalKeyAction,
  wrapBracketedPaste
} from '../src/renderer/src/features/terminal/lib/terminalInput'

const key = (
  value: string,
  modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}
): { key: string; metaKey: boolean; ctrlKey: boolean } => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  ...modifiers
})

test('routes terminal shortcuts without leaking unrelated Cmd keys to the PTY', () => {
  assert.equal(terminalKeyAction(key('c', { ctrlKey: true }), false), 'process')
  assert.equal(terminalKeyAction(key('c', { metaKey: true }), true), 'copy')
  assert.equal(terminalKeyAction(key('c', { metaKey: true }), false), 'ignore')
  assert.equal(terminalKeyAction(key('v', { metaKey: true }), false), 'paste')
  assert.equal(terminalKeyAction(key('k', { metaKey: true }), false), 'clear')
  assert.equal(terminalKeyAction(key('s', { metaKey: true }), false), 'ignore')
  assert.equal(terminalKeyAction(key('Enter'), false), 'process')
})

test('detects every newline form as a multi-line paste', () => {
  assert.equal(isMultilinePaste('echo one'), false)
  assert.equal(isMultilinePaste('echo one\necho two'), true)
  assert.equal(isMultilinePaste('echo one\recho two'), true)
  assert.equal(isMultilinePaste('echo one\r\necho two'), true)
})

test('wraps confirmed paste only while bracketed paste mode is enabled', () => {
  const text = 'printf one\nprintf two'
  assert.equal(wrapBracketedPaste(text, false), text)
  assert.equal(wrapBracketedPaste(text, true), `\u001b[200~${text}\u001b[201~`)
})

test('enforces the 64 KiB input limit using UTF-8 bytes', () => {
  assert.equal(isTerminalInputWithinLimit('a'.repeat(TERMINAL_MAX_INPUT_BYTES)), true)
  assert.equal(isTerminalInputWithinLimit('a'.repeat(TERMINAL_MAX_INPUT_BYTES + 1)), false)
  assert.equal(terminalInputByteLength('终端'), 6)
  assert.equal(
    isTerminalInputWithinLimit('终'.repeat(Math.floor(TERMINAL_MAX_INPUT_BYTES / 3))),
    true
  )
  assert.equal(
    isTerminalInputWithinLimit('终'.repeat(Math.floor(TERMINAL_MAX_INPUT_BYTES / 3) + 1)),
    false
  )
})
