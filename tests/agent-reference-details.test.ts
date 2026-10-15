import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

import {
  AgentReferenceDetails,
  AgentReferenceDialog
} from '../src/renderer/src/features/agent/components/AgentReferenceDialog'
import type { useAgentResourceMentions } from '../src/renderer/src/features/chat/hooks/useAgentResourceMentions'
import { parseInputInvocationReferences } from '../src/renderer/src/lib/inputReferences'
import type { PromptAgentSummary } from '../src/renderer/src/types'

const reviewer: PromptAgentSummary = {
  id: '/agents/Reviewer.md',
  name: 'Reviewer',
  description: '检查实现与回归风险。',
  source: 'phi-agent',
  trigger: '调用智能体：Reviewer',
  icon: { key: 'reviewer-icon' }
}

test('agent details show the real icon, source, invocation and path without mutation controls', () => {
  const markup = renderToStaticMarkup(createElement(AgentReferenceDetails, { agent: reviewer }))
  for (const value of [
    'Reviewer',
    '检查实现与回归风险。',
    '调用智能体：Reviewer',
    '/agents/Reviewer.md'
  ])
    assert.ok(markup.includes(value), value)
  assert.match(markup, /data-phi-resource-icon="agent"/)
  assert.match(markup, /data-phi-resource-icon-key="reviewer-icon"/)
  assert.match(markup, /来源/)
  assert.doesNotMatch(markup, /<button|启用|禁用|撤销信任/)
  let closed = false
  const shell = AgentReferenceDialog({ agent: reviewer, onClose: () => (closed = true) })
  assert.equal(shell.props.open, true)
  shell.props.onClose()
  assert.equal(closed, true)
})

test('remote pending agent details retain trust diagnostics without making an invocation available', () => {
  const pending: PromptAgentSummary = {
    ...reviewer,
    id: 'remote:Reviewer',
    source: 'server-project-agent',
    scope: 'remote-project',
    available: false,
    trustState: 'pending',
    relativePath: '.phi/agents/Reviewer.md',
    diagnostics: ['来自服务器项目，未信任']
  }
  const markup = renderToStaticMarkup(createElement(AgentReferenceDetails, { agent: pending }))
  assert.match(markup, /服务器项目/)
  assert.match(markup, /未信任/)
  assert.match(markup, /来自服务器项目，未信任/)
  assert.match(markup, /\.phi\/agents\/Reviewer\.md/)
  assert.doesNotMatch(markup, /<button|撤销信任|重新信任/)
  assert.deepEqual(parseInputInvocationReferences('/agent:Reviewer', [], [pending]).references, [])
})

test('agent resource callbacks open current metadata and dismiss after removal or replacement', () => {
  type Result = ReturnType<typeof useAgentResourceMentions>
  let selected: unknown = null
  const module = { exports: {} as { useAgentResourceMentions: typeof useAgentResourceMentions } }
  const source = ts.transpileModule(
    readFileSync('src/renderer/src/features/chat/hooks/useAgentResourceMentions.tsx', 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX
      }
    }
  ).outputText
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier === 'react') {
        return {
          useState: () => [selected, (value: unknown) => (selected = value)],
          useMemo: (create: () => unknown) => create()
        }
      }
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      if (specifier.endsWith('/AgentReferenceDialog')) return { AgentReferenceDialog }
      throw new Error(`Unexpected import: ${specifier}`)
    }
  })
  const read = (agents: readonly PromptAgentSummary[]): Result => {
    const result = module.exports.useAgentResourceMentions(agents)
    return result
  }
  const catalog = [reviewer]
  const initial = read(catalog)
  assert.equal(initial.details, null)
  const resource = initial.resources[0]
  assert.equal(resource.kind, 'agent')
  assert.equal(resource.id, reviewer.id)
  assert.equal(resource.icon, reviewer.icon)
  resource.onOpen?.()
  let details = read(catalog).details as ReactElement<{
    agent: PromptAgentSummary
    onClose: () => void
  }>
  assert.equal(details.props.agent, reviewer)
  details.props.onClose()
  assert.equal(read(catalog).details, null)
  resource.onOpen?.()
  assert.equal(read([{ ...reviewer, description: '更新后的说明' }]).details, null)
  resource.onOpen?.()
  assert.equal(read([]).details, null)
  assert.equal(read(catalog).details, null)
  const pending = { ...reviewer, available: false }
  const pendingCatalog = [pending]
  const pendingResource = read(pendingCatalog).resources[0]
  assert.equal(pendingResource.available, false)
  pendingResource.onOpen?.()
  details = read(pendingCatalog).details as typeof details
  assert.equal(details.props.agent, pending)
})
