import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

type ContinuationProbeResult = {
  afterCount: number
  beforeCount: number
  completion: string
  lastRunStatus?: string
  openResult: { sessionId: string }
  sessionId: string
}

function runContinuationProbe(
  cwd: string,
  sourceRoot: string,
  source: string,
  agentDir: string
): ContinuationProbeResult {
  const script = `
    import { makeSessionManager } from './src/main/agent/engine/in-process/session-factory'
    import { KernelSessionRepository } from './src/kernel/sessions'
    import { createWorkerKernelAdapter } from './src/kernel/worker'

    const { PROBE_CWD: cwd, PROBE_SOURCE_ROOT: sourceRoot, PROBE_SOURCE: source, PROBE_AGENT_DIR: agentDir } = process.env
    const request = (method, sessionId) => ({
      kind: 'request',
      id: \`\${method}-request\`,
      method,
      params: {},
      generation: 1,
      ...(sessionId ? { sessionId } : {})
    })
    const context = { controllerGeneration: 1, connectionId: 'loopback-test', trusted: true }

    const sourceManager = await makeSessionManager(
      { kind: 'persistent', path: source },
      cwd,
      agentDir
    )
    sourceManager.appendMessage({ role: 'user', content: 'historic turn', timestamp: Date.now() })
    sourceManager.appendModeChange('plan_execute', { phase: 'executing' })
    sourceManager.appendCustomEntry('phi.plan-execution', {
      state: 'interrupted',
      completedSteps: ['inspect'],
      pendingSteps: ['apply', 'verify']
    })
    await sourceManager.close()

    const adopter = new KernelSessionRepository(
      agentDir,
      'adopter',
      undefined,
      'test-process',
      async (path, initialCwd) => {
        const manager = await makeSessionManager(
          { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
          initialCwd,
          agentDir
        )
        await manager.close()
      }
    )
    const adopted = await adopter.adopt(
      {
        source: {
          kind: 'omp-journal',
          path: source,
          cwd,
          origin: 'desktop-local',
          phiSessionId: 'phi-loopback'
        },
        model: { provider: 'faux', id: 'loopback' }
      },
      { allowedSourceRoots: [sourceRoot] }
    )

    const managers = new Map()
    const adapter = createWorkerKernelAdapter({
      agentDir,
      kernelInstanceId: 'loopback-kernel',
      processStartedAt: 'test-process',
      acquireSessionLockGuard: () => ({ acquired: true, release: () => undefined }),
      async callWorker(method, raw) {
        const params = raw
        const sessionId = String(params.sessionId)
        if (method === 'session.create') {
          managers.set(
            sessionId,
            await makeSessionManager(params.sessionManager, String(params.cwd), agentDir)
          )
          return { sessionId }
        }
        const manager = managers.get(sessionId)
        if (method === 'session.prompt' && manager) {
          manager.appendMessage({
            role: 'user',
            content: String(params.text),
            timestamp: Date.now()
          })
          manager.appendCustomMessageEntry(
            'faux-provider-result',
            'continued by loopback provider',
            true,
            { provider: 'faux', model: 'loopback' }
          )
          return undefined
        }
        if (method === 'session.dispose') {
          await manager?.close()
          managers.delete(sessionId)
          return undefined
        }
        if (method === 'session.abort') return undefined
        throw new Error(\`unexpected worker method \${method}\`)
      },
      readSessionState(sessionId) {
        const manager = managers.get(sessionId)
        if (!manager) throw new Error('loopback session is not loaded')
        return {
          cwd: manager.getCwd(),
          model: { provider: 'faux', id: 'loopback' },
          messages: manager.buildSessionContext().messages
        }
      }
    })
    try {
      const open = adapter.handlers['session.open']
      const snapshot = adapter.handlers['session.snapshot']
      const prompt = adapter.handlers['session.prompt']
      const openResult = await open(
        { sessionId: adopted.sessionId },
        context,
        request('session.open')
      )
      const before = await snapshot(
        {},
        context,
        request('session.snapshot', adopted.sessionId)
      )
      const accepted = await prompt(
        { text: 'continue safely', clientRunKey: 'loopback-run' },
        context,
        request('session.prompt', adopted.sessionId)
      )
      const completion = await accepted.completion
      const after = await snapshot(
        {},
        context,
        request('session.snapshot', adopted.sessionId)
      )
      console.log(JSON.stringify({
        afterCount: after.messages.length,
        beforeCount: before.messages.length,
        completion,
        lastRunStatus: after.lastRun?.status,
        openResult,
        sessionId: adopted.sessionId
      }))
    } finally {
      await adapter.closeAll()
      await adopter.close(adopted.sessionId)
    }
  `
  const stdout = execFileSync(resolveBunExecutable(), ['-e', script], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PROBE_CWD: cwd,
      PROBE_SOURCE_ROOT: sourceRoot,
      PROBE_SOURCE: source,
      PROBE_AGENT_DIR: agentDir
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return JSON.parse(stdout.trim()) as ContinuationProbeResult
}

test('A19 loopback faux provider opens adopted history, snapshots it, and continues', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-continuation-'))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'source')
  const source = join(sourceRoot, 'journal.jsonl')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  mkdirSync(sourceRoot)
  try {
    const result = runContinuationProbe(cwd, sourceRoot, source, agentDir)
    assert.deepEqual(result.openResult, { sessionId: result.sessionId })
    assert.equal(result.beforeCount, 1)
    assert.equal(result.completion, 'completed')
    assert.equal(result.afterCount, 3)
    assert.equal(result.lastRunStatus, 'completed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
