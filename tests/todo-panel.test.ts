import assert from 'node:assert/strict'
import test from 'node:test'
import { extractTodoSnapshot, isTodoToolName } from '../src/renderer/src/lib/chatItems'
import {
  isClosedTodoTask,
  latestTodoSnapshot,
  nextActionableTodoTask,
  todoProgress,
  todoStatusLabel
} from '../src/renderer/src/lib/todoPanel'
import type { ChatItem } from '../src/renderer/src/types'
import type { TodoSnapshot } from '../src/renderer/src/lib/todoTypes'

test('isTodoToolName recognizes the todo tool only', () => {
  assert.equal(isTodoToolName('todo'), true)
  assert.equal(isTodoToolName('todowrite'), false)
  assert.equal(isTodoToolName('bash'), false)
})

test('extractTodoSnapshot reads the TodoToolDetails phases/op convention', () => {
  assert.deepEqual(
    extractTodoSnapshot({
      content: [{ type: 'text', text: 'Todo updated' }],
      details: {
        op: 'start',
        storage: 'session',
        phases: [
          {
            name: 'Foundation',
            tasks: [
              { content: 'Read the CSV', status: 'completed' },
              { content: 'Fit the model', status: 'in_progress' },
              { content: 'Plot residuals', status: 'pending' }
            ]
          }
        ]
      }
    }),
    {
      op: 'start',
      phases: [
        {
          name: 'Foundation',
          tasks: [
            { content: 'Read the CSV', status: 'completed' },
            { content: 'Fit the model', status: 'in_progress' },
            { content: 'Plot residuals', status: 'pending' }
          ]
        }
      ]
    }
  )
})

test('extractTodoSnapshot keeps a blocked task blocker note and drops malformed tasks', () => {
  const snapshot = extractTodoSnapshot({
    details: {
      phases: [
        {
          name: 'Foundation',
          tasks: [
            { content: 'Fetch upstream data', status: 'blocked', blocker: '等待数据库连接器修复' },
            { content: 'missing status' },
            { status: 'pending' },
            'not an object'
          ]
        }
      ]
    }
  })

  assert.deepEqual(snapshot, {
    phases: [
      {
        name: 'Foundation',
        tasks: [
          { content: 'Fetch upstream data', status: 'blocked', blocker: '等待数据库连接器修复' }
        ]
      }
    ]
  })
})

test('extractTodoSnapshot ignores results that carry no phases', () => {
  assert.equal(extractTodoSnapshot(undefined), undefined)
  assert.equal(extractTodoSnapshot({ content: [] }), undefined)
  assert.equal(extractTodoSnapshot({ details: { storage: 'session' } }), undefined)
})

function toolItem(overrides: Partial<Extract<ChatItem, { role: 'tool' }>> = {}): ChatItem {
  return {
    id: 'call-1',
    role: 'tool',
    toolName: 'bash',
    argsPreview: '',
    argsJson: '',
    output: '',
    status: 'done',
    ...overrides
  }
}

const snapshotA: TodoSnapshot = {
  op: 'init',
  phases: [
    {
      name: 'Foundation',
      tasks: [
        { content: 'Read the CSV', status: 'pending' },
        { content: 'Fit the model', status: 'pending' }
      ]
    }
  ]
}

const snapshotB: TodoSnapshot = {
  op: 'start',
  phases: [
    {
      name: 'Foundation',
      tasks: [
        { content: 'Read the CSV', status: 'completed' },
        { content: 'Fit the model', status: 'in_progress' }
      ]
    }
  ]
}

test('latestTodoSnapshot returns the most recent todo call, not an earlier one', () => {
  const items: ChatItem[] = [
    toolItem({ id: 'call-1', toolName: 'todo', todo: snapshotA }),
    toolItem({ id: 'call-2', toolName: 'read' }),
    toolItem({ id: 'call-3', toolName: 'todo', todo: snapshotB })
  ]

  assert.deepEqual(latestTodoSnapshot(items), snapshotB)
})

test('latestTodoSnapshot ignores a running todo call that has not attached a snapshot yet', () => {
  const items: ChatItem[] = [
    toolItem({ id: 'call-1', toolName: 'todo', todo: snapshotA }),
    toolItem({ id: 'call-2', toolName: 'todo', status: 'running' })
  ]

  assert.deepEqual(latestTodoSnapshot(items), snapshotA)
})

test('latestTodoSnapshot returns undefined when the conversation has no todo calls', () => {
  assert.equal(latestTodoSnapshot([toolItem({ toolName: 'read' })]), undefined)
  assert.equal(latestTodoSnapshot([]), undefined)
})

test('todoProgress counts completed/abandoned as closed and totals every task', () => {
  const snapshot: TodoSnapshot = {
    phases: [
      {
        name: 'Foundation',
        tasks: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'abandoned' },
          { content: 'c', status: 'in_progress' },
          { content: 'd', status: 'pending' },
          { content: 'e', status: 'blocked' }
        ]
      }
    ]
  }

  assert.deepEqual(todoProgress(snapshot), {
    total: 5,
    completed: 2,
    currentTask: { content: 'c', status: 'in_progress' }
  })
})

test('nextActionableTodoTask prefers the in-progress task over the first pending one', () => {
  assert.deepEqual(nextActionableTodoTask(snapshotB.phases), {
    content: 'Fit the model',
    status: 'in_progress'
  })
  assert.deepEqual(nextActionableTodoTask(snapshotA.phases), {
    content: 'Read the CSV',
    status: 'pending'
  })
})

test('isClosedTodoTask treats only completed and abandoned as settled', () => {
  assert.equal(isClosedTodoTask({ content: 'a', status: 'completed' }), true)
  assert.equal(isClosedTodoTask({ content: 'a', status: 'abandoned' }), true)
  assert.equal(isClosedTodoTask({ content: 'a', status: 'pending' }), false)
  assert.equal(isClosedTodoTask({ content: 'a', status: 'in_progress' }), false)
  assert.equal(isClosedTodoTask({ content: 'a', status: 'blocked' }), false)
})

test('todoStatusLabel covers every TodoTaskStatus', () => {
  assert.equal(todoStatusLabel('pending'), '待办')
  assert.equal(todoStatusLabel('in_progress'), '进行中')
  assert.equal(todoStatusLabel('completed'), '已完成')
  assert.equal(todoStatusLabel('abandoned'), '已放弃')
  assert.equal(todoStatusLabel('blocked'), '已阻塞')
})
