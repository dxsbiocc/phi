import assert from 'node:assert/strict'
import test from 'node:test'

import { getPromptReadiness } from '../src/renderer/src/lib/promptReadiness'
import type { ModelOption, ProviderAuthStatus } from '../src/renderer/src/types'

const provider = (configured: boolean): ProviderAuthStatus => ({
  providerId: 'openai',
  name: 'OpenAI',
  configured,
  hasApiKey: configured,
  hasOAuth: false,
  hasConfigError: false,
  statusText: configured ? '已配置' : '未配置'
})

const model: ModelOption = {
  providerId: 'openai',
  modelId: 'gpt-test',
  name: 'GPT Test',
  thinkingLevels: ['high']
}

test('prompt readiness waits for initial provider/model state before routing', () => {
  assert.deepEqual(
    getPromptReadiness({
      modelStateReady: false,
      providers: [],
      availableModels: []
    }),
    { ready: false, reason: 'providers_loading' }
  )
})

test('prompt readiness routes missing configuration to provider setup', () => {
  assert.deepEqual(
    getPromptReadiness({
      modelStateReady: true,
      providers: [provider(false)],
      availableModels: []
    }),
    { ready: false, reason: 'no_configured_provider' }
  )
  assert.deepEqual(
    getPromptReadiness({
      modelStateReady: true,
      providers: [provider(true)],
      availableModels: []
    }),
    { ready: false, reason: 'no_available_model' }
  )
})

test('prompt readiness allows automatic model selection when a configured model exists', () => {
  assert.deepEqual(
    getPromptReadiness({
      modelStateReady: true,
      providers: [provider(true)],
      availableModels: [model]
    }),
    { ready: true }
  )
})
