import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { researchReadNotice } from '../src/main/agent/engine/in-process/research-read-extension'
import { createKernelFixture } from './engine-contract/kernel-factory'

const question = 'What do these results support?'
const artifact = 'paired/enrichment.tsv'
const findings = 'Enrichment was supported for the approved comparison.'
const report =
  '<phi_agent_result>' +
  JSON.stringify({
    status: 'completed',
    research: {
      subquestion: 'Which result is supported?',
      answer: findings,
      interpretation: 'Use this result at the prespecified threshold.',
      rationale: 'Assessment completed.',
      evidence: [artifact, 'paired/run.log', 'paired/notes.md']
    }
  }) +
  '</phi_agent_result>'
const user = { type: 'message', message: { role: 'user', content: question } }
const result = { type: 'message', message: { role: 'toolResult', toolCallId: 'delegate-1' } }
const wake = {
  type: 'message',
  message: { role: 'user', content: '<phi_wrapper_run_finished>\nOK' }
}

test('Only whole reads of cited tables or logs from this user turn reuse the specialist finding', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-research-read-'))
  t.after(() => rmSync(cwd, { force: true, recursive: true }))
  mkdirSync(join(cwd, 'paired'))
  writeFileSync(join(cwd, artifact), 'PRIVATE_RAW_ROWS')
  symlinkSync(join(cwd, artifact), join(cwd, 'alias.tsv'))
  const registry = new AgentRunRegistry()
  await (
    await registry.start({
      agent: 'Research',
      task: 'Interpret the input',
      background: false,
      toolCallId: 'delegate-1',
      researchQuestion: question,
      runner: async () => ({ text: report, toolCalls: 1 })
    })
  ).done
  const branch = [user, result, wake]
  for (const path of [
    artifact,
    join(cwd, artifact),
    './paired/../paired/enrichment.tsv:raw',
    pathToFileURL(join(cwd, artifact)).href,
    'alias.tsv',
    'paired/run.log',
    'other.csv;paired/enrichment.tsv',
    'paired/enrichment.tsv:1-:raw',
    'paired/enrichment.tsv:1',
    'paired/enrichment.tsv:raw:L1..'
  ]) {
    assert.match(researchReadNotice(cwd, path, branch, registry) ?? '', /Enrichment was supported/)
  }
  for (const path of [
    'other.tsv',
    'paired/notes.md',
    'paired/enrichment.tsv:3-4',
    'paired/enrichment.tsv:raw:2-3',
    'paired/enrichment.tsv:1,7',
    'paired/enrichment.tsv:1-1'
  ]) {
    assert.equal(researchReadNotice(cwd, path, branch, registry), undefined)
  }
  assert.equal(researchReadNotice(cwd, artifact, [...branch, user], registry), undefined)
  assert.equal(
    researchReadNotice(
      cwd,
      artifact,
      [user, { ...result, message: { role: 'toolResult', toolCallId: 'foreign' } }],
      registry
    ),
    undefined
  )
})

test('Shell output protection recognizes direct preview stages and leaves unrelated file work alone', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-research-preview-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const data = 'paired/results/deseq2_differential/treated_vs_control.deseq2.results.tsv'
  const registry = {
    researchFindings: () => [
      { answer: findings, interpretation: 'Use the assessed contrast.', evidence: [data, artifact] }
    ]
  }
  const inspect = (command: string, branch: unknown[] = [user, result]): string | undefined =>
    researchReadNotice(cwd, command, branch, registry, cwd)
  for (const command of [
    `head -4 "${data}" | cut -c1-160; wc -l paired/results/deseq2_differential/*.tsv`,
    'cat paired/enrichment.tsv',
    'Get-Content -Path "paired/enrichment.tsv"',
    'cmd /c type paired/enrichment.tsv',
    'cd paired && head enrichment.tsv',
    'head -4 paired/*.tsv'
  ])
    assert.match(inspect(command) ?? '', /specialist already reported/)
  for (const command of [
    'wc -l paired/*.tsv',
    'cat other.tsv; wc -l paired/enrichment.tsv',
    'cat paired/enrichment.tsv > paired/archive.tsv',
    'cat other.tsv > paired/enrichment.tsv',
    'cat other.tsv 2> paired/run.log',
    'echo "cat paired/enrichment.tsv"'
  ])
    assert.equal(inspect(command), undefined)
  assert.equal(inspect('cat paired/enrichment.tsv', [user, result, user]), undefined)
})

test(
  'real kernel keeps specialist-cited rows out of primary model traffic and history, and allows a later explicit read',
  { timeout: 45_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    const marker = 'SENSITIVE_ROWS_STAY_IN_FILE'
    mkdirSync(join(f.cwd, 'paired'))
    writeFileSync(join(f.cwd, artifact), 'name\tvalue\n' + marker + '\t20\n')
    for (const name of ['run.log', 'notes.md']) writeFileSync(join(f.cwd, 'paired', name), 'ok\n')
    const id = 'main-research-read'
    await f.createSession(id, { persistent: true, phiAgents: true })
    const liveEvents: unknown[] = []
    const off = f.onSessionEvent(id, (event) => liveEvents.push(event))
    t.after(off)
    f.provider.enqueue(
      {
        tool: {
          name: 'General',
          id: 'delegate-1',
          args: { task: 'Interpret existing verified results.', research_question: question }
        }
      },
      { text: report },
      { tool: { name: 'read', id: 'read-private', args: { path: artifact } } },
      {
        tool: {
          name: 'bash',
          id: 'shell-preview',
          args: {
            command:
              'head -4 paired/enrichment.tsv | cut -c1-160; wc -l paired/*.tsv; printf done > preview-ran.txt'
          }
        }
      },
      { tool: { name: 'bash', id: 'cat-preview', args: { command: 'cat paired/enrichment.tsv' } } },
      {
        tool: { name: 'bash', id: 'count-only', args: { command: 'wc -l < paired/enrichment.tsv' } }
      },
      {
        tool: {
          name: 'bash',
          id: 'failed-preview',
          args: { command: 'cat paired/enrichment.tsv; exit 17' }
        }
      },
      { text: 'The comparison supports enrichment.' }
    )
    const completed = await f.sessions.prompt({ sessionId: id, text: question })
    assert.match(JSON.stringify(completed.messages), /specialist already reported/)
    assert.match(JSON.stringify(completed.messages), /read-private/)
    assert.match(JSON.stringify(completed.messages), /The shell command ran/)
    const failed = completed.messages?.find(
      (m) => (m as { toolCallId?: string }).toolCallId === 'failed-preview'
    )
    assert.match(JSON.stringify(failed), /The shell command failed \(exit 17\)/)
    assert.equal((failed as { isError?: boolean }).isError, true)
    const count = completed.messages?.find(
      (m) => (m as { toolCallId?: string }).toolCallId === 'count-only'
    )
    assert.doesNotMatch(JSON.stringify(count), /specialist already reported/)
    assert.equal(readFileSync(join(f.cwd, 'preview-ran.txt'), 'utf8'), 'done')
    assert.doesNotMatch(JSON.stringify(liveEvents), new RegExp(marker))
    assert.doesNotMatch(JSON.stringify(completed.messages), new RegExp(marker))
    assert.doesNotMatch(JSON.stringify(f.provider.requests), new RegExp(marker))
    const journal = readFileSync(
      join(f.agentDir, 'phi-kernel', 'sessions', f.kernelSessionId(id)!, 'journal.jsonl'),
      'utf8'
    )
    assert.match(journal, /specialist already reported/)
    assert.doesNotMatch(journal, new RegExp(marker))
    f.provider.enqueue(
      { tool: { name: 'read', id: 'read-requested', args: { path: artifact } } },
      {
        tool: { name: 'bash', id: 'cat-requested', args: { command: 'cat paired/enrichment.tsv' } }
      },
      { text: 'The requested file was opened.' }
    )
    const later = await f.sessions.prompt({
      sessionId: id,
      text: 'Please open the entire enrichment file for inspection.'
    })
    const cat = later.messages?.find(
      (message) => (message as { toolCallId?: string }).toolCallId === 'cat-requested'
    )
    assert.match(JSON.stringify(cat), new RegExp(marker))
  }
)
