import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { isRecord } from '../src/shared/guards'
import { messageText } from './engine-contract/basic-suite'
import { createKernelFixture } from './engine-contract/kernel-factory'

const question = 'Can we fit a paired comparison? Keep the original donor design.'
const sheet = 'samples.tsv'
const raw = 'PRIVATE_SYNTHETIC_SAMPLE_ROW'

function toolResult(messages: unknown[] | undefined, id: string): Record<string, unknown> {
  const result = messages?.find(
    (item) => isRecord(item) && item.role === 'toolResult' && item.toolCallId === id
  )
  assert.ok(isRecord(result), `Missing tool result for ${id}`)
  return result
}

function blockedReport(answer: string): string {
  const research = {
    subquestion: 'Does the sample sheet contain the donor mapping?',
    answer,
    interpretation: 'The paired comparison needs donor identities.',
    rationale: 'Pause inference until the mapping is supplied.',
    evidence: [sheet]
  }
  return (
    '<phi_agent_result>' +
    JSON.stringify({ status: 'blocked', missingInputs: ['Donor mapping'], research }) +
    '</phi_agent_result>'
  )
}

test(
  'real kernel binds omitted questions across scientific delegations and resets on the next user turn',
  { timeout: 45_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    writeFileSync(join(f.cwd, sheet), 'sample\tcondition\n' + raw + '\tcontrol\n')
    const id = 'implicit-research-handoff'
    await f.createSession(id, { persistent: true })
    const sessionId = f.kernelSessionId(id)!
    const definition = {
      tools: ['read'],
      skills: [],
      visibility: 'entry',
      source: 'phi',
      warnings: [],
      description: 'Inspect requested files and report the outcome.',
      systemPrompt: 'Check only the approved metadata, then report the outcome.'
    }
    await f.client.request('session.open', {
      sessionId,
      resources: {
        resourceVersion: 'b'.repeat(64),
        phiAgents: [
          {
            ...definition,
            name: 'DifferentialExpression',
            handoff: 'research',
            filePath: join(f.cwd, 'DifferentialExpression.md')
          },
          { ...definition, name: 'Wrapper', filePath: join(f.cwd, 'Wrapper.md') }
        ]
      }
    })
    const events: unknown[] = []
    t.after(f.onSessionEvent(id, (event) => events.push(event)))
    f.provider.enqueue(
      {
        tool: {
          name: 'DifferentialExpression',
          id: 'initial',
          args: { task: 'Preflight the sample sheet.' }
        }
      },
      { tool: { name: 'read', id: 'domain-read', args: { path: sheet } } },
      { text: blockedReport('The sample sheet has no donor column.') },
      { tool: { name: 'read', id: 'main-read', args: { path: sheet } } },
      {
        tool: {
          name: 'Wrapper',
          id: 'inherited',
          args: { task: 'Check the same design, without fitting.' }
        }
      },
      { tool: { name: 'read', id: 'wrapper-read', args: { path: sheet } } },
      { text: blockedReport('The fit requires the missing donor mapping.') },
      { text: 'Please supply the donor mapping to proceed.' }
    )
    const first = await f.sessions.prompt({ sessionId: id, text: question })
    for (const toolCallId of ['initial', 'inherited']) {
      const text = messageText(toolResult(first.messages, toolCallId))
      const handoff = JSON.parse(text.slice(text.indexOf('{')))
      assert.equal(handoff.originalQuestion, question)
      assert.equal(handoff.status, 'blocked')
      assert.deepEqual(handoff.evidence, [sheet])
    }
    assert.match(messageText(toolResult(first.messages, 'main-read')), /no donor column/)
    const marker = new RegExp(raw)
    assert.doesNotMatch(JSON.stringify(first.messages), marker)
    assert.doesNotMatch(JSON.stringify(events), marker)
    const journal = join(f.agentDir, 'phi-kernel', 'sessions', sessionId, 'journal.jsonl')
    assert.doesNotMatch(readFileSync(journal, 'utf8'), marker)
    // The native read returned the real row to both specialists. Parent requests only received summaries.
    const primary = f.provider.requests.filter(
      (request) =>
        Array.isArray(request.tools) &&
        request.tools.some(
          (tool) =>
            isRecord(tool) &&
            isRecord(tool.function) &&
            tool.function.name === 'DifferentialExpression'
        )
    )
    assert.ok(primary.length >= 4)
    assert.doesNotMatch(JSON.stringify(primary), marker)
    assert.equal(
      f.provider.requests.filter((r) => JSON.stringify(r.messages).includes(raw)).length,
      2
    )

    f.provider.enqueue(
      {
        tool: {
          name: 'Wrapper',
          id: 'ordinary',
          args: { task: 'Describe the catalog in one sentence.' }
        }
      },
      { text: 'The ordinary wrapper catalog is available.' },
      { tool: { name: 'read', id: 'explicit-read', args: { path: sheet } } },
      { text: 'Catalog and requested sample sheet reviewed.' }
    )
    const second = await f.sessions.prompt({
      sessionId: id,
      text: 'Describe the wrapper catalog, then show me the sample sheet.'
    })
    assert.equal(
      messageText(toolResult(second.messages, 'ordinary')),
      'The ordinary wrapper catalog is available.'
    )
    assert.match(messageText(toolResult(second.messages, 'explicit-read')), marker)

    const startingRequests = f.provider.requests.length
    f.provider.enqueue(
      {
        tool: {
          name: 'DifferentialExpression',
          id: 'stale',
          args: { task: 'Review the new request.', research_question: question }
        }
      },
      { text: 'The old question was rejected.' }
    )
    const third = await f.sessions.prompt({
      sessionId: id,
      text: 'Is this new independent design estimable?'
    })
    assert.equal(toolResult(third.messages, 'stale').isError, true)
    assert.equal(
      f.provider.requests.length - startingRequests,
      2,
      'A stale quote must be rejected before launching a child'
    )
  }
)
