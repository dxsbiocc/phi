import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { TaskEventResult } from '../src/shared/taskEventTypes'
import type { ChatQueueReceipt } from '../src/shared/chatQueueTypes'
import type { ToolApprovalRequest } from '../src/main/agent/tool-approval'
import type { AssistantInboxEntry } from '../src/main/session-runtime/assistant-inbox'
import { parseTaskEvent, resolveTaskTargets } from '../src/main/session-runtime/task-event-router'
import { createTaskEventService } from '../src/main/session-runtime/task-event-service'
import { taskSupplementPrompt } from '../src/main/session-runtime/task-supplement-prompt'

const leftId = 'abcdef01-2222-4333-8444-555555555555'
const peerId = 'abcdef01-aaaa-4bbb-8ccc-dddddddddddd'
const runnerRight = randomUUID()
const runnerLeft = randomUUID()

test('standalone English, Chinese and explicit task commands share a deterministic route', () => {
  assert.deepEqual(parseTaskEvent('/TASKS '), { kind: 'list' })
  assert.deepEqual(parseTaskEvent('status of task ABCDEF01'), {
    kind: 'status',
    target: 'ABCDEF01'
  })
  assert.deepEqual(parseTaskEvent(`查看任务 ${leftId} 的状态`), { kind: 'status', target: leftId })
  assert.deepEqual(parseTaskEvent('停止上一个任务'), { kind: 'cancel' })
  assert.deepEqual(parseTaskEvent('cancel task'), { kind: 'cancel' })
  assert.deepEqual(parseTaskEvent('批准这个任务'), { kind: 'approve' })
  assert.deepEqual(parseTaskEvent('补充这个任务：请先确认输入'), {
    kind: 'supplement',
    text: '请先确认输入'
  })
  assert.deepEqual(parseTaskEvent('Add to that task: confirm the input'), {
    kind: 'supplement',
    text: 'confirm the input'
  })
  assert.deepEqual(parseTaskEvent('补充任务 abcdef01：只用本地数据\n保留原文件'), {
    kind: 'supplement',
    target: 'abcdef01',
    text: '只用本地数据\n保留原文件'
  })
  assert.deepEqual(parseTaskEvent(`/task approve ${leftId} approval-1`), {
    kind: 'approve',
    target: leftId,
    approvalId: 'approval-1'
  })
})

test('quoted, embedded and past-tense commands stay ordinary messages', () => {
  for (const message of [
    'yes',
    '批准',
    `I ran /task cancel ${leftId}`,
    `"/task cancel ${leftId}"`,
    `\`\`\`text\n/task approve ${leftId}\n\`\`\``,
    'https://example.org/task',
    'Cancel the task if the changes are unsafe.',
    'The job used the /task status command',
    '批准后的任务如何归档'
  ]) {
    assert.deepEqual(parseTaskEvent(message), { kind: 'new-task' }, message)
  }
})

test('malformed and multiline controls clarify without taking an action', () => {
  for (const message of [
    '/task',
    '/tasks extra',
    '/task add abcdef01',
    '/task cancel abcd',
    '/task cancel abcdef012',
    `/task cancel ${leftId} and something else`,
    `/task cancel\n${leftId}`,
    `/task cancel \n${leftId}`,
    `/task\n cancel ${leftId}`,
    `/task approve ${leftId}\nother-approval`,
    '/task approve abcdef01 approval-1',
    '取消任务 工作区',
    'cancel task unknown'
  ]) {
    assert.deepEqual(parseTaskEvent(message), { kind: 'clarify' }, message)
  }
})

test('prefix matches preserve collisions and resolve a canonical exact ID case-insensitively', () => {
  const tasks = [{ id: leftId }, { id: peerId }]
  assert.deepEqual(resolveTaskTargets(tasks, 'ABCDEF01'), tasks)
  assert.deepEqual(resolveTaskTargets(tasks, leftId.toUpperCase()), [tasks[0]])
  assert.deepEqual(resolveTaskTargets(tasks, 'abcdef012'), [])
  assert.deepEqual(resolveTaskTargets(tasks, 'abcdef01-2222-5'), [])
})

const receipt: ChatQueueReceipt = {
  id: randomUUID(),
  sessionId: 'left',
  path: '/left',
  sessionGeneration: 3
}

function routeFixture(): {
  left: AssistantInboxEntry
  right: AssistantInboxEntry
  owners: Map<string, string>
  active: Map<string, string>
  proofs: string[]
  setEntries(snapshot: AssistantInboxEntry[]): void
  route(
    text: string,
    target?: unknown,
    authorize?: () => void,
    owner?: object
  ): Promise<TaskEventResult>
} {
  const left: AssistantInboxEntry = {
    id: leftId,
    requestId: randomUUID(),
    scope: { conversationId: 'left', projectId: 'left-project' },
    status: 'running',
    attemptId: runnerLeft,
    text: 'previous job api_key=\u0022private-credential\u0022',
    order: 0
  }
  const right: AssistantInboxEntry = {
    ...left,
    id: peerId,
    requestId: randomUUID(),
    scope: { conversationId: 'right', projectId: 'right-project' },
    attemptId: runnerRight,
    text: 'different job',
    order: 1
  }
  let entries = [left, right]
  const proofs: string[] = []
  const responder = {}
  const approvals = new Map<string, ToolApprovalRequest>([
    [
      'left-approval',
      {
        requestId: 'left-approval',
        sessionId: 'left',
        runId: runnerLeft,
        toolName: 'write',
        summary: 'left.txt'
      }
    ],
    [
      'right-approval',
      {
        requestId: 'right-approval',
        sessionId: 'right',
        runId: runnerRight,
        toolName: 'write',
        summary: 'right.txt'
      }
    ],
    [
      'old-left-approval',
      {
        requestId: 'old-left-approval',
        sessionId: 'left',
        runId: randomUUID(),
        toolName: 'write',
        summary: 'stale.txt'
      }
    ]
  ])
  const active = new Map([
    ['left', runnerLeft],
    ['right', runnerRight]
  ])
  const owners = new Map([
    ['left', 'left-project'],
    ['right', 'right-project']
  ])
  const service = createTaskEventService({
    queue: {
      async submit(input, target) {
        proofs.push(`submit:${input}:${JSON.stringify(target)}`)
        return receipt
      },
      async taskEntries() {
        return entries
      },
      async supplement(parent, text, _images, _id, authorize) {
        authorize()
        proofs.push(`supplement:${parent.scope.conversationId}:${parent.id}:${text}`)
        return receipt
      },
      async cancel(session, id) {
        proofs.push(`cancel:${session}:${id}`)
        return true
      }
    },
    owner(session) {
      const projectId = owners.get(session)
      return projectId ? { projectId, title: session } : null
    },
    activeRun(entry) {
      const live = active.get(entry.scope.conversationId)
      return live === entry.attemptId ? live : undefined
    },
    async stop(runId) {
      proofs.push(`stop:${runId}`)
    },
    approvals(session, run, sender) {
      if (sender !== responder) return []
      return [...approvals.values()].filter(
        (item) => item.sessionId === session && item.runId === run
      )
    },
    respond(id, answer, sender) {
      if (sender !== responder || !approvals.delete(id)) return false
      proofs.push(`approval:${id}:${answer}`)
      return true
    }
  })
  return {
    left,
    right,
    owners,
    active,
    proofs,
    setEntries: (snapshot: AssistantInboxEntry[]) => {
      entries = snapshot
    },
    route: (
      text: string,
      target: unknown = { phiSessionId: 'right' },
      authorize = () => undefined,
      owner = responder
    ) => service.route(text, target, randomUUID(), { responder: owner, authorize })
  }
}

test('only ordinary messages are submitted as independent prompts', async () => {
  const f = routeFixture()
  const result = await f.route('A new task')
  assert.deepEqual(result, { kind: 'submitted', receipt })
  assert.deepEqual(f.proofs, ['submit:A new task:{"phiSessionId":"right"}'])
})

test('a missing or colliding target never chooses a run, even with one actionable candidate', async () => {
  const f = routeFixture()
  f.setEntries([f.left, { ...f.right, status: 'succeeded' }])
  assert.equal((await f.route('/task cancel')).kind, 'clarify')
  assert.equal((await f.route('补充这个任务：保留草稿')).kind, 'clarify')
  const collided = await f.route('/task cancel abcdef01')
  assert.equal(collided.kind, 'clarify')
  assert.equal(collided.kind === 'clarify' && collided.reason, 'ambiguous')
  assert.deepEqual(f.proofs, [])
})

test('task status is scoped to the saved owner and omits credentials', async () => {
  const f = routeFixture()
  const result = await f.route(`/task status ${leftId}`)
  assert.equal(result.kind, 'status')
  assert.equal(result.kind === 'status' && result.task.sessionId, 'left')
  assert.equal(result.kind === 'status' && result.task.status, 'needs_approval')
  assert.equal(JSON.stringify(result).includes('private-credential'), false)
  f.owners.set('left', 'reassigned-project')
  assert.equal((await f.route(`/task status ${leftId}`)).kind, 'clarify')
})

test('queued cancellation and a live stop only act on the matching session and attempt', async () => {
  const f = routeFixture()
  f.setEntries([{ ...f.left, status: 'queued', attemptId: undefined }, f.right])
  assert.equal((await f.route(`/task cancel ${leftId}`)).kind, 'cancelled')
  assert.deepEqual(f.proofs, [`cancel:left:${leftId}`])
  f.setEntries([f.left, f.right])
  f.active.set('left', randomUUID())
  assert.equal((await f.route(`/task cancel ${leftId}`)).kind, 'unavailable')
  assert.equal((await f.route(`/task cancel ${peerId}`)).kind, 'stopping')
  assert.deepEqual(f.proofs, [`cancel:left:${leftId}`, `stop:${runnerRight}`])
})

test('approval previews and decisions cannot resolve a different job or a stale run', async () => {
  const f = routeFixture()
  const preview = await f.route(`/task approve ${leftId}`)
  assert.equal(preview.kind, 'approval')
  assert.deepEqual(preview.kind === 'approval' && preview.requests.map((item) => item.id), [
    'left-approval'
  ])
  for (const approval of ['old-left-approval', 'right-approval']) {
    assert.equal((await f.route(`/task approve ${leftId} ${approval}`)).kind, 'unavailable')
  }
  assert.equal(
    (await f.route(`/task approve ${leftId} left-approval`, null, undefined, {})).kind,
    'unavailable'
  )
  assert.deepEqual(f.proofs, [])
  assert.equal((await f.route(`/task approve ${leftId} left-approval`)).kind, 'decided')
  assert.equal((await f.route(`/task approve ${leftId} left-approval`)).kind, 'unavailable')
  assert.equal((await f.route(`/task deny ${peerId} right-approval`)).kind, 'decided')
  assert.deepEqual(f.proofs, ['approval:left-approval:true', 'approval:right-approval:false'])
})

test('a composer that loses authority while resolving a target cannot take action', async () => {
  const f = routeFixture()
  await assert.rejects(
    f.route(`/task cancel ${leftId}`, null, () => {
      throw new Error('renderer replaced')
    }),
    /renderer replaced/
  )
  assert.deepEqual(f.proofs, [])
})

test('an explicit supplement targets the saved origin and controls preserve attached drafts', async () => {
  const f = routeFixture()
  const target = { phiSessionId: 'right', images: [{ data: 'fixture' }] }
  assert.equal((await f.route(`/task cancel ${leftId}`, target)).kind, 'clarify')
  assert.deepEqual(f.proofs, [])
  assert.equal((await f.route(`/task add ${leftId} more constraints`, target)).kind, 'supplemented')
  assert.deepEqual(f.proofs, [`supplement:left:${leftId}:more constraints`])
})

test('a supplemental model prompt references the exact archived user request as context', () => {
  const { left } = routeFixture()
  const event = {
    type: 'user_message',
    eventId: 'user',
    sessionId: left.scope.conversationId,
    createdAt: '2026-11-19'
  }
  const wrong = { ...event, submissionId: left.id, runId: runnerRight, content: 'unrelated text' }
  assert.equal(taskSupplementPrompt(left, 'additional details', [wrong]), undefined)
  const result = taskSupplementPrompt(left, 'additional details', [
    wrong,
    { ...event, submissionId: left.id, runId: runnerLeft, content: 'original request' }
  ])
  assert.match(result ?? '', /original request/)
  assert.match(result ?? '', /additional details/)
  assert.match(result ?? '', new RegExp(left.id))
  assert.doesNotMatch(result ?? '', /unrelated text/)
})
