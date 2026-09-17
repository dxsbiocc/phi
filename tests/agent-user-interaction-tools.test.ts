import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAskUserQuestionCustomTools,
  type UserInteractionToolRequest
} from '../src/main/agent/user-interaction-tools'

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

  const result = await tool.execute('call-1', {
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
  })

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
  assert.match(result.content[0]?.text ?? '', /^User has answered your questions:/)
  assert.match(result.content[0]?.text ?? '', /"Where should I write the file\?"/)
  assert.match(result.content[0]?.text ?? '', /selected preview: Writes to \.\/output\.txt/)
  assert.match(result.content[0]?.text ?? '', /global note: Keep the path simple\./)
  assert.equal(result.details.cancelled, false)
})

test('ask_user_question tool rejects reserved option labels before opening UI', async () => {
  let called = false
  const [tool] = buildAskUserQuestionCustomTools('runtime-1', async () => {
    called = true
    return { answers: [] }
  })

  const result = await tool.execute('call-1', {
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
  })

  assert.equal(called, false)
  assert.equal(result.details.cancelled, true)
  assert.equal(result.details.error, 'reserved_label')
  assert.match(result.content[0]?.text ?? '', /Option label is reserved/)
})
