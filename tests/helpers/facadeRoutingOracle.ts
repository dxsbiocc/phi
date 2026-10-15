import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock } from 'node:test'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, connect, type Socket, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createPersistentLauncherFixture } from './persistentLauncherFixture'
import { createLocalShellSession } from './localShellSession'
import { startHostResultModel } from './rpcHostResultModel'
import { saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { createRemoteProject } from '../../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import {
  createPhiSession,
  findPhiSessionById,
  readSessionEvents,
  createRunId,
  updateSessionManifest
} from '../../src/main/agent/session/session-store'
import { SessionRunnerRegistry } from '../../src/main/agent/session/session-runner-registry'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import {
  facadeBindingHash,
  type SelectedFacadeRuntime
} from '../../src/main/agent/engine/rpc/facade-session-driver'
import {
  getPhiEngine,
  installRemoteSessionRouting,
  ownsRemoteRuntimeSession
} from '../../src/main/agent/engine/in-process-engine'
import { createPhiExtensionBundle } from '../../src/main/agent/engine/rpc/extension-deployment'
import { phiOnlySessionPath, phiSessionIdFromPath } from '../../src/main/agent/session/sessions'
import { deriveRemoteSessionPaths } from '../../src/main/agent/engine/rpc/session-storage/paths'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { RpcFacadeEventProjector } from '../../src/main/agent/engine/rpc/facade-event-projection'
import type { RpcCommand, RpcRequestOptions } from '../../src/main/agent/engine/rpc/types'
import { remoteOmpJournalPath } from '../../src/main/agent/session/runtime-reference'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import type { PhiSessionCreateParams, WorkerSessionState } from '../../src/main/agent/engine/types'

async function withThinkingReadback<T>(
  phiSessionId: string,
  level: string,
  change: () => Promise<T>
): Promise<T> {
  const reference = findPhiSessionById(phiSessionId)!.runtimeRef!
  const journalPath = remoteOmpJournalPath(reference)
  let confirmed: string | undefined
  const request = RpcConnection.prototype.request
  const observer = mock.method(
    RpcConnection.prototype,
    'request',
    function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
      const response = request.call(this, command, options)
      if (command.type !== 'get_state') return response
      return response.then((value) => {
        if (
          value &&
          typeof value === 'object' &&
          'sessionId' in value &&
          value.sessionId === reference.ompSessionId &&
          'sessionFile' in value &&
          value.sessionFile === journalPath &&
          'thinkingLevel' in value &&
          value.thinkingLevel === level
        )
          confirmed = level
        return value
      })
    }
  )
  try {
    const result = await change()
    assert.equal(
      confirmed,
      level,
      'the actual attached SDK session must read back the accepted thinking level'
    )
    return result
  } finally {
    observer.mock.restore()
  }
}

const agentDir = process.env.PI_CODING_AGENT_DIR!
const repo = process.cwd()
const bun = process.env.PHI_TEST_REAL_BUN!
assert.ok(agentDir && bun && process.env.HOME?.includes('phi-facade-oracle-'))
const guardedBun = join(process.env.HOME!, '.bun/bin/bun')
await mkdir(join(process.env.HOME!, '.bun/bin'), { recursive: true })
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
await writeFile(
  guardedBun,
  `#!/bin/sh\nexec ${quote(bun)} --no-env-file --preload ${quote(join(repo, 'tests/engine-contract/network-guard.ts'))} "$@"\n`,
  { mode: 0o700 }
)
await chmod(guardedBun, 0o700)
process.env.PHI_BUN_PATH = guardedBun
const provider = await startHostResultModel()
const ref = { provider: 'phi-facade-oracle', id: 'facade-model' }
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      [ref.provider]: {
        api: 'openai-completions',
        auth: 'oauth',
        baseUrl: provider.url,
        models: [
          {
            id: ref.id,
            name: 'Facade oracle',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  }),
  { mode: 0o600 }
)
// Seed only the disposable real auth database; the real OmpBridge worker discovers it.
const seed = spawn(
  guardedBun,
  [
    '-e',
    `import {discoverAuthStorage} from '@oh-my-pi/pi-coding-agent'; const auth=await discoverAuthStorage(${JSON.stringify(agentDir)}); await auth.credentials.set(${JSON.stringify(ref.provider)}, {type:'api_key',key:'synthetic-facade-desktop-key'}); auth.close();`
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let seedError = ''
seed.stderr.on('data', (chunk) => {
  seedError += chunk.toString()
})
assert.equal(await new Promise((resolve) => seed.once('exit', resolve)), 0, seedError)
const f = await createPersistentLauncherFixture(true)
const engine = getPhiEngine()
const runners = new SessionRunnerRegistry()
const tunnels: Array<{ close(): Promise<void> }> = []
let uninstall: (() => void) | undefined
const publicEvents: unknown[] = []
const publicStates: unknown[] = []
const privateSecrets: string[] = []
try {
  const profile = saveRemoteHostProfile(
    { label: 'Private facade fixture', hostAlias: 'synthetic-no-ssh' },
    agentDir,
    join(agentDir, 'empty-ssh-config')
  )
  const project = await createRemoteProject(
    {
      name: 'Private facade project',
      hostProfileId: profile.id,
      remoteRoot: f.scope.projectRoot,
      permissionMode: 'ask'
    },
    { connectImpl: async () => createLocalShellSession() }
  )
  assert.equal(project.location.kind, 'ssh')
  if (project.location.kind !== 'ssh') throw new Error('Unexpected fixture project')
  const anchor = ensureRemoteProjectAnchor(project.id, agentDir)
  const phi = createPhiSession({
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd: anchor,
    cwdRealPath: anchor,
    permissionMode: 'ask',
    model: { providerId: ref.provider, modelId: ref.id },
    thinkingLevel: 'high'
  })
  const models = await engine.models.snapshot({ agentDir })
  const model = models.models.find(
    (model) => model.provider === ref.provider && model.id === ref.id
  )
  assert.ok(model, 'real desktop model registry discovers the private synthetic provider')
  const params = (id: string): PhiSessionCreateParams => ({
    sessionId: id,
    cwd: anchor,
    agentDir,
    model,
    thinkingLevel: 'high',
    projectBound: true,
    enableToolApproval: true,
    sessionManager: { kind: 'persistent', cwd: anchor },
    remoteProject: {
      phiSessionId: phi.sessionId,
      projectId: project.id,
      location: project.location as Extract<typeof project.location, { kind: 'ssh' }>,
      contextFiles: []
    }
  })
  // The default getPhiEngine remains genuinely legacy; a memory session has no model effects.
  const legacy = await engine.sessions.create({
    sessionId: 'facade-legacy',
    cwd: anchor,
    agentDir,
    model,
    enableToolApproval: false,
    noTools: 'all',
    sessionManager: { kind: 'memory', cwd: anchor }
  })
  assert.equal(legacy.sessionId, 'facade-legacy')
  assert.equal(ownsRemoteRuntimeSession('facade-legacy'), false)
  assert.equal(engine.sessions.has('facade-legacy'), true)
  await engine.sessions.dispose({ sessionId: 'facade-legacy' })
  assert.equal(provider.requests.length, 0)
  const bundle = await createPhiExtensionBundle(join(repo, 'src/main/agent/engine/phi-extension'))
  const session: SelectedFacadeRuntime['session'] = {
    ...f.session,
    async execWithInput(command, input, options) {
      const channel = await f.session.openStdio!(command)
      let stdout = '',
        stderr = ''
      channel.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      channel.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      const abort = (): void => {
        void channel.close()
      }
      options?.signal?.addEventListener('abort', abort, { once: true })
      channel.stdin.end(input)
      try {
        const result = await channel.closed
        options?.signal?.throwIfAborted()
        return { ...result, stdout, stderr }
      } finally {
        options?.signal?.removeEventListener('abort', abort)
      }
    },
    async openReverseTunnel(options) {
      const sockets = new Set<Socket>()
      const server = createServer((incoming) => {
        const outgoing = connect(options.localPort, '127.0.0.1')
        for (const socket of [incoming, outgoing]) {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
          socket.on('error', () => {
            incoming.destroy()
            outgoing.destroy()
          })
        }
        incoming.pipe(outgoing)
        outgoing.pipe(incoming)
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      let done!: () => void
      const closed = new Promise<void>((resolve) => {
        done = resolve
      })
      let closing: Promise<void> | undefined
      const close = (): Promise<void> =>
        (closing ??= new Promise((resolve, reject) => {
          options.signal?.removeEventListener('abort', abort)
          for (const socket of sockets) socket.destroy()
          server.close((error) => {
            done()
            if (error) reject(error)
            else resolve()
          })
        }))
      const abort = (): void => {
        void close()
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      const tunnel = { remotePort: (server.address() as AddressInfo).port, closed, close }
      tunnels.push(tunnel)
      return tunnel
    }
  }
  let mode: 'new' | 'resume' = 'new'
  let approvals = 0,
    hostEffects = 0
  const detachHost = engine.host.register('notebookTool.execute', (_raw, context) => {
    assert.equal(context.originSessionId, mode === 'new' ? 'facade-remote-1' : 'facade-remote-2')
    hostEffects++
    return {
      content: [{ type: 'text', text: 'real registered service result' }],
      details: { complete: true, serverCwd: f.scope.projectRoot }
    }
  })
  uninstall = installRemoteSessionRouting({
    enabled: true,
    runners,
    selected: ({ phiSessionId, projectId }) => {
      const binding = resolveRemoteWorkspaceHostBinding({ sessionId: phiSessionId, projectId })
      return {
        hostProfileId: profile.id,
        bindingHash: facadeBindingHash(binding),
        projectId,
        projectRoot: binding.canonicalRoot,
        runtime: f.options,
        session,
        bundle,
        recovery: mode,
        recentUserImages: () => [],
        desktopToolNames: ['notebook.save'],
        approval: {
          shouldGate: () => true,
          requestToolApproval: (request) => {
            assert.equal(request.cwd, f.scope.projectRoot)
            approvals++
            assert.equal(hostEffects, 0)
            return 'approved'
          }
        }
      }
    }
  })
  const detachEvents = engine.events.onSessionEvent('facade-remote-1', (event) =>
    publicEvents.push(event)
  )
  const detachStates = engine.events.onSessionState('facade-remote-1', (state) =>
    publicStates.push(state)
  )
  const first = await engine.sessions.create(params('facade-remote-1'))
  assert.equal(first.state.cwd, anchor)
  assert.equal(first.state.sessionFile, phiOnlySessionPath(phi.sessionId))
  assert.equal(phiSessionIdFromPath(first.state.sessionFile!), phi.sessionId)
  assert.equal(provider.requests.length, 0)
  assert.ok(findPhiSessionById(phi.sessionId)?.runtimeRef)
  assert.equal(engine.sessions.has('facade-remote-1'), true)
  await assert.rejects(
    engine.sessions.prompt({
      sessionId: 'facade-remote-1',
      text: 'forged',
      options: { hostRunId: 'renderer-forged-run' }
    }),
    /actual active Phi run/
  )
  assert.equal(provider.requests.length, 0)
  const scanConfig = async (): Promise<void> => {
    for (const nonce of await readdir(join(f.runtimeRoot, 'rpc-sessions'))) {
      const raw = JSON.parse(
        await readFile(join(f.runtimeRoot, 'rpc-sessions', nonce, 'runtime.json'), 'utf8')
      )
      privateSecrets.push(raw.execution.capability, raw.result.capability)
    }
  }
  await scanConfig()
  provider.enqueue(
    { tool: { name: 'notebook.save', args: { path: 'oracle.ipynb' } } },
    { text: 'first routed answer' }
  )
  let state: WorkerSessionState | undefined
  const runId = createRunId()
  const run = runners.startRun({
    sessionId: phi.sessionId,
    runId,
    execute: async () => {
      state = await engine.sessions.prompt({
        sessionId: 'facade-remote-1',
        text: 'first actual submission',
        options: { hostRunId: 'ignored-renderer-id' }
      })
    }
  })
  await run.done
  assert.equal(run.outcome, 'completed', JSON.stringify(readSessionEvents(phi.sessionId)))
  assert.equal(approvals, 1)
  assert.equal(hostEffects, 1)
  assert.ok(
    state?.messages?.some((message) => JSON.stringify(message).includes('first routed answer'))
  )
  assert.ok(
    publicEvents.some(
      (event) =>
        !!event && typeof event === 'object' && 'type' in event && event.type === 'message_update'
    )
  )
  assert.ok(
    readSessionEvents(phi.sessionId).some(
      (event) => event.runId === runId && event.type === 'run_completed'
    )
  )
  const oldRef = findPhiSessionById(phi.sessionId)!.runtimeRef!
  const originalRequests = provider.requests.length
  await engine.sessions.dispose({ sessionId: 'facade-remote-1' })
  assert.equal(engine.sessions.has('facade-remote-1'), false)
  await assert.rejects(
    engine.sessions.prompt({ sessionId: 'facade-remote-1', text: 'cannot fall back' }),
    /显式恢复/
  )
  assert.equal(provider.requests.length, originalRequests)
  uninstall()
  uninstall = undefined
  await assert.rejects(engine.sessions.create(params('facade-disabled-recovery')), /显式启用/)
  assert.equal(provider.requests.length, originalRequests)
  mode = 'resume'
  // Reinstall the same genuine factory contract with explicit restore. No old prompt is replayed.
  uninstall = installRemoteSessionRouting({
    enabled: true,
    runners,
    selected: ({ phiSessionId, projectId }) => ({
      hostProfileId: profile.id,
      bindingHash: facadeBindingHash(
        resolveRemoteWorkspaceHostBinding({ sessionId: phiSessionId, projectId })
      ),
      projectId,
      projectRoot: f.scope.projectRoot,
      runtime: f.options,
      session,
      bundle,
      recovery: phiSessionId === phi.sessionId ? 'resume' : 'new',
      recentUserImages: () => [],
      desktopToolNames: [],
      approval: { shouldGate: () => true, requestToolApproval: () => 'denied' }
    })
  })
  const restored = await engine.sessions.create({
    ...params('facade-remote-2'),
    sessionManager: { kind: 'open', cwd: anchor, path: phiOnlySessionPath(phi.sessionId) }
  })
  assert.equal(restored.state.cwd, anchor)
  assert.equal(provider.requests.length, originalRequests)
  assert.equal(findPhiSessionById(phi.sessionId)!.runtimeRef!.ompSessionId, oldRef.ompSessionId)
  assert.equal(
    findPhiSessionById(phi.sessionId)!.runtimeRef!.journalBasename,
    oldRef.journalBasename
  )
  assert.deepEqual(restored.state.messages, state!.messages)
  await scanConfig()
  const healthyPhi = createPhiSession({
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd: anchor,
    cwdRealPath: anchor,
    permissionMode: 'ask',
    model: { providerId: ref.provider, modelId: ref.id },
    thinkingLevel: 'high'
  })
  const healthy = await createRuntimeAgentSession({
    cwd: anchor,
    agentDir,
    model,
    thinkingLevel: 'high',
    projectBound: true,
    remoteProject: {
      phiSessionId: healthyPhi.sessionId,
      projectId: project.id,
      location: project.location,
      contextFiles: []
    }
  })
  assert.equal(healthy.session.sessionManager.getCwd(), anchor)
  const beforeHealthyThinkingRequests = provider.requests.length
  await withThinkingReadback(healthyPhi.sessionId, 'low', () =>
    healthy.session.setThinkingLevel('low')
  )
  assert.equal(healthy.session.thinkingLevel, 'low')
  assert.equal(findPhiSessionById(healthyPhi.sessionId)!.thinkingLevel, 'low')
  assert.equal(
    provider.requests.length,
    beforeHealthyThinkingRequests,
    'thinking control cannot invoke the model or replay history'
  )
  provider.enqueue({ text: 'held partial', hold: true })
  const held = runners.startRun({
    sessionId: phi.sessionId,
    runId: createRunId(),
    execute: async () => {
      await engine.sessions.prompt({ sessionId: 'facade-remote-2', text: 'stop this actual run' })
    }
  })
  while (provider.requests.length === originalRequests)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(
    engine.sessions.has('facade-remote-2'),
    true,
    'an active prompt still has a live owned session'
  )
  provider.enqueue({ text: 'independent peer remains live' })
  const healthyRun = runners.startRun({
    sessionId: healthyPhi.sessionId,
    runId: createRunId(),
    execute: async () => {
      await healthy.session.prompt('peer submission')
    }
  })
  await healthyRun.done
  assert.equal(healthyRun.outcome, 'completed')
  await engine.sessions.abort({ sessionId: 'facade-remote-2' })
  await held.done
  assert.equal(held.outcome, 'stopped')
  assert.equal(engine.sessions.has('facade-remote-2'), true)
  provider.enqueue({ text: 'next turn works' })
  const next = runners.startRun({
    sessionId: phi.sessionId,
    runId: createRunId(),
    execute: async () => {
      state = await engine.sessions.prompt({
        sessionId: 'facade-remote-2',
        text: 'new independent submission'
      })
    }
  })
  await next.done
  assert.equal(next.outcome, 'completed')
  assert.ok(state!.messages!.some((message) => JSON.stringify(message).includes('next turn works')))
  const beforeThinkingReference = findPhiSessionById(phi.sessionId)!.runtimeRef!
  const thinkingJournalPath = remoteOmpJournalPath(beforeThinkingReference)
  const entries = (value: string): Array<Record<string, unknown>> =>
    value
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, ordered(item)])
          )
        : value
  const digest = (value: unknown): string =>
    createHash('sha256')
      .update(JSON.stringify(ordered(value)))
      .digest('hex')
  const entryKey = (entry: Record<string, unknown>, index: number): string =>
    typeof entry.id === 'string' ? entry.id : `${entry.type}:${index}`
  const beforeEntries = entries(await readFile(thinkingJournalPath, 'utf8'))
  const beforeContext = state!.messages!
  const stoppedIndexes = beforeContext.flatMap((value, index) => {
    const message = value as Record<string, unknown>
    return message.role === 'assistant' &&
      message.stopReason === 'aborted' &&
      digest(message.content) === digest([{ type: 'text', text: 'held partial' }])
      ? [index]
      : []
  })
  assert.equal(stoppedIndexes.length, 1, 'this scenario has exactly one known held partial abort')
  const stoppedIndex = stoppedIndexes[0]
  const stoppedMessage = beforeContext[stoppedIndex]
  const projector = new RpcFacadeEventProjector()
  const stoppedEntries = beforeEntries.filter(
    (entry) =>
      entry.type === 'message' &&
      digest(projector.message(entry.message)) === digest(stoppedMessage)
  )
  assert.equal(
    stoppedEntries.length,
    1,
    'the exact aborted partial must already exist in the physical transcript'
  )
  const stoppedEntry = stoppedEntries[0]
  assert.equal(typeof stoppedEntry.id, 'string')
  const beforeThinkingRequests = provider.requests.length
  const confirmedThinking = await withThinkingReadback(phi.sessionId, 'low', () =>
    engine.sessions.setThinkingLevel({ sessionId: 'facade-remote-2', level: 'low' })
  )
  assert.equal(confirmedThinking.thinkingLevel, 'low')
  assert.equal(findPhiSessionById(phi.sessionId)!.thinkingLevel, 'low')
  assert.deepEqual(
    confirmedThinking.messages,
    [...beforeContext.slice(0, stoppedIndex), ...beforeContext.slice(stoppedIndex + 1)],
    'SDK restore context omits only this known aborted assistant; every other message stays exact'
  )
  const afterThinkingReference = findPhiSessionById(phi.sessionId)!.runtimeRef!
  assert.equal(remoteOmpJournalPath(afterThinkingReference), thinkingJournalPath)
  assert.equal(afterThinkingReference.ompSessionId, beforeThinkingReference.ompSessionId)
  const afterEntries = entries(await readFile(thinkingJournalPath, 'utf8'))
  const beforeKeys = beforeEntries.map(entryKey),
    afterKeys = afterEntries.map(entryKey)
  assert.equal(new Set(beforeKeys).size, beforeKeys.length)
  assert.equal(new Set(afterKeys).size, afterKeys.length)
  const afterById = new Map(afterEntries.map((entry, index) => [entryKey(entry, index), entry]))
  for (let index = 0; index < beforeEntries.length; index++) {
    assert.ok(afterById.has(beforeKeys[index]), 'each old physical journal id must remain present')
    assert.equal(
      digest(afterById.get(beforeKeys[index])),
      digest(beforeEntries[index]),
      'every old physical journal entry must remain canonical-identical by id'
    )
  }
  assert.deepEqual(
    afterKeys.filter((key) => beforeKeys.includes(key)),
    beforeKeys
  )
  const retainedStopped = afterById.get(stoppedEntry.id as string)!
  assert.deepEqual(
    retainedStopped.message,
    stoppedEntry.message,
    'the original aborted terminal and held partial remain in physical history'
  )
  assert.deepEqual(projector.message(retainedStopped.message), stoppedMessage)
  const appended = afterEntries.filter(
    (entry, index) => !beforeKeys.includes(entryKey(entry, index))
  )
  assert.ok(
    appended.every(
      (entry) =>
        entry.type === 'model_change' ||
        entry.type === 'thinking_level_change' ||
        (entry.type === 'custom' && entry.customType === 'session_exit')
    ),
    'thinking rotation may append only SDK model/thinking/retirement metadata, never a prompt or tool replay'
  )
  assert.equal(
    provider.requests.length,
    beforeThinkingRequests,
    'thinking control cannot invoke the model or replay history'
  )
  await assert.rejects(
    () => engine.history.open({ path: phiOnlySessionPath(phi.sessionId), agentDir }),
    /尚未实现/
  )
  const refNow = findPhiSessionById(phi.sessionId)!.runtimeRef!
  const paths = deriveRemoteSessionPaths({
    hostProfileId: refNow.hostProfileId,
    bindingHash: refNow.bindingHash,
    projectId: refNow.projectId,
    projectRoot: refNow.projectRoot,
    runtimeRoot: refNow.runtimeRoot,
    phiSessionId: phi.sessionId
  })
  const journal = await readFile(join(paths.journals, refNow.journalBasename), 'utf8')
  const publicData = JSON.stringify({
    provider: provider.requests,
    publicEvents,
    publicStates,
    history: state!.messages,
    phiEvents: readSessionEvents(phi.sessionId),
    manifest: findPhiSessionById(phi.sessionId)
  })
  assert.ok(
    privateSecrets.length >= 4 &&
      privateSecrets.every((key) => typeof key === 'string' && key.length === 64)
  )
  for (const key of privateSecrets) {
    assert.equal(publicData.includes(key), false)
    assert.equal(journal.includes(key), false)
  }
  assert.equal(journal.includes('renderer-forged-run'), false)
  detachEvents()
  detachStates()
  detachHost()
  await engine.sessions.dispose({ sessionId: 'facade-remote-2' })
  assert.equal(engine.sessions.has(healthy.session.runtimeSessionId), true)
  await engine.sessions.dispose({ sessionId: healthy.session.runtimeSessionId })
  const peerRequests = provider.requests.length
  await assert.rejects(healthy.session.prompt('lost peer cannot recreate'), /显式恢复原会话/)
  assert.equal(provider.requests.length, peerRequests)
  await healthy.session.dispose()
  assert.equal(f.session.closed, false)
  const stalePhi = createPhiSession({
    kind: 'project',
    projectId: project.id,
    projectLocation: project.location,
    cwd: anchor,
    cwdRealPath: anchor,
    permissionMode: 'ask',
    model: { providerId: ref.provider, modelId: ref.id },
    thinkingLevel: 'high'
  })
  const beforeFailureRequests = provider.requests.length
  uninstall()
  uninstall = installRemoteSessionRouting({
    enabled: true,
    runners,
    selected: ({ phiSessionId, projectId }) => {
      const binding = resolveRemoteWorkspaceHostBinding({ sessionId: phiSessionId, projectId })
      queueMicrotask(() =>
        updateSessionManifest(phiSessionId, { cwd: anchor + '-changed-during-proof' })
      )
      return {
        hostProfileId: profile.id,
        bindingHash: facadeBindingHash(binding),
        projectId,
        projectRoot: binding.canonicalRoot,
        runtime: f.options,
        session,
        bundle,
        recovery: 'new',
        recentUserImages: () => [],
        desktopToolNames: [],
        approval: { shouldGate: () => true, requestToolApproval: () => 'denied' }
      }
    }
  })
  const staleParams = {
    ...params('facade-stale-anchor'),
    remoteProject: {
      ...params('facade-stale-anchor').remoteProject!,
      phiSessionId: stalePhi.sessionId
    }
  }
  await assert.rejects(engine.sessions.create(staleParams), /远程工作区会话与项目不匹配/)
  assert.equal(engine.sessions.has('facade-stale-anchor'), false)
  assert.equal(ownsRemoteRuntimeSession('facade-stale-anchor'), true)
  assert.equal(findPhiSessionById(stalePhi.sessionId)!.runtimeRef, undefined)
  assert.equal(provider.requests.length, beforeFailureRequests)
  await assert.rejects(engine.sessions.create(staleParams), /运行代次/)
  process.stdout.write(
    JSON.stringify({
      actualGetPhiEngine: true,
      actualOmpBridge: true,
      realPhiStoreAdoption: true,
      providerRequests: provider.requests.length,
      publicEvents: publicEvents.length,
      approvals,
      hostEffects,
      sameOmpSession: true,
      stoppedThenNextTurn: true,
      secretExclusionCount: privateSecrets.length
    }) + '\n'
  )
} finally {
  uninstall?.()
  await engine.stop()
  await Promise.all(tunnels.map((tunnel) => tunnel.close()))
  await provider.close()
  await f.cleanup()
}
