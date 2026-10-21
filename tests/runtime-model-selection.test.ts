import assert from 'node:assert/strict'
import test from 'node:test'

import type { ModelSelection } from '../src/main/agent/projects'
import type { ModelRuntime, RuntimeModel } from '../src/main/agent/runtime/runtime-adapter'
import {
  resolveRuntimeModelSelection,
  selectableRuntimeModels
} from '../src/main/agent/runtime/runtime-model-selection'

function model(provider: string, id: string): RuntimeModel {
  return { provider, id, name: id, reasoning: false }
}

function runtime(models: RuntimeModel[]): ModelRuntime {
  return {
    getProviders: () => [],
    getModels: () => models,
    getModel: (providerId, modelId) =>
      models.find((candidate) => candidate.provider === providerId && candidate.id === modelId),
    getProviderAuthStatus: () => ({ configured: false }),
    listCredentials: () => Promise.resolve([]),
    login: () => Promise.resolve(),
    logout: () => Promise.resolve()
  }
}

test('resolves an exact selectable runtime model without changing the selection', () => {
  const exact = model('openai', 'gpt-5.4')
  const selection: ModelSelection = { providerId: exact.provider, modelId: exact.id }

  const resolved = resolveRuntimeModelSelection(runtime([exact]), selection)

  assert.deepEqual(resolved, { model: exact, selection })
  assert.equal(resolved?.selection, selection)
})

test('migrates a retired Kimi Code model to the first available replacement', () => {
  const replacement = model('kimi-code', 'k3')
  const laterReplacement = model('kimi-code', 'k3-256k')
  const selection: ModelSelection = { providerId: 'kimi-code', modelId: 'kimi-k2.5' }

  const resolved = resolveRuntimeModelSelection(
    runtime([model('kimi-code', 'kimi-k2.5'), replacement, laterReplacement]),
    selection
  )

  assert.deepEqual(resolved, {
    model: replacement,
    selection: { providerId: 'kimi-code', modelId: 'k3' },
    migratedFrom: selection
  })
  assert.deepEqual(selectableRuntimeModels(runtime([model('kimi-code', 'kimi-k2'), replacement])), [
    replacement
  ])
})

test('returns null when neither an exact model nor a migration target is available', () => {
  assert.equal(
    resolveRuntimeModelSelection(runtime([]), { providerId: 'openai', modelId: 'missing' }),
    null
  )
  assert.equal(
    resolveRuntimeModelSelection(runtime([]), { providerId: 'kimi-code', modelId: 'kimi-k2' }),
    null
  )
})
