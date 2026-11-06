import assert from 'node:assert/strict'
import test from 'node:test'

import { followSessionModelForSubagents } from '../src/main/agent/engine/in-process/subagent-model-role'

function fakeSession(initial: { provider: string; id: string } | undefined): {
  session: {
    model: { provider: string; id: string } | undefined
    subscribe(listener: (event: unknown) => void): () => void
  }
  emit(): void
} {
  const listeners = new Set<(event: unknown) => void>()
  const session = {
    model: initial,
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { session, emit: () => listeners.forEach((listener) => listener({ type: 'any' })) }
}

function fakeSettings(): {
  overrides: Array<Record<string, string>>
  overrideModelRoles(roles: Record<string, string>): void
} {
  const overrides: Array<Record<string, string>> = []
  return { overrides, overrideModelRoles: (roles) => overrides.push({ ...roles }) }
}

test('subagents resolve their default role to the conversation model, not a built-in pick', () => {
  const { session } = fakeSession({ provider: 'deepseek', id: 'deepseek-flash' })
  const settings = fakeSettings()
  followSessionModelForSubagents(session, settings)
  assert.deepEqual(settings.overrides, [{ default: 'deepseek/deepseek-flash' }])
})

test('switching the conversation model moves the subagent default with it, once per change', () => {
  const { session, emit } = fakeSession({ provider: 'deepseek', id: 'deepseek-flash' })
  const settings = fakeSettings()
  followSessionModelForSubagents(session, settings)
  emit()
  session.model = { provider: 'cursor', id: 'cursor-grok-4.6' }
  emit()
  emit()
  assert.deepEqual(settings.overrides, [
    { default: 'deepseek/deepseek-flash' },
    { default: 'cursor/cursor-grok-4.6' }
  ])
})

test('a session without a model leaves the roles alone', () => {
  const { session } = fakeSession(undefined)
  const settings = fakeSettings()
  followSessionModelForSubagents(session, settings)
  assert.deepEqual(settings.overrides, [])
})
