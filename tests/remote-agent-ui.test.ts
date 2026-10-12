import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { InputAddPanel } from '../src/renderer/src/components/chat/InputAddMenu'
import { InputInvocationReferenceMenu } from '../src/renderer/src/components/chat/InputInvocationReferenceMenu'
import { mutateRemoteAgentTrust } from '../src/renderer/src/features/agent/lib/remoteAgentTrust'
import { parseInputInvocationReferences } from '../src/renderer/src/lib/inputReferences'
import type { PromptAgentSummary } from '../src/renderer/src/types'

function remoteAgent(
  trustState: NonNullable<PromptAgentSummary['trustState']>,
  available = false
): PromptAgentSummary {
  return {
    id: `remote:${trustState}`,
    name: 'Reviewer',
    description: 'Reviews server files.',
    source: 'server-project-agent',
    trigger: '调用智能体：Reviewer',
    scope: 'remote-project',
    trustState,
    available,
    diagnostics: [
      trustState === 'changed'
        ? '来自服务器项目，内容已变化，需要重新信任'
        : '来自服务器项目，未信任'
    ],
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }
}

test('agent menus show server trust badges, diagnostics and disable untrusted selection', () => {
  const pending = remoteAgent('pending')
  const addMarkup = renderToStaticMarkup(
    createElement(InputAddPanel, {
      panelId: 'add-panel',
      panelRef: createRef<HTMLDivElement>(),
      skills: [],
      promptAgents: [pending],
      cwd: '/local/anchor',
      onInsertReference: () => assert.fail('pending agent must not be selected'),
      onClose: () => undefined
    })
  )
  assert.match(addMarkup, /服务器项目/)
  assert.match(addMarkup, /未信任/)
  assert.match(addMarkup, />信任</)
  assert.match(addMarkup, /disabled/)

  const shortcutMarkup = renderToStaticMarkup(
    createElement(InputInvocationReferenceMenu, {
      state: {
        kind: 'agent',
        query: 'review',
        operator: '/agent:',
        candidates: [
          {
            id: pending.id,
            kind: 'agent',
            name: pending.name,
            description: pending.description,
            referenceText: pending.trigger,
            scope: pending.scope,
            trustState: pending.trustState,
            available: pending.available,
            diagnostics: pending.diagnostics,
            agent: pending
          }
        ]
      },
      cwd: '/local/anchor',
      highlightedIndex: 0,
      onHighlight: () => undefined,
      onSelect: () => assert.fail('pending agent must not be selected')
    })
  )
  assert.match(shortcutMarkup, /未信任/)
  assert.match(shortcutMarkup, /来自服务器项目/)
  assert.match(shortcutMarkup, />信任</)
  assert.match(shortcutMarkup, /disabled/)
})

test('agent menu distinguishes changed, trusted and degraded-but-selectable states', () => {
  const changed = remoteAgent('changed')
  const trusted = {
    ...remoteAgent('trusted', true),
    diagnostics: ['该 agent 在远程项目中缺少：office_read']
  }
  const markup = renderToStaticMarkup(
    createElement(InputAddPanel, {
      panelId: 'add-panel',
      panelRef: createRef<HTMLDivElement>(),
      skills: [],
      promptAgents: [changed, trusted],
      cwd: '/local/anchor',
      onInsertReference: () => undefined,
      onClose: () => undefined
    })
  )

  assert.match(markup, /内容已变化/)
  assert.match(markup, /重新信任/)
  assert.match(markup, /已信任/)
  assert.match(markup, /撤销信任/)
  assert.match(markup, /该 agent 在远程项目中缺少：office_read/)
})

test('remote agent trust helper invokes trust or revoke with the content-bound request', async () => {
  const calls: Array<{ operation: string; input: unknown }> = []
  let refreshes = 0
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        trustRemoteProjectAgent: async (input: unknown) => {
          calls.push({ operation: 'trust', input })
          return []
        },
        revokeRemoteProjectAgentTrust: async (input: unknown) => {
          calls.push({ operation: 'revoke', input })
          return []
        }
      }
    }
  })
  try {
    const refresh = (): void => {
      refreshes += 1
    }
    await mutateRemoteAgentTrust(remoteAgent('changed'), '/local/anchor', refresh)
    await mutateRemoteAgentTrust(remoteAgent('trusted', true), '/local/anchor', refresh)
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }

  const request = {
    cwd: '/local/anchor',
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }
  assert.deepEqual(calls, [
    { operation: 'trust', input: request },
    { operation: 'revoke', input: request }
  ])
  assert.equal(refreshes, 2)
})

test('manual agent references ignore pending entries and use an available same-name agent', () => {
  const pending = remoteAgent('pending')
  const global: PromptAgentSummary = {
    id: '/local/Reviewer.md',
    name: 'Reviewer',
    description: 'Local reviewer.',
    source: 'phi-agent',
    trigger: '调用智能体：Reviewer',
    available: true
  }

  assert.deepEqual(parseInputInvocationReferences('/agent:Reviewer', [], [pending]).references, [])
  assert.deepEqual(
    parseInputInvocationReferences('/agent:Reviewer', [], [pending, global]).references,
    [{ kind: 'agent', name: 'Reviewer', text: '调用智能体：Reviewer' }]
  )
})
