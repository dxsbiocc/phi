import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAskUserQuestionCustomTools,
  type UserInteractionToolRequest
} from '../src/main/agent/user-interaction-tools'
import type { PhiToolContent, PhiToolContext } from '../src/main/agent/engine/types'

const TOOL_CONTEXT: PhiToolContext = {
  cwd: process.cwd(),
  recentUserImages: () => []
}

function textAt(content: PhiToolContent[], index = 0): string {
  const part = content[index]
  return part?.type === 'text' ? part.text : ''
}

test('ask_user_question tool forwards structured questions and formats the answer envelope', async () => {
  const calls: UserInteractionToolRequest[] = []
  const [tool] = buildAskUserQuestionCustomTools('runtime-1', async (request) => {
    calls.push(request)
    return {
      requestId: 'request-1',
      answers: [
        {
          questionIndex: 0,
          question: 'Where should I write the file?',
          kind: 'option',
          answer: 'Project root (Recommended)',
          preview: 'Writes to ./output.txt'
        }
      ],
      globalNote: 'Keep the path simple.'
    }
  })

  assert.equal(tool.name, 'ask_user_question')
  assert.equal(tool.loadMode, 'essential')
  assert.equal(tool.strict, true)

  const result = await tool.execute(
    'call-1',
    {
      questions: [
        {
          header: 'Output',
          question: 'Where should I write the file?',
          options: [
            {
              label: 'Project root (Recommended)',
              description: 'Use the current project root.',
              preview: 'Writes to ./output.txt'
            },
            {
              label: 'Temp',
              description: 'Use a temporary directory.'
            }
          ]
        }
      ]
    },
    undefined,
    TOOL_CONTEXT
  )

  assert.deepEqual(calls, [
    {
      runtimeSessionId: 'runtime-1',
      questions: [
        {
          header: 'Output',
          question: 'Where should I write the file?',
          options: [
            {
              label: 'Project root (Recommended)',
              description: 'Use the current project root.',
              preview: 'Writes to ./output.txt'
            },
            {
              label: 'Temp',
              description: 'Use a temporary directory.'
            }
          ]
        }
      ]
    }
  ])
  assert.match(textAt(result.content), /^User has answered your questions:/)
  assert.match(textAt(result.content), /"Where should I write the file\?"/)
  assert.match(textAt(result.content), /selected preview: Writes to \.\/output\.txt/)
  assert.match(textAt(result.content), /global note: Keep the path simple\./)
  assert.ok(result.details && typeof result.details === 'object' && 'cancelled' in result.details)
  assert.equal(result.details.cancelled, false)
})

test('ask_user_question tool rejects reserved option labels before opening UI', async () => {
  let called = false
  const [tool] = buildAskUserQuestionCustomTools('runtime-1', async () => {
    called = true
    return { answers: [] }
  })

  const result = await tool.execute(
    'call-1',
    {
      questions: [
        {
          header: 'Output',
          question: 'Where should I write the file?',
          options: [
            {
              label: 'Other',
              description: 'Reserved by the UI.'
            },
            {
              label: 'Temp',
              description: 'Use a temporary directory.'
            }
          ]
        }
      ]
    },
    undefined,
    TOOL_CONTEXT
  )

  assert.equal(called, false)
  assert.ok(
    result.details &&
      typeof result.details === 'object' &&
      'cancelled' in result.details &&
      'error' in result.details
  )
  assert.equal(result.details.cancelled, true)
  assert.equal(result.details.error, 'reserved_label')
  assert.match(textAt(result.content), /Option label is reserved/)
})
