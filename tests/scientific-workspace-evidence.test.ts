import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'

import { AgentRunRegistry, type AgentRunSnapshot } from '../src/main/agent/agents/registry'
import { checkScientificCompletion } from '../src/main/agent/agents/research-evidence'
import { parseAgentReport } from '../src/main/agent/agents/report'
import { readScientificHandoff } from '../src/main/agent/agents/research-handoff'
import { createAgentRunner, type AgentSessionLike } from '../src/main/agent/agents/runner'
import type { PhiAgentEvent } from '../src/main/agent/engine/types'

const question = 'Which genes changed?'
const missingEvidence = ['results/de.tsv', 'results/de.qc.tsv']
const sentinel = 'UNVERIFIED_123_45'
const makeReport = (answer: string, evidence: string[], status = 'completed'): string =>
  '<phi_agent_result>' +
  JSON.stringify({
    status,
    research: {
      subquestion: question,
      answer,
      interpretation: 'Here is the scope.',
      rationale: 'Here is the reason.',
      evidence
    }
  }) +
  '</phi_agent_result>'

function project(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-scientific-evidence-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  mkdirSync(join(root, 'project'))
  return join(root, 'project')
}

type Turn = (emit: (event: PhiAgentEvent) => void, prompt: string) => string
function child(
  cwd: string,
  turns: Turn[]
): {
  runner: ReturnType<typeof createAgentRunner>
  prompts: string[]
  events: unknown[]
  created(): number
} {
  const prompts: string[] = []
  const events: unknown[] = []
  let created = 0
  const runner = createAgentRunner({
    agent: 'Research',
    cwd,
    createSession: async (): Promise<AgentSessionLike> => {
      created++
      let listener: (event: PhiAgentEvent) => void = () => {}
      let content = ''
      return {
        subscribe(callback) {
          listener = callback
          return () => {}
        },
        async prompt(prompt) {
          const turn = turns[prompts.length]
          assert.ok(turn, 'Unexpected extra correction')
          prompts.push(prompt)
          content = turn(listener, prompt)
        },
        abort: async () => undefined,
        dispose: () => undefined,
        getLastAssistantMessage: () => ({ stopReason: 'stop', content })
      }
    }
  })
  return { runner, prompts, created: () => created, events }
}
function tool(emit: (evt: PhiAgentEvent) => void, isError = false): void {
  emit({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'analysis', args: {} })
  emit({
    type: 'tool_execution_end',
    toolCallId: 'one',
    toolName: 'analysis',
    isError,
    result: { content: [{ type: 'text', text: 'PRIVATE_RAW_TABLE' }] }
  })
}

for (const background of [false, true]) {
  test(`Real runner corrects missing research files in the same child (background=${background})`, async (t) => {
    const cwd = project(t)
    const f = child(cwd, [
      () => makeReport(sentinel, missingEvidence),
      (emit, prompt) => {
        assert.match(prompt, /actual authorized tools/i)
        tool(emit)
        writeFileSync(join(cwd, 'verified.tsv'), 'PRIVATE_RAW_TABLE\n')
        return makeReport('Verified after inspection.', ['verified.tsv'])
      }
    ])
    const registry = new AgentRunRegistry()
    registry.subscribe({
      onStep: (snapshot, step) => f.events.push(snapshot, step),
      onFinish: (snapshot) => f.events.push(snapshot)
    })
    const run = await (
      await registry.start({
        agent: 'Research',
        task: 'Carry out the requested analysis.',
        researchQuestion: question,
        background,
        runner: f.runner
      })
    ).done
    assert.equal(run.reportStatus, 'completed')
    assert.equal(run.toolCalls, 1)
    assert.match(run.report!, /Verified after inspection/)
    assert.equal(f.prompts.length, 2)
    assert.equal(f.created(), 1)
    assert.doesNotMatch(
      JSON.stringify([run, f.events, registry.list()]),
      /UNVERIFIED_123_45|PRIVATE_RAW_TABLE/
    )
  })
}

test('Invalid evidence after tool use or an unsuccessful correction stays out of the parent', async (t) => {
  const cwd = project(t)
  for (const [expectedPrompts, turns] of [
    [
      1,
      [
        (emit) => {
          tool(emit, true)
          return makeReport(sentinel, missingEvidence)
        }
      ]
    ],
    [2, [() => makeReport(sentinel, missingEvidence), () => makeReport(sentinel, ['PMID: 12345'])]],
    [
      2,
      [
        () => makeReport(sentinel, missingEvidence),
        (emit) => {
          tool(emit)
          return makeReport(sentinel, missingEvidence, 'partial')
        }
      ]
    ],
    [
      2,
      [
        () => makeReport(sentinel, missingEvidence),
        (emit) => {
          tool(emit, true)
          return makeReport(sentinel, ['PMID: 12345'])
        }
      ]
    ]
  ] satisfies Array<[number, Turn[]]>) {
    const f = child(cwd, turns)
    const registry = new AgentRunRegistry()
    const run: AgentRunSnapshot = await (
      await registry.start({
        agent: 'Research',
        task: 'Analyze.',
        researchQuestion: question,
        background: false,
        runner: f.runner
      })
    ).done
    assert.equal(f.prompts.length, expectedPrompts)
    assert.equal(run.reportStatus, 'failed')
    assert.match(run.report!, /Insufficient evidence/)
    const replay = readScientificHandoff(run.report, question, run.reportStatus)
    assert.equal(replay.text, run.report)
    assert.doesNotMatch(
      JSON.stringify([run, replay]),
      /UNVERIFIED_123_45|results\/de|PRIVATE_RAW_TABLE/
    )
  }
})

test('Artifact checks use project-bound regular files and preserve scientific source identifiers', async (t) => {
  const cwd = project(t)
  const existing = join(cwd, 'real.tsv')
  writeFileSync(existing, 'PRIVATE_RAW_TABLE')
  writeFileSync(join(cwd, '..', 'outside.tsv'), 'unrelated')
  symlinkSync(existing, join(cwd, 'inside.tsv'))
  symlinkSync(join(cwd, '..', 'outside.tsv'), join(cwd, 'escape.tsv'))
  mkdirSync(join(cwd, 'directory.tsv'))
  const inspect = (refs: string[]): Promise<string> =>
    checkScientificCompletion({
      cwd,
      question,
      text: makeReport(sentinel, refs),
      signal: new AbortController().signal,
      toolActivity: () => true,
      successfulTool: () => true,
      correct: async () => assert.fail('Must not replay tool work')
    })
  for (const refs of [
    [existing, './inside.tsv', pathToFileURL(existing).href],
    ['10.1000/test.tsv', 'https://example.org/archive.tsv', 'GEO/GSE12345', 'NM_012345.2'],
    ['PMID: 12345', 'ssh://cluster/project/remote.tsv', 'wrun_4fc8b14d-a909-4a43-a0db-a2b31aa77b59']
  ]) {
    const report = await inspect(refs)
    assert.equal(report, makeReport(sentinel, refs))
    const parsed = parseAgentReport(report, question)
    assert.equal(parsed.status, 'completed')
    assert.deepEqual(JSON.parse(readScientificHandoff(parsed.text, question).text).evidence, refs)
  }
  for (const ref of [
    'missing.tsv',
    './no-extension',
    'directory.tsv',
    'escape.tsv',
    '../outside.tsv'
  ]) {
    assert.match(await inspect([ref]), /Insufficient evidence/)
  }
})

test('Cancellation during correction cannot publish a second research report', async (t) => {
  const cwd = project(t)
  const controller = new AbortController()
  const f = child(cwd, [
    () => makeReport(sentinel, missingEvidence),
    () => {
      controller.abort()
      return makeReport(sentinel, missingEvidence)
    }
  ])
  const registry = new AgentRunRegistry()
  const run = await (
    await registry.start({
      agent: 'Research',
      task: 'Analyze.',
      researchQuestion: question,
      background: false,
      signal: controller.signal,
      runner: f.runner
    })
  ).done
  assert.equal(f.prompts.length, 2)
  assert.equal(run.state, 'cancelled')
  assert.doesNotMatch(JSON.stringify(run), /UNVERIFIED_123_45/)
})
