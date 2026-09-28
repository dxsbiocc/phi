import assert from 'node:assert/strict'
import test from 'node:test'
import { contextUsageSnapshot } from '../src/main/agent/omp/context-usage-snapshot'

const usage = { tokens: 10000, contextWindow: 20000, percent: 50 }
const breakdown = {
  contextWindow: 20000,
  usedTokens: 10000,
  systemPromptTokens: 500,
  systemToolsTokens: 1500,
  systemContextTokens: 1000,
  skillsTokens: 2000,
  messagesTokens: 5000
}

test('context usage snapshot carries SDK category totals without changing overall usage', () => {
  assert.deepEqual(contextUsageSnapshot(usage, breakdown), {
    ...usage,
    categories: [
      { id: 'systemPrompt', tokens: 500 },
      { id: 'toolDefinitions', tokens: 1500 },
      { id: 'systemContext', tokens: 1000 },
      { id: 'skills', tokens: 2000 },
      { id: 'conversation', tokens: 5000 }
    ]
  })
})

test('context usage snapshot omits inconsistent category estimates', () => {
  assert.deepEqual(contextUsageSnapshot(usage, { ...breakdown, messagesTokens: 6000 }), usage)
  assert.deepEqual(contextUsageSnapshot(usage, { ...breakdown, contextWindow: 10000 }), usage)
  assert.equal(contextUsageSnapshot({ ...usage, contextWindow: 0 }, breakdown), null)
})
