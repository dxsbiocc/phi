import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExecArgs } from '../src/main/agent/wrappers/remote-ssh-session'

const commandFor = (length: number): string =>
  buildExecArgs('host', '/tmp/control', 'x'.repeat(length)).at(-1) as string

test('a command that would nearly fill the mux socket buffer is padded past it', () => {
  // On macOS these lengths left no room for the descriptors: every session failed to start.
  for (const length of [8091, 8100, 8105, 8140, 8149]) {
    const command = commandFor(length)
    assert.ok(Buffer.byteLength(command) >= 8256, `${length} stays in the failing window`)
    assert.equal(command.trimEnd().length, length, 'only trailing spaces are added')
  }
})

test('the window is measured in bytes, not characters', () => {
  const command = buildExecArgs('host', '/tmp/control', '界'.repeat(2700)).at(-1) as string
  assert.ok(Buffer.byteLength(command) >= 8256)
})

test('other command lengths are left untouched', () => {
  for (const length of [1, 4000, 7935, 8256, 32000]) {
    assert.equal(commandFor(length).length, length)
  }
})
