import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SubagentSessionView from '../src/renderer/src/features/chat/SubagentSessionView'
import AgentExecutionCard from '../src/renderer/src/features/chat/components/AgentExecutionCard'
import {
  subagentPrompt,
  subagentSessionMessages
} from '../src/renderer/src/features/chat/lib/subagentSession'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import type { AgentExecutionItem } from '../src/renderer/src/types'

const item: AgentExecutionItem = {
  id: 'delegation-1',
  role: 'agent_execution',
  agentName: 'Researcher',
  task: 'Brief task preview',
  argsPreview: '',
  argsJson: JSON.stringify({
    task: 'Full assigned command\nKeep the second line.',
    background: true
  }),
  status: 'running',
  agentSessionId: 'runtime-a',
  agentRunId: 'run-1',
  steps: []
}

function render(overrides: Partial<AgentExecutionItem> = {}, compact = false): string {
  const record = { ...item, ...overrides }
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      compact
        ? createElement(AgentExecutionCard, { item: record, onOpen: () => undefined })
        : createElement(SubagentSessionView, { item: record, cwd: '/project' })
    )
  )
}

test('the temporary conversation uses the full assigned command as the user message', () => {
  setUiLanguage('en')
  const html = render()
  assert.match(html, /Full assigned command/)
  assert.match(html, /Keep the second line\./)
  assert.doesNotMatch(html, /Brief task preview|&quot;task&quot;|&quot;background&quot;/)
  assert.match(html, /data-phi-user-message-actions="true"/)
  assert.match(html, /Temporary agent conversation/)
  assert.match(html, /data-phi-chat-placement="tab"/)
  assert.match(html, /data-phi-composer-editor="codemirror"/)
  assert.match(html, /data-phi-composer-action="stop"/)
  assert.match(html, /aria-label="Message input"/)
})

test('the parent card exposes only identity and status, never execution details or controls', () => {
  setUiLanguage('en')
  const html = render({ finalReport: 'private report', error: 'private error' }, true)
  assert.match(html, /Researcher/)
  assert.match(html, /Running/)
  assert.match(html, /aria-label="Open Researcher conversation"/)
  assert.doesNotMatch(html, /Full assigned command|Brief task preview|private report|private error/)
  assert.doesNotMatch(html, /aria-expanded|Stop agent|Additional instructions for agent/)
})

test('completed and cancelled conversations preserve the report and remove run controls', () => {
  setUiLanguage('en')
  for (const cancelled of [false, true]) {
    const html = render({
      status: 'done',
      cancelled,
      finalReport: '**All results retained**',
      finalReportPath: '/project/report.md',
      finalReportTruncated: true,
      finalReportBytes: 3200,
      steers: [{ text: 'Please also check the chart' }]
    })
    assert.match(html, /All results retained/)
    assert.match(html, /Full report saved/)
    assert.match(html, /\/project\/report.md/)
    assert.match(html, /Please also check the chart/)
    assert.doesNotMatch(html, /data-phi-composer-action="stop"/)
    if (cancelled) assert.match(html, /Cancelled/)
  }
})

test('failed conversations retain failed tool details and the run error', () => {
  const html = render({
    status: 'error',
    error: 'Agent failed to finish',
    steps: [
      {
        id: 'step-1',
        toolName: 'bash',
        argsPreview: 'run-script',
        argsJson: '{"command":"run-script"}',
        output: 'diagnostic-output',
        status: 'error',
        error: 'command exited with code 1'
      }
    ]
  })
  assert.match(html, /Expand processing details/)
  assert.doesNotMatch(html, /diagnostic-output/)
  assert.match(html, /command exited with code 1/)
  assert.match(html, /Agent failed to finish/)
})

test('both languages retain assigned content while translating temporary-conversation labels', () => {
  setUiLanguage('zh-CN')
  const html = render()
  assert.match(html, /Agent 临时会话/)
  assert.match(html, /Full assigned command/)
  assert.match(render({}, true), /打开 Researcher 的会话/)
  setUiLanguage('en')
})

test('legacy and malformed arguments fall back to the recorded task without dumping JSON', () => {
  for (const argsJson of ['', '{broken', 'null', '[]', '{}', '{"task":3}', '{"task":"  "}']) {
    assert.equal(subagentPrompt({ task: 'Retained assignment', argsJson }), 'Retained assignment')
  }
  assert.equal(
    subagentPrompt({ task: 'Preview', argsJson: '{"task":" full\\ncommand "}' }),
    ' full\ncommand '
  )
})

test('child tool executions use the ordinary folded processing group and composer', () => {
  setUiLanguage('en')
  const html = render({
    createdAt: '2026-11-06T00:00:00Z',
    steps: [
      {
        id: 'step-1',
        toolName: 'bash',
        argsPreview: 'run-script',
        argsJson: '{}',
        output: 'hidden-child-tool-output',
        status: 'running'
      }
    ]
  })
  assert.match(html, /Expand processing details/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /data-phi-composer-editor="codemirror"/)
  assert.doesNotMatch(html, /hidden-child-tool-output/)
})

test('projection preserves tool identity, output metadata, ordering, and run timing', () => {
  const createdAt = '2026-11-06T00:00:00Z'
  const completedAt = '2026-11-06T00:00:10Z'
  const steps: AgentExecutionItem['steps'] = [
    {
      id: 'tool-before',
      toolName: 'read',
      argsPreview: 'file',
      argsJson: '{}',
      status: 'done',
      output: 'preview',
      outputPath: '/project/output.txt',
      outputBytes: 8000,
      outputTruncated: true,
      outputArtifact: { kind: 'tool_output', path: '/project/output.txt', bytes: 8000 },
      createdAt: '2026-11-06T00:00:01Z',
      completedAt: '2026-11-06T00:00:02Z',
      durationMs: 1000
    },
    {
      id: 'tool-after',
      toolName: 'bash',
      argsPreview: 'test',
      argsJson: '{}',
      output: 'done',
      status: 'done',
      createdAt: '2026-11-06T00:00:05Z',
      completedAt: '2026-11-06T00:00:08Z'
    }
  ]
  const messages = subagentSessionMessages({
    ...item,
    status: 'done',
    createdAt,
    completedAt,
    durationMs: 10000,
    steps,
    steers: [{ text: 'Also check outputs', createdAt: '2026-11-06T00:00:04Z' }],
    finalReport: 'Complete'
  })
  assert.deepEqual(
    messages.map((message) => message.id),
    [
      'delegation-1:assignment',
      'delegation-1:started',
      'tool-before',
      'delegation-1:steer:0',
      'tool-after',
      'delegation-1:ended',
      'delegation-1:report'
    ]
  )
  assert.deepEqual(messages[2], { ...steps[0], role: 'tool', runId: item.agentRunId })
  assert.deepEqual(messages.at(-2), {
    id: 'delegation-1:ended',
    role: 'run',
    event: 'completed',
    runId: item.agentRunId,
    createdAt: completedAt,
    durationMs: 10000
  })
  assert.equal(messages.at(-1)?.role, 'assistant')
})
