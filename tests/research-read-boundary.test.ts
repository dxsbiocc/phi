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
      { text: 'The comparison supports enrichment.' }
    )
    const completed = await f.sessions.prompt({ sessionId: id, text: question })
    assert.match(JSON.stringify(completed.messages), /specialist already reported/)
    assert.match(JSON.stringify(completed.messages), /read-private/)
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
      { text: 'The requested file was opened.' }
    )
    const later = await f.sessions.prompt({
      sessionId: id,
      text: 'Please open the entire enrichment file for inspection.'
    })
    assert.match(JSON.stringify(later.messages), new RegExp(marker))
  }
)
