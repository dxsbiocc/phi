import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  relatedPublicationFiles,
  verifiedWrapperPublication
} from '../src/main/agent/agents/research-publication'
import type { WrapperJobStatus } from '../src/main/agent/wrappers/composition/job-types'
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

test('Only an unambiguous verified primary binds declared local regular files', () => {
  const file = {
    id: 'primary',
    path: join(tmpdir(), 'primary.tsv'),
    bytes: 40,
    exists: true,
    primary: true,
    location: 'local' as const
  }
  const sibling = {
    ...file,
    id: 'sibling',
    path: join(tmpdir(), 'empty.tsv'),
    bytes: 0,
    primary: false
  }
  const status: WrapperJobStatus = {
    runId: 'fixture',
    wrapperId: 'test',
    state: 'completed',
    profile: 'native',
    outDir: tmpdir(),
    elapsedSeconds: 1,
    logTail: '',
    progress: { started: 1 },
    researchQc: {
      schemaVersion: 1,
      disposition: 'skip',
      contrast: 'test',
      geneIdColumn: 'id',
      padjThreshold: 0.05,
      log2fcThreshold: 1,
      evaluated: 1,
      hits: 0,
      resultMd5: '1'.repeat(32),
      integrityVerified: true
    },
    outputs: [
      file,
      sibling,
      { ...sibling, id: 'absent', exists: false },
      { ...sibling, id: 'dir', bytes: undefined },
      { ...sibling, id: 'remote', location: 'remote' }
    ]
  }
  const first = verifiedWrapperPublication(status)
  assert.deepEqual(first, { primary: [file.path], files: [file.path, sibling.path] })
  for (const changed of [
    { ...status, remote: { host: 'elsewhere', runDir: '/tmp' } },
    { ...status, state: 'running' as const },
    { ...status, researchQc: undefined },
    { ...status, researchQc: { disposition: 'invalid' as const, reason: 'malformed' as const } }
  ])
    assert.equal(verifiedWrapperPublication(changed), undefined)
  const canonical = (path: string): string => path
  assert.deepEqual(relatedPublicationFiles([sibling.path], [first], canonical), [])
  assert.deepEqual(relatedPublicationFiles([file.path], [first, first], canonical), [])
  assert.deepEqual(relatedPublicationFiles([file.path], [first], canonical), [
    file.path,
    sibling.path
  ])
})

test(
  'real kernel protects a verified wrapper’s published header-only sibling, while leaving a neighboring table readable',
  { timeout: 45_000 },
  async (t) => {
    const f = await createKernelFixture({ hostCapabilities: ['wrapperJob.wait'] })
    t.after(() => f.close())
    const runId = 'wrun_4fc8b14d-a909-4a43-a0db-a2b31aa77b59'
    const primary = 'study/comparison.tsv'
    const sibling = 'study/output-with-no-rows.tsv'
    const other = 'study/independent.tsv'
    const header = 'PRIVATE_PUBLISHED_HEADER'
    const unrelated = 'UNRELATED_READ_SUCCEEDED'
    mkdirSync(join(f.cwd, 'study'))
    writeFileSync(join(f.cwd, primary), 'id\tvalue\nA\t1\n')
    writeFileSync(join(f.cwd, sibling), header + '\n')
    writeFileSync(join(f.cwd, other), unrelated + '\n')
    let observed = 0
    f.client.registerHostCapability('wrapperJob.wait', (input) => {
      assert.equal(input.runId, runId)
      observed++
      return {
        runId,
        wrapperId: 'local/fixture',
        state: 'completed',
        profile: 'local',
        outDir: join(f.cwd, 'study'),
        exitCode: 0,
        elapsedSeconds: 1,
        progress: { started: 1, total: 1 },
        logTail: '',
        researchQcExpected: true,
        researchQc: {
          disposition: 'eligible',
          schemaVersion: 1,
          contrast: 'test',
          geneIdColumn: 'id',
          padjThreshold: 0.05,
          log2fcThreshold: 1,
          evaluated: 1,
          hits: 1,
          resultMd5: '1'.repeat(32),
          integrityVerified: true
        },
        outputs: [
          {
            id: 'primary',
            path: join(f.cwd, primary),
            location: 'local',
            exists: true,
            bytes: 13,
            primary: true
          },
          {
            id: 'ancillary',
            path: join(f.cwd, sibling),
            location: 'local',
            exists: true,
            primary: false,
            bytes: header.length + 1
          }
        ]
      }
    })
    const id = 'verified-wrapper-publication'
    await f.createSession(id, { persistent: true, phiAgents: true })
    f.provider.enqueue(
      {
        tool: {
          name: 'Wrapper',
          id: 'wrapper-child',
          args: { task: 'Check the run using wrapper_wait.', research_question: question }
        }
      },
      { tool: { name: 'wrapper_wait', id: 'trusted-status', args: { run_id: runId } } },
      {
        text: report.replace(
          JSON.stringify([artifact, 'paired/run.log', 'paired/notes.md']),
          JSON.stringify([runId])
        )
      },
      {
        tool: {
          name: 'General',
          id: 'analysis-child',
          args: {
            task: 'Report the result from the published primary.',
            research_question: question
          }
        }
      },
      {
        text: report.replace(
          JSON.stringify([artifact, 'paired/run.log', 'paired/notes.md']),
          JSON.stringify([primary])
        )
      },
      { tool: { name: 'read', id: 'sibling-read', args: { path: sibling } } },
      { tool: { name: 'bash', id: 'sibling-preview', args: { command: 'head -4 ' + sibling } } },
      { tool: { name: 'read', id: 'ordinary-neighbor', args: { path: other } } },
      { text: 'Summary delivered.' }
    )
    const completed = await f.sessions.prompt({ sessionId: id, text: question })
    assert.equal(observed, 1, 'The real Wrapper specialist must receive the trusted host response')
    assert.doesNotMatch(JSON.stringify(completed.messages), new RegExp(header))
    assert.match(JSON.stringify(completed.messages), new RegExp(unrelated))
    assert.match(JSON.stringify(completed.messages), /already reported this artifact/)
    assert.doesNotMatch(JSON.stringify(f.provider.requests), new RegExp(header))
    const journal = readFileSync(
      join(f.agentDir, 'phi-kernel', 'sessions', f.kernelSessionId(id)!, 'journal.jsonl'),
      'utf8'
    )
    assert.doesNotMatch(journal, new RegExp(header))
    assert.match(journal, new RegExp(unrelated))
  }
)
