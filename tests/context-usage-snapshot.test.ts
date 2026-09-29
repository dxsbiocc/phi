import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contextUsageSnapshot,
  partitionMcpTools
} from '../src/main/agent/omp/context-usage-snapshot'

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

test('Phi prompt stays visible when SDK subtracts later skill text from its first block', () => {
  const phiUsage = { tokens: 50500, contextWindow: 262100, percent: 50500 / 2621 }
  const sdkBreakdown = {
    contextWindow: 262100,
    usedTokens: 50500,
    systemPromptTokens: 0,
    systemToolsTokens: 10700,
    systemContextTokens: 9000,
    skillsTokens: 2300,
    messagesTokens: 28500
  }

  assert.deepEqual(contextUsageSnapshot(phiUsage, sdkBreakdown, 500), {
    ...phiUsage,
    categories: [
      { id: 'systemPrompt', tokens: 500 },
      { id: 'toolDefinitions', tokens: 10700 },
      { id: 'systemContext', tokens: 6700 },
      { id: 'skills', tokens: 2300 },
      { id: 'conversation', tokens: 30300 }
    ]
  })
  assert.deepEqual(
    contextUsageSnapshot(phiUsage, { ...sdkBreakdown, systemContextTokens: 1000 }, 500),
    phiUsage
  )
})

test('direct MCP schemas split from other tools while deferred MCP stays outside usage', () => {
  assert.deepEqual(
    contextUsageSnapshot(usage, breakdown, undefined, { directTokens: 300, deferredTokens: 8000 }),
    {
      ...usage,
      deferredMcpTokens: 8000,
      categories: [
        { id: 'systemPrompt', tokens: 500 },
        { id: 'systemTools', tokens: 1200 },
        { id: 'mcpTools', tokens: 300 },
        { id: 'systemContext', tokens: 1000 },
        { id: 'skills', tokens: 2000 },
        { id: 'conversation', tokens: 5000 }
      ]
    }
  )
  assert.deepEqual(
    contextUsageSnapshot(usage, breakdown, undefined, { directTokens: 1800, deferredTokens: 8000 }),
    { ...usage, deferredMcpTokens: 8000 }
  )
})

test('MCP partition follows direct injection without counting a tool twice', () => {
  const read = { name: 'read' }
  const direct = { name: 'mcp__alpha_search' }
  const deferred = { name: 'mcp__beta_query' }
  const tools = new Map([direct, deferred].map((tool) => [tool.name, tool]))
  const enabled = [direct.name, deferred.name]
  const before = partitionMcpTools([read, direct], enabled, (name) => tools.get(name))
  assert.deepEqual(before, { directTools: [direct], deferredTools: [deferred] })

  const after = partitionMcpTools([read, direct, deferred], enabled, (name) => tools.get(name))
  assert.deepEqual(after, { directTools: [direct, deferred], deferredTools: [] })
})
