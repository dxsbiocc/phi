import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import {
  waitForAgentUserInteraction,
  resolveAgentUserInteraction
} from '../../src/main/agent/user-interaction'
import type {
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../../src/shared/agentInteractionTypes'
import {
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'

class InteractionWindow extends EventEmitter {
  readonly requests: AgentUserInteractionRequest[] = []
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, request: AgentUserInteractionRequest): void => {
      this.requests.push(request)
    }
  })
  isDestroyed(): boolean {
    return false
  }
}
async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    assert.ok(Date.now() - start < 15000, 'interaction request never arrived')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function answer(request: AgentUserInteractionRequest, text: string): AgentUserInteractionResponse {
  return {
    requestId: request.requestId,
    answers: [
      { questionIndex: 0, question: request.questions[0].question, kind: 'option', answer: text }
    ]
  }
}
export async function runApplicationInteractionScenario(
  f: FacadeMetadataFixture,
  mode: string
): Promise<void> {
  const window = new InteractionWindow()
  f.engine.host.register('agentInteraction.request', async (params, context) => {
    const request = params as {
      runtimeSessionId: string
      questions: AgentUserInteractionRequest['questions']
    }
    assert.equal(request.runtimeSessionId, context.originSessionId)
    assert.equal(Object.hasOwn(request, 'signal'), false)
    const run = f.runners.getActiveRun(f.phi.sessionId)!
    const requestId = randomUUID()
    f.runners.markNeedsInput(f.phi.sessionId, requestId, {
      kind: 'ask_user_question',
      message: request.questions[0].question
    })
    const result = await waitForAgentUserInteraction(
      {
        requestId,
        questions: request.questions,
        sessionId: f.phi.sessionId,
        runId: run.runId,
        sessionPath: `phi-session:${f.phi.sessionId}`,
        cwd: f.f.scope.projectRoot
      },
      window as unknown as Parameters<typeof waitForAgentUserInteraction>[1],
      [context.signal]
    )
    if (result.cancelled || context.signal?.aborted)
      f.runners.markInputCancelled(f.phi.sessionId, requestId)
    else f.runners.markInputAnswered(f.phi.sessionId, requestId)
    return result
  })
  let proxy = (await f.createApplicationSession()).session
  try {
    f.provider.enqueue(
      {
        tool: {
          name: 'ask_user_question',
          args: {
            questions: [
              {
                header: 'Output',
                question: 'Which remote result?',
                options: [
                  { label: 'Report', description: 'Use the report' },
                  { label: 'Table', description: 'Use the table' }
                ]
              }
            ]
          }
        }
      },
      ...(mode === 'interaction-flow'
        ? [
            { tool: { name: 'palette_suggest', args: { use: 'categorical', limit: 1 } } },
            {
              tool: {
                name: 'render_blocks',
                args: {
                  blocks: [
                    {
                      type: 'table',
                      title: 'Result',
                      columns: [{ key: 'name', label: 'Name' }],
                      rows: [{ name: 'chosen remote report' }]
                    }
                  ]
                }
              }
            }
          ]
        : []),
      { text: 'Interaction settled' }
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Ask which result, then show the palette and structured result')
    })
    await until(() => window.requests.length === 1)
    const request = window.requests[0]
    assert.equal(request.sessionId, f.phi.sessionId)
    assert.equal(request.runId, run.runId)
    assert.equal(request.cwd, f.f.scope.projectRoot)
    let peer: Promise<AgentUserInteractionResponse> | undefined
    if (mode === 'interaction-stop') {
      peer = waitForAgentUserInteraction(
        { requestId: 'independent-peer-ui', questions: request.questions, sessionId: 'peer-phi' },
        window as unknown as Parameters<typeof waitForAgentUserInteraction>[1]
      )
      f.runners.stopRun(f.phi.sessionId)
      await proxy.abort()
      resolveAgentUserInteraction(request.requestId, answer(request, 'LATE_USER_ANSWER'))
      const peerRequest = window.requests[1]
      resolveAgentUserInteraction(peerRequest.requestId, answer(peerRequest, 'Peer answer'))
      assert.equal((await peer).answers[0].answer, 'Peer answer')
    } else resolveAgentUserInteraction(request.requestId, answer(request, 'Report'))
    await run.done
    const events = readSessionEvents(f.phi.sessionId)
    if (mode === 'interaction-flow') {
      assert.match(
        JSON.stringify(f.provider.requests.at(-1)?.messages),
        /Report|chosen remote report/
      )
      assert.match(JSON.stringify(proxy.messages), /ui_blocks|chosen remote report/)
      assert.match(JSON.stringify(proxy.messages), /Qualitative.Safe/)
      assert.equal(events.filter((event) => event.type === 'input_answered').length, 1)
      const before = f.provider.requests.length
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      await proxy.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.equal(f.provider.requests.length, before)
      assert.equal(window.requests.length, 1, 'restore does not replay the question')
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        reference.journalBasename
      )
    } else {
      assert.doesNotMatch(JSON.stringify(events), /LATE_USER_ANSWER/)
      assert.equal(events.filter((event) => event.type === 'input_cancelled').length, 1)
      assert.equal(events.filter((event) => event.type === 'input_answered').length, 0)
    }
    assert.equal(events.filter((event) => event.type === 'approval_requested').length, 0)
  } finally {
    await proxy.dispose()
  }
}
