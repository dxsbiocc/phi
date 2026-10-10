import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { InputAddPanel } from '../src/renderer/src/components/chat/InputAddMenu'
import { InputInvocationReferenceMenu } from '../src/renderer/src/components/chat/InputInvocationReferenceMenu'
import type { PromptAgentSummary, SkillSummary } from '../src/renderer/src/types'

function skill(iconKey: string): SkillSummary {
  return {
    icon: { key: iconKey },
    id: '/skills/demo/SKILL.md',
    name: 'demo',
    description: 'Demo skill',
    filePath: '/skills/demo/SKILL.md',
    source: 'project',
    scope: 'project',
    sourceCategory: 'project',
    sourceCategoryLabel: '项目',
    enabled: true,
    globalEnabled: true,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: false
  }
}

test('the composer uses resolved agent and skill artwork instead of fixed glyphs', () => {
  const agent: PromptAgentSummary = {
    icon: { key: 'agent-icon' },
    id: 'phi-agent:Wrapper',
    name: 'Wrapper',
    description: 'Wrapper specialist',
    source: 'phi-agent',
    trigger: '调用智能体：Wrapper'
  }
  const markup = renderToStaticMarkup(
    createElement(InputAddPanel, {
      panelId: 'add-panel',
      panelRef: createRef<HTMLDivElement>(),
      skills: [skill('skill-icon')],
      promptAgents: [agent],
      plugins: [],
      cwd: '/workspace',
      onInsertReference: () => undefined,
      onClose: () => undefined
    })
  )

  assert.match(markup, /data-phi-resource-icon="agent"/)
  assert.match(markup, /data-phi-resource-icon-key="agent-icon"/)
  assert.match(markup, /data-phi-resource-icon="skill"/)
  assert.match(markup, /data-phi-resource-icon-key="skill-icon"/)
})

test('shortcut reference results render the same resolved artwork', () => {
  const markup = renderToStaticMarkup(
    createElement(InputInvocationReferenceMenu, {
      state: {
        kind: 'agent',
        query: 'wrap',
        operator: '/agent:',
        candidates: [
          {
            icon: { key: 'shortcut-agent-icon' },
            kind: 'agent',
            name: 'Wrapper',
            description: 'Wrapper specialist',
            referenceText: '调用智能体：Wrapper'
          }
        ]
      },
      highlightedIndex: 0,
      onHighlight: () => undefined,
      onSelect: () => undefined
    })
  )

  assert.match(markup, /data-phi-resource-icon="agent"/)
  assert.match(markup, /data-phi-resource-icon-key="shortcut-agent-icon"/)
})
