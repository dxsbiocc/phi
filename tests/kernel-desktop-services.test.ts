import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { JsonValue } from '../src/shared/kernel-protocol'
import { KernelProtocolCore, type FrameTransport } from '../src/kernel/protocol'
import { createWorkerKernelAdapter } from '../src/kernel/worker'
import {
  KernelClientError,
  KernelProtocolClient,
  type KernelClientTransport
} from '../src/main/agent/engine/kernel-client'
import { buildSessionNotebookTools } from '../src/main/agent/engine/in-process/session-notebook-tools'

class PairedTransport implements FrameTransport, KernelClientTransport {
  peer?: PairedTransport
  private readonly lines = new Set<(line: string) => void>()
  private readonly closes = new Set<() => void>()

  send(line: string): void {
    queueMicrotask(() => {
      for (const listener of this.peer?.lines ?? []) listener(line)
    })
  }

  onLine(callback: (line: string) => void): void {
    this.lines.add(callback)
  }

  onClose(callback: () => void): void {
    this.closes.add(callback)
  }

  close(): void {
    for (const listener of this.closes) listener()
    for (const listener of this.peer?.closes ?? []) listener()
  }
}

function pair(): [PairedTransport, PairedTransport] {
  const client = new PairedTransport()
  const server = new PairedTransport()
  client.peer = server
  server.peer = client
  return [client, server]
}

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}

test('A14 Notebook host tools keep cwd and reopen saved output', async () => {
  const calls: Array<{ method: string; origin?: string; action: string; cwd: string }> = []
  let savedOutput = ''
  const requestHost = async (
    method: string,
    params: unknown,
    context?: { originSessionId?: string }
  ): Promise<unknown> => {
    const request = params as {
      action: string
      cwd: string
      params: Record<string, unknown>
      remoteProject?: unknown
    }
    assert.equal(request.remoteProject, undefined)
    calls.push({
      method,
      origin: context?.originSessionId,
      action: request.action,
      cwd: request.cwd
    })
    if (request.action === 'run_cell') savedOutput = 'kernel-notebook-output'
    if (request.action === 'read') {
      return {
        summary: savedOutput || 'notebook opened',
        cells: [{ id: 'cell-1', outputs: savedOutput ? [savedOutput] : [] }]
      }
    }
    return { summary: `${request.action} complete` }
  }
  const context = { cwd: '/execution/project', recentUserImages: () => [] }
  const first = buildSessionNotebookTools(requestHost, 'kernel-session-a')
  const byName = (name: string): (typeof first)[number] => {
    const tool = first.find((candidate) => candidate.name === name)
    assert.ok(tool)
    return tool
  }
  await byName('notebook_read').execute(
    'notebook-open',
    { path: 'analysis.ipynb' },
    undefined,
    context
  )
  await byName('notebook_run_cell').execute(
    'notebook-run',
    { path: 'analysis.ipynb', cellId: 'cell-1' },
    undefined,
    context
  )
  await byName('notebook_save').execute(
    'notebook-save',
    { path: 'analysis.ipynb' },
    undefined,
    context
  )

  const reopened = buildSessionNotebookTools(requestHost, 'kernel-session-b')
  const read = reopened.find((candidate) => candidate.name === 'notebook_read')
  assert.ok(read)
  const result = await read.execute(
    'notebook-reopen',
    { path: 'analysis.ipynb', includeOutputs: true },
    undefined,
    context
  )
  assert.match(
    result.content[0].type === 'text' ? result.content[0].text : '',
    /kernel-notebook-output/
  )
  assert.deepEqual(
    calls.map(({ method, origin, action, cwd }) => ({ method, origin, action, cwd })),
    [
      {
        method: 'notebookTool.execute',
        origin: 'kernel-session-a',
        action: 'read',
        cwd: '/execution/project'
      },
      {
        method: 'notebookTool.execute',
        origin: 'kernel-session-a',
        action: 'run_cell',
        cwd: '/execution/project'
      },
      {
        method: 'notebookTool.execute',
        origin: 'kernel-session-a',
        action: 'save',
        cwd: '/execution/project'
      },
      {
        method: 'notebookTool.execute',
        origin: 'kernel-session-b',
        action: 'read',
        cwd: '/execution/project'
      }
    ]
  )
})

async function memoryFixture(hostCapabilities: string[]): Promise<{
  root: string
  core: KernelProtocolCore
  client: KernelProtocolClient
  close(): Promise<void>
}> {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-desktop-memory-'))
  const [clientTransport, serverTransport] = pair()
  const worker = createWorkerKernelAdapter({
    agentDir: root,
    callWorker: async (method) => {
      if (method === 'session.create' || method === 'session.prompt') return {}
      if (method === 'session.dispose') return undefined
      throw new Error(`Unexpected worker call: ${method}`)
    },
    readSessionState: () => ({ cwd: root, messages: [] })
  })
  const core = new KernelProtocolCore({
    kernelVersion: 'test',
    ompVersion: 'test',
    handlers: worker.handlers
  })
  const unbind = worker.bind(core)
  core.attachTransport(serverTransport, { trusted: true, connectionId: 'desktop' })
  const client = new KernelProtocolClient(clientTransport)
  await client.hello({ hostCapabilities })
  return {
    root,
    core,
    client,
    async close() {
      await worker.closeAll()
      unbind()
      await client.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function createMemorySession(fixture: {
  root: string
  client: KernelProtocolClient
}): Promise<string> {
  const created = record(
    await fixture.client.request('session.create', {
      cwd: fixture.root,
      model: { provider: 'fake', id: 'model' },
      sessionManager: { kind: 'memory' },
      memory: { enabled: true, learn: true }
    })
  )
  assert.equal(typeof created.sessionId, 'string')
  return created.sessionId as string
}

test('project memory host owns read/delete/clear and ingests each completion fact once', async (t) => {
  const fixture = await memoryFixture([
    'memory.read',
    'memory.learn',
    'memory.ingest',
    'memory.deleteLesson',
    'memory.clear'
  ])
  t.after(() => fixture.close())
  let lessons = [{ index: 0, text: 'Keep the desktop as memory owner.' }]
  const ingested: string[] = []
  let cleared = 0
  fixture.client.registerHostCapability('memory.read', ({ cwd }) => {
    assert.equal(cwd, fixture.root)
    return { snapshot: { summary: 'Desktop memory.', summaryUpdatedAt: null, lessons } }
  })
  fixture.client.registerHostCapability('memory.ingest', async ({ runId, status, cwd }) => {
    assert.equal(cwd, fixture.root)
    assert.equal(status, 'completed')
    ingested.push(runId)
    return { accepted: true }
  })
  fixture.client.registerHostCapability('memory.deleteLesson', async ({ index, text }) => {
    assert.deepEqual({ index, text }, lessons[0])
    lessons = []
    return { snapshot: { summary: 'Desktop memory.', summaryUpdatedAt: null, lessons } }
  })
  fixture.client.registerHostCapability('memory.clear', async () => {
    cleared += 1
    return null
  })

  const sessionId = await createMemorySession(fixture)
  const completion = Promise.withResolvers<string>()
  const stop = fixture.client.onEvent((event) => {
    if (event.type !== 'run.completed') return
    const payload = record(event.payload)
    if (typeof payload.runId === 'string') completion.resolve(payload.runId)
  })
  const accepted = record(
    await fixture.client.request('session.prompt', { text: 'remember this' }, { sessionId })
  )
  const runId = await completion.promise
  stop()
  assert.equal(runId, accepted.runId)
  for (let attempt = 0; attempt < 100 && ingested.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.deepEqual(ingested, [runId])

  const before = record(await fixture.client.request('memory.read', {}, { sessionId }))
  assert.equal((before.lessons as JsonValue[]).length, 1)
  const after = record(
    await fixture.client.request(
      'memory.deleteLesson',
      { index: 0, text: 'Keep the desktop as memory owner.' },
      { sessionId }
    )
  )
  assert.deepEqual(after.lessons, [])
  assert.deepEqual(await fixture.client.request('memory.clear', {}, { sessionId }), {
    cleared: true
  })
  assert.equal(cleared, 1)
  assert.equal(ingested.length, 1)
})

test('A16 omitted desktop capability reports a machine-readable reason', async (t) => {
  const fixture = await memoryFixture([])
  t.after(() => fixture.close())
  const sessionId = await createMemorySession(fixture)
  await assert.rejects(
    fixture.client.request('memory.read', {}, { sessionId }),
    (error: unknown) => {
      assert.ok(error instanceof KernelClientError)
      assert.equal(error.code, 'CAPABILITY_UNAVAILABLE')
      assert.deepEqual(error.detail, {
        reason: 'host_capability_not_declared',
        capability: 'memory.read'
      })
      assert.match(error.message, /capability is unavailable/i)
      return true
    }
  )
})
