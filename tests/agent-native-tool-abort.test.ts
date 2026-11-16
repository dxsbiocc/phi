import assert from 'node:assert/strict'
import test from 'node:test'

import { injectNativeToolAbortSignal } from '../src/main/agent/engine/in-process/native-tool-abort'

function nativeBash(onSignal: (signal?: AbortSignal) => void): {
  name: string
  execute: (id: string, args: unknown, signal?: AbortSignal) => { content: never[] }
} {
  return {
    name: 'bash',
    execute: (_id: string, _args: unknown, signal?: AbortSignal) => {
      onSignal(signal)
      return { content: [] }
    }
  }
}

test('native Cursor bash receives the owner signal when the bridge omits it', () => {
  const owner = new AbortController()
  let seen: AbortSignal | undefined
  const bash = nativeBash((signal) => {
    seen = signal
  })
  injectNativeToolAbortSignal(
    { getToolByName: (name) => (name === 'bash' ? bash : undefined) },
    owner.signal
  )
  bash.execute('call', { command: 'sleep 65' }, undefined)
  assert.equal(seen, owner.signal)
  owner.abort()
  assert.equal(seen?.aborted, true)
})

test('owner and caller signals are both effective', () => {
  const owner = new AbortController()
  const caller = new AbortController()
  let seen: AbortSignal | undefined
  const bash = nativeBash((signal) => {
    seen = signal
  })
  injectNativeToolAbortSignal(
    { getToolByName: (name) => (name === 'bash' ? bash : undefined) },
    owner.signal
  )
  bash.execute('call', {}, caller.signal)
  assert.notEqual(seen, caller.signal)
  assert.equal(seen?.aborted, false)
  caller.abort()
  assert.equal(seen?.aborted, true)
  const second = new AbortController()
  const owner2 = new AbortController()
  const bash2 = nativeBash((signal) => {
    seen = signal
  })
  injectNativeToolAbortSignal(
    { getToolByName: (name) => (name === 'bash' ? bash2 : undefined) },
    owner2.signal
  )
  bash2.execute('call', {}, second.signal)
  owner2.abort()
  assert.equal(seen?.aborted, true)
  assert.equal(second.signal.aborted, false)
})

test('a later install replaces the owner signal without nesting an aborted prompt scope', () => {
  const first = new AbortController()
  const second = new AbortController()
  let seen: AbortSignal | undefined
  const bash = nativeBash((signal) => {
    seen = signal
  })
  const session = { getToolByName: (name: string) => (name === 'bash' ? bash : undefined) }
  injectNativeToolAbortSignal(session, first.signal)
  bash.execute('call', {}, undefined)
  assert.equal(seen, first.signal)
  first.abort()
  assert.equal(seen?.aborted, true)

  injectNativeToolAbortSignal(session, second.signal)
  bash.execute('call', {}, undefined)
  assert.equal(seen, second.signal)
  assert.equal(seen?.aborted, false)
  second.abort()
  assert.equal(seen?.aborted, true)
})

test('a replacement tool object is wrapped by the next prompt install', () => {
  const first = new AbortController()
  const second = new AbortController()
  let seen: AbortSignal | undefined
  const firstBash = nativeBash((signal) => {
    seen = signal
  })
  const secondBash = nativeBash((signal) => {
    seen = signal
  })
  let current = firstBash
  const session = { getToolByName: (name: string) => (name === 'bash' ? current : undefined) }
  injectNativeToolAbortSignal(session, first.signal)
  firstBash.execute('call', {}, undefined)
  assert.equal(seen, first.signal)
  current = secondBash
  injectNativeToolAbortSignal(session, second.signal)
  secondBash.execute('call', {}, undefined)
  assert.equal(seen, second.signal)
  assert.equal(seen?.aborted, false)
})

test('repeated installs wrap once; already-aborted signal is preserved', () => {
  const owner = new AbortController()
  owner.abort()
  let calls = 0
  let seen: AbortSignal | undefined
  const bash = nativeBash((signal) => {
    calls += 1
    seen = signal
  })
  const session = { getToolByName: (name: string) => (name === 'bash' ? bash : undefined) }
  injectNativeToolAbortSignal(session, owner.signal)
  const wrapped = bash.execute
  injectNativeToolAbortSignal(session, owner.signal)
  assert.equal(bash.execute, wrapped)
  bash.execute('call', {}, undefined)
  assert.equal(calls, 1)
  assert.equal(seen?.aborted, true)
})
