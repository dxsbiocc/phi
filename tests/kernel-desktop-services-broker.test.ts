import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonValue, ProtocolError } from '../src/shared/kernel-protocol'
import { KernelProtocolCore, type FrameTransport } from '../src/kernel/protocol'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import {
  DESKTOP_SERVICE_HOST_CAPABILITIES,
  registerKernelDesktopServicesBroker,
  type KernelDesktopServiceBinding
} from '../src/main/agent/engine/kernel-host/desktop-services-broker'
import {
  KernelProtocolClient,
  type KernelClientTransport
} from '../src/main/agent/engine/kernel-client'

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

function binding(kernelSessionId: string): KernelDesktopServiceBinding {
  const suffix = kernelSessionId.slice(-1)
  return {
    kernelSessionId,
    runtimeSessionId: `runtime-${suffix}`,
    cwd: `/server/project-${suffix}`,
    executionHost: 'ssh',
    remoteProject: { sessionId: `phi-${suffix}`, projectId: `project-${suffix}` }
  }
}

function protocolError(error: unknown): ProtocolError {
  assert.ok(error && typeof error === 'object' && 'code' in error)
  return error as ProtocolError
}

test('A14/A15 desktop broker preserves host, cwd, references, and Wrapper ownership', async () => {
  const [clientTransport, serverTransport] = pair()
  const core = new KernelProtocolCore({ kernelVersion: 'test', ompVersion: 'test' })
  core.attachTransport(serverTransport, { trusted: true, connectionId: 'desktop' })
  const client = new KernelProtocolClient(clientTransport)
  const services = new HostServiceRegistry()
  const observed: Array<{ method: string; params: Record<string, unknown>; origin?: string }> = []
  const owners = new Map<string, string>()

  services.register('notebookTool.execute', (params, context) => {
    observed.push({
      method: 'notebookTool.execute',
      params: params as Record<string, unknown>,
      origin: context.originSessionId
    })
    return { summary: 'remote notebook saved' }
  })
  services.register('deliverables.present', (params, context) => {
    observed.push({
      method: 'deliverables.present',
      params: params as Record<string, unknown>,
      origin: context.originSessionId
    })
    return {
      files: [
        {
          path: 'ssh://node3/server/project-a/result.txt',
          displayPath: 'result.txt',
          bytes: 12
        }
      ]
    }
  })
  services.register('wrapperJob.start', (params, context) => {
    const request = params as Record<string, unknown>
    assert.equal(request.target, 'remote')
    const runId = 'wrapper-a'
    owners.set(runId, String(context.originSessionId))
    return {
      ok: true,
      status: {
        runId,
        wrapperId: request.id,
        state: 'running',
        profile: 'apptainer',
        outDir: '/server/project-a/results',
        elapsedSeconds: 0,
        progress: {},
        logTail: ''
      }
    }
  })
  for (const method of ['status', 'cancel'] as const) {
    services.register(`wrapperJob.${method}`, (params, context) => {
      const runId = String((params as Record<string, unknown>).runId)
      if (owners.get(runId) !== context.originSessionId) {
        throw new Error('Wrapper run is not owned by this Phi session/project')
      }
      const status = {
        runId,
        wrapperId: 'demo',
        state: method === 'cancel' ? 'cancelled' : 'running',
        profile: 'apptainer',
        outDir: '/server/project-a/results',
        elapsedSeconds: 1,
        progress: {},
        logTail: ''
      }
      return method === 'cancel' ? { ok: true, status } : status
    })
  }
  services.register('wrapperJob.list', () => [])
  services.register('wrapperJob.wait', () => null)

  const broker = registerKernelDesktopServicesBroker(client, {
    services,
    resolveSession: (sessionId) => binding(sessionId),
    evaluateDecision: async (_binding, model) => ({
      choice: 'uncertain',
      source: 'model',
      model,
      fallbackReason: 'not_configured'
    }),
    memory: {
      read: () => ({ snapshot: { summary: '', summaryUpdatedAt: null, lessons: [] } }),
      learn: async () => ({ stored: 1 }),
      ingest: async () => ({ accepted: true }),
      deleteLesson: async () => ({
        snapshot: { summary: '', summaryUpdatedAt: null, lessons: [] }
      }),
      clear: async () => undefined
    }
  })
  await client.hello({ hostCapabilities: [...DESKTOP_SERVICE_HOST_CAPABILITIES] })

  try {
    const notebook = await core.requestHost(
      'notebookTool.execute',
      { action: 'save', cwd: '/server/project-a', params: { path: 'analysis.ipynb' } },
      { sessionId: 'kernel-a', runId: 'run-a' }
    )
    assert.deepEqual(notebook, { summary: 'remote notebook saved' })
    assert.deepEqual(observed[0], {
      method: 'notebookTool.execute',
      origin: 'runtime-a',
      params: {
        action: 'save',
        cwd: '/server/project-a',
        params: { path: 'analysis.ipynb' },
        remoteProject: {
          runtimeSessionId: 'runtime-a',
          sessionId: 'phi-a',
          projectId: 'project-a'
        }
      }
    })

    const presented = await core.requestHost(
      'deliverables.present',
      { runtimeSessionId: 'kernel-a', toolCallId: 'present-a', files: [{ path: 'result.txt' }] },
      { sessionId: 'kernel-a', runId: 'run-a' }
    )
    const file = ((presented as Record<string, JsonValue>).files as JsonValue[])[0] as Record<
      string,
      JsonValue
    >
    assert.equal(file.path, 'ssh://node3/server/project-a/result.txt')
    assert.equal('data' in file, false)

    const started = (await core.requestHost(
      'wrapperJob.start',
      {
        id: 'demo',
        overrides: {},
        target: 'remote',
        originSessionId: 'kernel-a'
      },
      { sessionId: 'kernel-a', runId: 'run-a' }
    )) as Record<string, JsonValue>
    const status = started.status as Record<string, JsonValue>
    assert.equal(status.runId, 'wrapper-a')
    assert.equal(owners.get('wrapper-a'), 'runtime-a')
    assert.equal(
      (
        (await core.requestHost(
          'wrapperJob.status',
          { runId: 'wrapper-a' },
          { sessionId: 'kernel-a' }
        )) as Record<string, JsonValue>
      ).state,
      'running'
    )
    assert.equal(
      (
        (
          (await core.requestHost(
            'wrapperJob.cancel',
            { runId: 'wrapper-a' },
            { sessionId: 'kernel-a' }
          )) as Record<string, JsonValue>
        ).status as Record<string, JsonValue>
      ).state,
      'cancelled'
    )
    await assert.rejects(
      core.requestHost('wrapperJob.status', { runId: 'wrapper-a' }, { sessionId: 'kernel-b' }),
      (error: unknown) => {
        const parsed = protocolError(error)
        assert.equal(parsed.code, 'INTERNAL')
        assert.match(parsed.message, /not owned/)
        return true
      }
    )
  } finally {
    broker.close()
    await client.close()
  }
})

test('A16 broker rejects forged project identity and never falls back remote Library locally', async () => {
  const [clientTransport, serverTransport] = pair()
  const core = new KernelProtocolCore({ kernelVersion: 'test', ompVersion: 'test' })
  core.attachTransport(serverTransport, { trusted: true, connectionId: 'desktop' })
  const client = new KernelProtocolClient(clientTransport)
  const broker = registerKernelDesktopServicesBroker(client, {
    services: new HostServiceRegistry(),
    resolveSession: (sessionId) => binding(sessionId),
    evaluateDecision: async (_binding, model) => ({
      choice: 'uncertain',
      source: 'model',
      model,
      fallbackReason: 'not_configured'
    }),
    memory: {
      read: () => ({ snapshot: { summary: '', summaryUpdatedAt: null, lessons: [] } }),
      learn: async () => ({ stored: 1 }),
      ingest: async () => ({ accepted: true }),
      deleteLesson: async () => ({
        snapshot: { summary: '', summaryUpdatedAt: null, lessons: [] }
      }),
      clear: async () => undefined
    }
  })
  await client.hello({ hostCapabilities: [...DESKTOP_SERVICE_HOST_CAPABILITIES] })

  try {
    for (const capability of ['wrapperJob.status', 'wrapperJob.cancel'] as const) {
      await assert.rejects(
        core.requestHost(capability, { runId: 'wrapper-a' }),
        (error: unknown) => {
          const parsed = protocolError(error)
          assert.equal(parsed.code, 'CAPABILITY_UNAVAILABLE')
          assert.deepEqual(parsed.detail, { reason: 'session_binding_required' })
          return true
        }
      )
    }
    await assert.rejects(
      core.requestHost(
        'notebookTool.execute',
        {
          action: 'read',
          cwd: '/server/project-a',
          params: { path: 'analysis.ipynb' },
          remoteProject: {
            runtimeSessionId: 'kernel-b',
            sessionId: 'phi-b',
            projectId: 'project-b'
          }
        },
        { sessionId: 'kernel-a', runId: 'run-a' }
      ),
      (error: unknown) => {
        const parsed = protocolError(error)
        assert.equal(parsed.code, 'CAPABILITY_UNAVAILABLE')
        assert.deepEqual(parsed.detail, { reason: 'untrusted_remote_project_identity' })
        return true
      }
    )
    await assert.rejects(
      core.requestHost(
        'libraryTool.execute',
        { runtimeSessionId: 'kernel-a', cwd: '/server/project-a', action: 'list', params: {} },
        { sessionId: 'kernel-a', runId: 'run-a' }
      ),
      (error: unknown) => {
        const parsed = protocolError(error)
        assert.equal(parsed.code, 'CAPABILITY_UNAVAILABLE')
        assert.deepEqual(parsed.detail, { reason: 'remote_library_adapter_unavailable' })
        return true
      }
    )
  } finally {
    broker.close()
    await client.close()
  }
})

test('A14 Notebook run cancellation aborts only its run-scoped host request', async () => {
  const [clientTransport, serverTransport] = pair()
  const core = new KernelProtocolCore({ kernelVersion: 'test', ompVersion: 'test' })
  core.attachTransport(serverTransport, { trusted: true, connectionId: 'desktop' })
  const client = new KernelProtocolClient(clientTransport)
  const services = new HostServiceRegistry()
  const started = Promise.withResolvers<void>()
  services.register('notebookTool.execute', (_params, context) => {
    started.resolve()
    return new Promise((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(context.signal?.reason), {
        once: true
      })
    })
  })
  const broker = registerKernelDesktopServicesBroker(client, {
    services,
    resolveSession: (sessionId) => binding(sessionId),
    evaluateDecision: async (_binding, model) => ({
      choice: 'uncertain',
      source: 'model',
      model,
      fallbackReason: 'not_configured'
    }),
    memory: {
      read: () => ({ snapshot: { summary: '', summaryUpdatedAt: null, lessons: [] } }),
      learn: async () => ({ stored: 1 }),
      ingest: async () => ({ accepted: true }),
      deleteLesson: async () => ({
        snapshot: { summary: '', summaryUpdatedAt: null, lessons: [] }
      }),
      clear: async () => undefined
    }
  })
  await client.hello({ hostCapabilities: [...DESKTOP_SERVICE_HOST_CAPABILITIES] })
  try {
    const pending = core.requestHost(
      'notebookTool.execute',
      { action: 'run_cell', cwd: '/server/project-a', params: { cellId: 'cell-1' } },
      { sessionId: 'kernel-a', runId: 'run-a' }
    )
    await started.promise
    core.emitEvent(
      'run.completed',
      { runId: 'run-a', status: 'cancelled' },
      {
        sessionId: 'kernel-a',
        runId: 'run-a'
      }
    )
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(protocolError(error).code, 'CANCELLED')
      return true
    })
  } finally {
    broker.close()
    await client.close()
  }
})
