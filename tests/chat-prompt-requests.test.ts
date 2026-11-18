import assert from 'node:assert/strict'
import test from 'node:test'
import { createChatPromptRequests } from '../src/renderer/src/features/chat/lib/chatPromptRequests'

test('an unchanged draft can retry a lost receipt with the same id but cannot send twice concurrently', () => {
  let requests = 0
  const tracker = createChatPromptRequests(() => String(++requests))
  const first = tracker.begin('phi:chat')
  assert.ok(first)
  assert.equal(tracker.begin('phi:chat'), null)
  assert.equal(first.finish(false), null)

  const retry = tracker.begin('phi:chat')
  assert.ok(retry)
  assert.equal(retry.requestId, first.requestId)
  assert.equal(retry.finish(true), 'phi:chat')
  assert.notEqual(tracker.begin('phi:chat')?.requestId, first.requestId)
})

test('a failed or delayed receipt leaves a newer edit and another conversation untouched', () => {
  let requests = 0
  const tracker = createChatPromptRequests(() => String(++requests))
  const old = tracker.begin('draft:one')
  assert.ok(old)
  tracker.edited('draft:one')
  const updated = tracker.begin('draft:one')
  assert.ok(updated)
  const peer = tracker.begin('draft:two')
  assert.ok(peer)
  assert.equal(old.finish(true), null)
  assert.equal(tracker.begin('draft:one'), null)
  assert.equal(updated.finish(true), 'draft:one')
  assert.equal(peer.finish(true), 'draft:two')
})

test('an in-flight submission still owns the same draft after the first receipt materializes it', () => {
  const tracker = createChatPromptRequests(() => 'id')
  const inFlight = tracker.begin('draft:one')
  assert.ok(inFlight)
  tracker.move('draft:one', 'phi:one')
  assert.equal(tracker.begin('phi:one'), null)
  assert.equal(inFlight.finish(true), 'phi:one')
})
