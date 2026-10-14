import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activateChild, childAuthority, childStarted } from './helpers/rpcChildAuthorityFixture'

test('refused native cancel cannot become an empty successful same-parent retry', async () => {
  const calls: string[] = []
  const { authority } = childAuthority({
    cancelNativeChild: (id) => {
      calls.push(id)
      return false
    }
  })
  try {
    await activateChild(authority)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    assert.deepEqual(calls, ['child', 'child'])
    await authority.cancelParent('other-parent')
    assert.deepEqual(calls, ['child', 'child'])
  } finally {
    authority.dispose()
  }
})
test('an acknowledged cancel without native terminal remains unconfirmed on retry', async () => {
  let attempts = 0
  const { authority } = childAuthority({
    cancellationTimeoutMs: 5,
    cancelNativeChild: async () => {
      attempts++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return true
    }
  })
  try {
    await activateChild(authority)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    assert.equal(attempts, 2)
  } finally {
    authority.dispose()
  }
})
test('confirmed real terminal permits idempotent retry without cancelling another parent', async () => {
  const calls: string[] = []
  const { authority } = childAuthority({
    cancelNativeChild: (id) => {
      calls.push(id)
      const frame = childStarted()
      ;(frame.payload as Record<string, unknown>).status = 'aborted'
      authority.observe(frame)
      return true
    }
  })
  try {
    await activateChild(authority)
    await authority.cancelParent('parent-run')
    await authority.cancelParent('parent-run')
    await authority.cancelParent('other-parent')
    assert.deepEqual(calls, ['child'])
  } finally {
    authority.dispose()
  }
})

test('a true RPC ACK alone cannot retire an unobserved native child on retry', async () => {
  let attempts = 0
  const keepAlive = setInterval(() => undefined, 10)
  const { authority } = childAuthority({
    cancellationTimeoutMs: 5,
    cancelNativeChild: () => {
      attempts++
      return true
    }
  })
  try {
    await activateChild(authority)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    assert.equal(attempts, 2)
  } finally {
    clearInterval(keepAlive)
    authority.dispose()
  }
})
test('concurrent same-parent cancellation shares the native attempt and real terminal wait', async () => {
  let release!: (value: boolean) => void,
    attempts = 0
  const { authority } = childAuthority({
    cancelNativeChild: () => {
      attempts++
      return new Promise((resolve) => {
        release = resolve
      })
    }
  })
  try {
    await activateChild(authority)
    const first = authority.cancelParent('parent-run')
    void first.catch(() => undefined)
    let secondDone = false
    const second = authority.cancelParent('parent-run').then(() => {
      secondDone = true
    })
    void second.catch(() => undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(secondDone, false)
    assert.equal(attempts, 1)
    const frame = childStarted()
    ;(frame.payload as Record<string, unknown>).status = 'aborted'
    authority.observe(frame)
    release(true)
    await Promise.all([first, second])
  } finally {
    release?.(false)
    authority.dispose()
  }
})
