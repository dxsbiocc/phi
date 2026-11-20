import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentRunRegistry, type AgentRunSnapshot } from '../src/main/agent/agents/registry'
import { parseAgentReport } from '../src/main/agent/agents/report'
import { RESEARCH_HANDOFF_PROTOCOL } from '../src/main/agent/agents/research-handoff'

const question = 'Which genes met the prespecified threshold in treated versus control samples?'
const rawMarker = 'INTERNAL_DIFFERENTIAL_TABLE_ROW'
const research = {
  subquestion: 'Which genes passed the threshold?',
  answer: 'Three genes were evaluable; zero met the threshold.',
  interpretation: 'The candidate list for ORA is empty. Pathway ranks were not evaluated.',
  rationale: 'Deliver the complete table for the requested contrast; skip the conditional ORA.',
  evidence: ['results/treated_vs_control.tsv']
}

function result(metadata: Record<string, unknown>): string {
  return `<phi_agent_result>${JSON.stringify(metadata)}</phi_agent_result>\n\ngene_id\tlog2fc\n${rawMarker}\t2.1\n`
}

test('projects only the bounded scientific answer and references into the parent report', () => {
  const response = result({
    status: 'completed',
    research: { ...research, debug: rawMarker },
    summary: rawMarker,
    fallbackReason: rawMarker,
    nextAgent: rawMarker
  })
  const report = parseAgentReport(response, question)
  assert.equal(report.status, 'completed')
  assert.deepEqual(JSON.parse(report.text), {
    originalQuestion: question,
    status: 'completed',
    ...research,
    missingInputs: []
  })
  assert.doesNotMatch(JSON.stringify(report), new RegExp(rawMarker))
  assert.match(parseAgentReport(response).text, new RegExp(rawMarker))
})

test('incomplete or malformed scientific evidence never falls back to the response body', () => {
  for (const response of [
    rawMarker,
    `<phi_agent_result>{broken}</phi_agent_result>${rawMarker}`,
    result({ status: 'completed' }),
    result({ status: 'completed', research: { ...research, evidence: [] } }),
    result({ status: 'completed', research: { ...research, answer: 'x'.repeat(1000) } }),
    result({ status: 'blocked', research, missingInputs: [`a\t${rawMarker}`] }),
    result({ status: 'completed', research: { ...research, evidence: ['gene\tpvalue'] } }),
    result({ status: 'completed', research: { ...research, rationale: '| Gene | Value |' } })
  ]) {
    const report = parseAgentReport(response, question)
    assert.equal(report.status, 'partial')
    assert.equal(report.structured, false)
    assert.equal(JSON.parse(report.text).originalQuestion, question)
    assert.doesNotMatch(JSON.stringify(report), new RegExp(rawMarker))
  }
  const blocked = parseAgentReport(
    result({
      status: 'blocked',
      research: { ...research, evidence: [] },
      missingInputs: ['donor mapping']
    }),
    question
  )
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.missingInputs, ['donor mapping'])
})

test('research runs publish only compact reports and step metadata, including durable admission', async () => {
  const parentEvents: unknown[] = []
  let finished: AgentRunSnapshot | undefined
  const registry = new AgentRunRegistry({
    admission: {
      accept: async (_id, input) => {
        parentEvents.push(input.task)
      },
      started: async (_id, snapshot) => {
        parentEvents.push(snapshot)
      },
      unknown: async () => assert.fail('admission should succeed')
    }
  })
  registry.subscribe({
    onStep: (run, step) => parentEvents.push(run, step),
    onFinish: (run) => {
      finished = run
    }
  })
  const handle = await registry.start({
    agent: 'Transcriptomics',
    background: true,
    task: `Inspect the following delegated input: ${rawMarker}`,
    researchQuestion: question,
    onProgress: (line) => parentEvents.push(line),
    onToolStep: (step) => parentEvents.push(step),
    async runner(request) {
      assert.ok(request.task.includes(RESEARCH_HANDOFF_PROTOCOL))
      assert.ok(request.task.includes(question))
      assert.ok(request.task.includes(rawMarker))
      request.onProgress?.(rawMarker)
      request.onToolStep?.({
        id: 'call-1',
        toolName: 'read',
        status: 'running',
        args: { query: rawMarker }
      })
      request.onToolStep?.({ id: 'call-1', toolName: 'read', status: 'done', output: rawMarker })
      return { text: result({ status: 'completed', research }), toolCalls: 1 }
    }
  })
  const snapshot = await handle.done
  assert.deepEqual(snapshot, finished)
  assert.equal(snapshot.reportStatus, 'completed')
  assert.equal(JSON.parse(snapshot.report!).originalQuestion, question)
  assert.doesNotMatch(JSON.stringify([...parentEvents, registry.list()]), new RegExp(rawMarker))
})

test('research execution failures keep process output out of the parent context', async () => {
  const registry = new AgentRunRegistry()
  const handle = await registry.start({
    agent: 'Transcriptomics',
    background: false,
    researchQuestion: question,
    task: 'Fit model',
    runner: async () => {
      throw new Error(rawMarker)
    }
  })
  const run = await handle.done
  assert.equal(run.state, 'error')
  assert.match(run.error!, /failed/)
  assert.equal(JSON.parse(run.error!).originalQuestion, question)
  assert.doesNotMatch(JSON.stringify(run), new RegExp(rawMarker))
})

test('an already cancelled research delegation retains its original question and starts no work', async () => {
  const registry = new AgentRunRegistry()
  const run = await (
    await registry.start({
      agent: 'Transcriptomics',
      background: false,
      researchQuestion: question,
      task: rawMarker,
      signal: AbortSignal.abort(),
      runner: async () => assert.fail('cancelled delegation executed')
    })
  ).done
  assert.equal(run.state, 'cancelled')
  assert.equal(JSON.parse(run.report!).originalQuestion, question)
  assert.doesNotMatch(JSON.stringify(run), new RegExp(rawMarker))
})
