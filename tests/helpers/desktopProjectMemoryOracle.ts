import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  createDesktopProjectMemory,
  ingestDesktopProjectMemory,
  learnDesktopProjectMemory,
  closeDesktopProjectMemory,
  closeAllDesktopProjectMemory
} from '../../src/main/agent/engine/rpc/desktop-project-memory-runtime'
import {
  readProjectMemory,
  deleteProjectMemoryLesson,
  clearProjectMemory
} from '../../src/main/agent/memory/project-memory-worker'
import { getMemoryRoot } from '../../src/main/agent/engine/omp-internals'
import type { MemoryModelRequest } from './projectMemoryProvider'

const agentDir = process.env.PI_CODING_AGENT_DIR!
const mode = process.argv[2]
const model = { provider: 'phi-memory-contract', id: 'memory-model' }
const anchor = (project: string): string => join(agentDir, 'anchor-' + project)
const target = (project: string): { agentDir: string; cwd: string } => ({
  agentDir,
  cwd: anchor(project)
})
async function scope(project: string, policy = { enabled: true, learn: true }): Promise<string> {
  const scopeId = randomUUID()
  await createDesktopProjectMemory({
    scopeId,
    ...target(project),
    policy,
    identity: {
      runtimeSessionId: randomUUID(),
      sessionId: randomUUID(),
      projectId: 'project-' + project,
      cwd: '/srv/project-' + project
    }
  })
  return scopeId
}
function source(project: string, version = 1): Record<string, unknown> {
  return {
    runId: 'run-' + project + '-' + version,
    ompSessionId: 'remote-session-' + project,
    journalPath: '/srv/project-' + project + '/server-history.jsonl',
    leafId: 'leaf-' + project + '-' + version,
    messageCount: 2,
    model,
    messages: [
      {
        role: 'user',
        content: 'PROJECT_' + project + '_FACT: store outputs under results/.',
        timestamp: Date.now()
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Project ' + project + ' conversation completed.' }],
        timestamp: Date.now(),
        provider: model.provider,
        model: model.id,
        api: 'openai-completions',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop'
      }
    ]
  }
}
async function ingest(
  scopeId: string,
  value: Record<string, unknown>
): Promise<{ accepted: boolean }> {
  return ingestDesktopProjectMemory({ scopeId, requestId: randomUUID(), source: value })
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  boundary = 'summary publication'
): Promise<void> {
  const deadline = Date.now() + 25000
  for (;;) {
    await provider.refresh()
    if (await predicate()) return
    for (const project of ['A', 'B']) {
      const directory = join(
        agentDir,
        'phi-rpc-memory',
        createHash('sha256').update(anchor(project)).digest('hex')
      )
      for (const relative of [
        'sdk/pipeline-error.json',
        'child-error.log',
        'last-job-error.json'
      ]) {
        let diagnostic: string
        try {
          diagnostic = await readFile(join(directory, relative), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        throw new Error(
          'Actual SDK memory failed for ' + project + ' at ' + relative + ': ' + diagnostic
        )
      }
    }
    if (Date.now() > deadline)
      throw new Error(
        'Actual SDK memory boundary was not reached: ' +
          boundary +
          '; requests=' +
          JSON.stringify(provider.memoryRequests) +
          '; heldClosed=' +
          JSON.stringify({ A: provider.heldClosed('A'), B: provider.heldClosed('B') })
      )
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
if (mode === 'cold') {
  const saved = JSON.parse(await readFile(join(agentDir, 'cold-source.json'), 'utf8'))
  const id = await scope('A')
  assert.equal(
    (await ingest(id, saved)).accepted,
    false,
    'cleared checkpoint must stay tombstoned after a real worker restart'
  )
  assert.equal((await readProjectMemory(target('A'))).summary, '')
  await closeAllDesktopProjectMemory()
  console.log('cold checkpoint rejected without a summary restart')
  process.exit(0)
}
// The outer Node runner owns the real HTTP server and reports its socket
// observations over this test-private stdio channel. Bun runs only the SDK.
const CONTROL_PREFIX = 'PHI_MEMORY_CONTRACT_CONTROL:'
const controls = createInterface({ input: process.stdin })
let controlId = 0
const pendingControls = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>()
controls.on('line', (line) => {
  if (!line.startsWith(CONTROL_PREFIX)) throw new Error('Unknown memory fixture control frame')
  const response = JSON.parse(line.slice(CONTROL_PREFIX.length)) as { id: number; result: unknown }
  const pending = pendingControls.get(response.id)
  if (!pending) throw new Error('Unknown memory fixture control response')
  pendingControls.delete(response.id)
  pending.resolve(response.result)
})
const command = (type: 'snapshot' | 'hold', project?: 'A' | 'B'): Promise<unknown> => {
  const id = ++controlId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControls.delete(id)
      reject(new Error('Private memory fixture control did not respond'))
    }, 5000)
    pendingControls.set(id, {
      resolve(value) {
        clearTimeout(timer)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timer)
        reject(error)
      }
    })
    process.stdout.write(CONTROL_PREFIX + JSON.stringify({ id, type, project }) + '\n')
  })
}
const closed = { A: 0, B: 0 }
const provider = {
  url: process.env.PHI_MEMORY_TEST_PROVIDER_URL!,
  memoryRequests: [] as MemoryModelRequest[],
  async refresh() {
    const snapshot = (await command('snapshot')) as {
      requests: MemoryModelRequest[]
      heldClosed: typeof closed
    }
    provider.memoryRequests.splice(0, provider.memoryRequests.length, ...snapshot.requests)
    Object.assign(closed, snapshot.heldClosed)
  },
  async holdProject(project: 'A' | 'B') {
    await command('hold', project)
  },
  heldClosed(project: 'A' | 'B') {
    return closed[project]
  },
  async close() {
    controls.close()
    process.stdin.destroy()
    for (const pending of pendingControls.values())
      pending.reject(new Error('Memory fixture closed'))
    pendingControls.clear()
  }
}
const requests = provider.memoryRequests
await mkdir(agentDir, { recursive: true })
for (const project of ['A', 'B']) await mkdir(anchor(project), { recursive: true })
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      [model.provider]: {
        api: 'openai-completions',
        baseUrl: provider.url,
        apiKey: 'synthetic-memory-contract-key',
        models: [
          {
            id: model.id,
            name: 'Memory contract model',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  }),
  { mode: 0o600 }
)
try {
  if (mode === 'summary') {
    const id = await scope('A')
    assert.equal((await readProjectMemory(target('A'))).summary, '')
    const data = source('A')
    assert.equal((await ingest(id, data)).accepted, true)
    await until(async () =>
      (await readProjectMemory(target('A'))).summary.includes('PROJECT_A_SUMMARY')
    )
    assert.deepEqual(
      requests.map((request) => request.phase),
      ['stage1', 'stage2']
    )
    const canonical = await readFile(
      join(getMemoryRoot(agentDir, anchor('A')), 'memory_summary.md'),
      'utf8'
    )
    assert.match(canonical, /PROJECT_A_SUMMARY/)
    const fresh = randomUUID()
    const snapshot = await createDesktopProjectMemory({
      scopeId: fresh,
      ...target('A'),
      policy: { enabled: true, learn: true },
      identity: {
        runtimeSessionId: randomUUID(),
        sessionId: randomUUID(),
        projectId: 'project-A',
        cwd: '/srv/project-A'
      }
    })
    assert.match(snapshot.memoryBlock!, /PROJECT_A_SUMMARY/)
    assert.equal((await ingest(fresh, data)).accepted, false)
    assert.equal(
      requests.length,
      2,
      'fresh memory snapshot does not replay the prior prompt or tools'
    )
    assert.equal((await readProjectMemory(target('B'))).summary, '')
    await closeDesktopProjectMemory({ scopeId: id })
    await closeDesktopProjectMemory({ scopeId: id })
    console.log('actual SDK stage1/stage2 -> canonical UI root -> fresh-session memory block')
  } else if (mode === 'learn-clear') {
    const id = await scope('A')
    const learned = await learnDesktopProjectMemory({
      scopeId: id,
      requestId: randomUUID(),
      input: {
        content: 'Use <results> `directory` for durable outputs.',
        context: 'Explicit lesson'
      }
    })
    assert.equal(learned.stored, 1)
    const snapshot = await readProjectMemory(target('A'))
    assert.equal(snapshot.lessons.length, 1)
    assert.doesNotMatch(snapshot.lessons[0].text, /[<>`]/)
    const peer = await scope('B')
    await learnDesktopProjectMemory({
      scopeId: peer,
      requestId: randomUUID(),
      input: { content: 'Peer B keeps its own lesson.' }
    })
    await deleteProjectMemoryLesson({ ...target('A'), index: 0, text: snapshot.lessons[0].text })
    assert.equal((await readProjectMemory(target('A'))).lessons.length, 0)
    await assert.rejects(
      learnDesktopProjectMemory({
        scopeId: id,
        requestId: randomUUID(),
        input: { content: 'A stale writer must not return.' }
      })
    )
    const disabled = await scope('A', { enabled: false, learn: true })
    await assert.rejects(
      learnDesktopProjectMemory({
        scopeId: disabled,
        requestId: randomUUID(),
        input: { content: 'Disabled learning.' }
      })
    )
    const data = source('A')
    const owner = await scope('A')
    await ingest(owner, data)
    await until(async () =>
      (await readProjectMemory(target('A'))).summary.includes('PROJECT_A_SUMMARY')
    )
    await clearProjectMemory(target('A'))
    assert.deepEqual((await readProjectMemory(target('A'))).lessons, [])
    assert.equal((await readProjectMemory(target('A'))).summary, '')
    assert.equal((await readProjectMemory(target('B'))).lessons.length, 1)
    const count = requests.length
    await writeFile(join(agentDir, 'cold-source.json'), JSON.stringify(data), { mode: 0o600 })
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '--preload',
        process.env.PHI_MEMORY_TEST_GUARD!,
        fileURLToPath(import.meta.url),
        'cold'
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let error = ''
    child.stderr.on('data', (value) => {
      error += value
    })
    const code = await new Promise((resolve) => child.once('close', resolve))
    assert.equal(code, 0, error)
    assert.equal(requests.length, count)
    console.log(
      'SDK learn -> same UI list/delete -> project clear -> genuine cold-process tombstone; peer retained'
    )
  } else if (mode === 'cancel-peer') {
    await provider.holdProject('A')
    const a = await scope('A')
    const first = source('A')
    await ingest(a, first)
    await until(
      () => requests.some((request) => request.project === 'A' && request.phase === 'stage2'),
      'A held stage2 request'
    )
    const b = await scope('B')
    await ingest(b, source('B'))
    await until(
      async () => (await readProjectMemory(target('B'))).summary.includes('PROJECT_B_SUMMARY'),
      'B peer summary publication'
    )
    await clearProjectMemory(target('A'))
    await until(() => provider.heldClosed('A') === 1, 'clear A physical socket close')
    assert.equal((await readProjectMemory(target('A'))).summary, '')
    assert.match((await readProjectMemory(target('B'))).summary, /PROJECT_B_SUMMARY/)
    const resumed = await scope('A')
    assert.equal((await ingest(resumed, first)).accepted, false)
    const next = source('A', 2)
    await ingest(resumed, next)
    await until(
      () =>
        requests.filter((request) => request.project === 'A' && request.phase === 'stage2')
          .length === 2,
      'A continued checkpoint held stage2 request'
    )
    await closeDesktopProjectMemory({ scopeId: resumed })
    await until(() => provider.heldClosed('A') === 2, 'close A physical socket close')
    assert.equal((await readProjectMemory(target('A'))).summary, '')
    assert.match((await readProjectMemory(target('B'))).summary, /PROJECT_B_SUMMARY/)
    console.log(
      'clear and close physically ended owned summary sockets; peer B remained successful'
    )
  } else throw new Error('Unknown memory contract mode')
} finally {
  await closeAllDesktopProjectMemory()
  await provider.close()
}
