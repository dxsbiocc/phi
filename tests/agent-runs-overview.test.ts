import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentRunLostKey,
  agentRunOverviewLabel,
  centeredScrollTop,
  formatAgentDuration,
  groupIndexContainingItem,
  runningAgentRuns,
  virtualRowScrollTop
} from '../src/renderer/src/lib/agentRunsOverview'
import type { RenderGroup } from '../src/renderer/src/lib/chatRenderGroups'
import { useLostAgentRunsStore } from '../src/renderer/src/stores/lostAgentRunsStore'
import type {
  AgentExecutionItem,
  AgentExecutionStep
} from '../src/renderer/src/lib/agentExecutionTypes'
import type { ChatItem } from '../src/renderer/src/types'

const step = (overrides: Partial<AgentExecutionStep> = {}): AgentExecutionStep => ({
  id: 's1',
  toolName: 'read',
  argsPreview: '',
  argsJson: '',
  output: '',
  status: 'done',
  ...overrides
})

const card = (overrides: Partial<AgentExecutionItem> = {}): AgentExecutionItem => ({
  id: 'call-1',
  role: 'agent_execution',
  agentName: 'Wrapper',
  task: 'align the reads',
  argsPreview: '',
  argsJson: '',
  status: 'running',
  steps: [],
  agentRunId: 'run_1',
  agentSessionId: 'runtime-1',
  createdAt: '2026-09-20T10:00:00.000Z',
  ...overrides
})

// ── which agents are running ─────────────────────────────────────────────

test('only running agent cards are listed, in timeline order', () => {
  const messages: ChatItem[] = [
    { id: 'u1', role: 'user', content: 'go' } as ChatItem,
    card({ id: 'call-1', agentName: 'Wrapper' }),
    card({ id: 'call-2', agentName: 'Database', status: 'done' }),
    card({ id: 'call-3', agentName: 'Database', status: 'error' }),
    card({ id: 'call-4', agentName: 'Wrapper', agentRunId: 'run_4' })
  ]
  assert.deepEqual(
    runningAgentRuns(messages, new Set()).map((entry) => entry.id),
    ['call-1', 'call-4']
  )
})

test('an entry carries what the overview shows and what steering needs', () => {
  const [entry] = runningAgentRuns(
    [
      card({
        background: true,
        steps: [
          step({ id: 's1', toolName: 'read', status: 'done' }),
          step({ id: 's2', toolName: 'wrapper_run', status: 'running' })
        ]
      })
    ],
    new Set()
  )
  assert.equal(entry.agentName, 'Wrapper')
  assert.equal(entry.task, 'align the reads')
  assert.equal(entry.background, true)
  assert.equal(entry.stepCount, 2)
  assert.equal(entry.currentStep, 'wrapper_run')
  assert.equal(entry.startedAt, '2026-09-20T10:00:00.000Z')
  assert.deepEqual(entry.control, { agentRunId: 'run_1', agentSessionId: 'runtime-1' })
})

test('a wrapper agent entry carries the latest visible Nextflow run id', () => {
  const [entry] = runningAgentRuns(
    [
      card({
        steps: [
          step({
            id: 's1',
            toolName: 'wrapper_run',
            output: 'Started wrapper run wrun_fastqc_1 in the background.'
          }),
          step({
            id: 's2',
            toolName: 'wrapper_status',
            argsJson: '{"run_id":"wrun_fastqc_1"}',
            output: 'state: running'
          })
        ]
      })
    ],
    new Set()
  )

  assert.equal(entry.wrapperRunId, 'wrun_fastqc_1')
})

test('the current step is the last one when none is running, and absent before the first', () => {
  const [finishedSteps] = runningAgentRuns(
    [card({ steps: [step({ toolName: 'read' }), step({ id: 's2', toolName: 'grep' })] })],
    new Set()
  )
  assert.equal(finishedSteps.currentStep, 'grep')
  const [noSteps] = runningAgentRuns([card()], new Set())
  assert.equal(noSteps.currentStep, undefined)
  assert.equal(noSteps.stepCount, 0)
})

test('a run whose worker session is gone is not listed', () => {
  const lost = new Set([agentRunLostKey({ agentSessionId: 'runtime-1', agentRunId: 'run_1' })])
  assert.deepEqual(
    runningAgentRuns([card(), card({ id: 'call-2', agentRunId: 'run_2' })], lost).map(
      (entry) => entry.id
    ),
    ['call-2']
  )
})

test('a running card that does not know its run is listed but cannot be controlled', () => {
  const [entry] = runningAgentRuns([card({ agentRunId: undefined })], new Set())
  assert.equal(entry.control, null)
})

test('the lost key tells runs apart across sessions', () => {
  assert.notEqual(
    agentRunLostKey({ agentSessionId: 'a', agentRunId: 'run_1' }),
    agentRunLostKey({ agentSessionId: 'b', agentRunId: 'run_1' })
  )
})

// ── finding a card in the render groups ──────────────────────────────────

const groups: RenderGroup[] = [
  { kind: 'single', key: 'u1', item: { id: 'u1', role: 'user', content: 'go' } as never },
  {
    kind: 'processing-group',
    key: 'p1',
    items: [card({ id: 'call-1' }), card({ id: 'call-2' })]
  },
  { kind: 'single', key: 'a1', item: card({ id: 'call-9' }) as never },
  { kind: 'tool-group', key: 't1', items: [{ id: 'tool-1', role: 'tool' } as never] }
]

test('the group holding a card is found, whatever kind of group it is', () => {
  assert.equal(groupIndexContainingItem(groups, 'call-2'), 1)
  assert.equal(groupIndexContainingItem(groups, 'call-9'), 2)
  assert.equal(groupIndexContainingItem(groups, 'tool-1'), 3)
  assert.equal(groupIndexContainingItem(groups, 'u1'), 0)
  assert.equal(groupIndexContainingItem(groups, 'nope'), -1)
})

// ── scrolling to a row of the virtual list ───────────────────────────────

test('the scroll position of a row is the list’s own offset plus the row’s, minus a margin', () => {
  const offsets = [0, 100, 260, 400]
  assert.equal(virtualRowScrollTop(offsets, 2, 24, 16), 24 + 260 - 16)
  assert.equal(virtualRowScrollTop(offsets, 0, 0, 16), 0, 'never above the top')
  assert.equal(virtualRowScrollTop(offsets, 9, 0), 0, 'an unknown row does not move the view')
})

// ── labels ───────────────────────────────────────────────────────────────

test('the overview button names how many agents are running', () => {
  assert.equal(agentRunOverviewLabel(1), '1 个 Agent 运行中')
  assert.equal(agentRunOverviewLabel(3), '3 个 Agent 运行中')
})

test('durations read as seconds, minutes, hours', () => {
  assert.equal(formatAgentDuration(400), '1 秒')
  assert.equal(formatAgentDuration(42_000), '42 秒')
  assert.equal(formatAgentDuration(125_000), '2 分钟 5 秒')
  assert.equal(formatAgentDuration(3_725_000), '1 小时 2 分钟 5 秒')
  assert.equal(formatAgentDuration(-5), '0 秒')
})

// ── the shared "run is gone" memory ──────────────────────────────────────

test('a run marked lost stays lost for everyone who looks, and the set is replaced, not mutated', () => {
  const store = useLostAgentRunsStore
  store.setState({ lost: new Set() })
  const before = store.getState().lost
  store.getState().markLost('runtime-1:run_1')
  const after = store.getState().lost
  assert.ok(after.has('runtime-1:run_1'))
  assert.notEqual(after, before, 'a new set, so subscribers re-render')
  assert.equal(before.has('runtime-1:run_1'), false)

  store.getState().markLost('runtime-1:run_1')
  assert.equal(store.getState().lost, after, 'marking twice changes nothing')
  store.setState({ lost: new Set() })
})

// ── centring a card in the chat ──────────────────────────────────────────

test('a card that fits is centred in the chat', () => {
  // Container: top 100, 600 tall, scrolled to 1000. Card: top 700 (600 below the container's top), 200 tall.
  assert.equal(
    centeredScrollTop({
      scrollTop: 1000,
      containerTop: 100,
      containerHeight: 600,
      elementTop: 700,
      elementHeight: 200
    }),
    1000 + 600 - (600 - 200) / 2
  )
})

test('a card taller than the chat is aligned to the top with a margin, and never above the start', () => {
  assert.equal(
    centeredScrollTop({
      scrollTop: 500,
      containerTop: 0,
      containerHeight: 400,
      elementTop: 300,
      elementHeight: 900
    }),
    500 + 300 - 16
  )
  assert.equal(
    centeredScrollTop({
      scrollTop: 0,
      containerTop: 0,
      containerHeight: 600,
      elementTop: 20,
      elementHeight: 100
    }),
    0
  )
})
