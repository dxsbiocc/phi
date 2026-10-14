import {
  createRuntimeAgentSession,
  type CreateAgentSessionResult
} from '../../src/main/agent/runtime/runtime-adapter'
import assert from 'node:assert/strict'
import {
  createAppRemoteSessionManager,
  installAppRemoteSessionRouting,
  type AppRemoteSessionRoutingOptions
} from '../../src/main/agent/remote-session-routing'
import { StringDecoder } from 'node:string_decoder'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, chmod, readdir, access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, connect, type Socket, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createPersistentLauncherFixture } from './persistentLauncherFixture'
import { createLocalShellSession } from './localShellSession'
import { startHostResultModel } from './rpcHostResultModel'
import type { RemoteSessionRuntimeOptions } from '../../src/main/agent/engine/rpc/remote-session-runtime'
import { saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { createRemoteProject } from '../../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import { createPhiSession } from '../../src/main/agent/session/session-store'
import { SessionRunnerRegistry } from '../../src/main/agent/session/session-runner-registry'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import {
  facadeBindingHash,
  type SelectedFacadeRuntime
} from '../../src/main/agent/engine/rpc/facade-session-driver'
import {
  getPhiEngine,
  installRemoteSessionRouting
} from '../../src/main/agent/engine/in-process-engine'
import {
  getOmpBridge,
  type OwnedModelGatewayLease,
  type OmpBridge
} from '../../src/main/agent/engine/omp-bridge'
import { createPhiExtensionBundle } from '../../src/main/agent/engine/rpc/extension-deployment'
import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'
import type {
  RuntimeModel,
  PhiEngine,
  PhiSessionCreateParams
} from '../../src/main/agent/engine/types'

export interface FacadeMetadataFixture {
  f: Awaited<ReturnType<typeof createPersistentLauncherFixture>>
  engine: PhiEngine
  bridge: OmpBridge
  runners: SessionRunnerRegistry
  provider: Awaited<ReturnType<typeof startHostResultModel>>
  phi: ReturnType<typeof createPhiSession>
  model(id: string): RuntimeModel
  channels: RemoteStdioProcess[]
  rawRetryEvents: RpcFrame[]
  tunnels: Array<{ closed: Promise<void>; close(): Promise<void> }>
  leases: OwnedModelGatewayLease[]
  params(id: string, selectedModel?: string): PhiSessionCreateParams
  createApplicationSession(): Promise<CreateAgentSessionResult>
  configureApproval(approval: RemoteSessionRuntimeOptions['approval']): void
  resume(): void
  disableRouting(): void
  privateDirectories(): Promise<string[]>
  exists(path: string): Promise<boolean>
  close(): Promise<void>
}

export async function facadeMetadataFixture(
  options: {
    select?: (selected: SelectedFacadeRuntime) => SelectedFacadeRuntime
    providerFactory?: typeof startHostResultModel
    isolatedProject?: boolean
    applicationRouting?: Pick<
      AppRemoteSessionRoutingOptions,
      'foregroundAgentNames' | 'onChildApprovalEvent'
    > & {
      agents: import('../../src/main/agent/agents/definition').PhiAgentDefinition[]
      beforeConnect?: (phiSessionId: string) => Promise<void>
    }
  } = {}
): Promise<FacadeMetadataFixture> {
  const agentDir = process.env.PI_CODING_AGENT_DIR!,
    bun = process.env.PHI_TEST_REAL_BUN!
  assert.ok(agentDir && bun && process.env.HOME?.includes('phi-facade-regression-'))
  const repo = process.cwd(),
    guardedBun = join(process.env.HOME!, '.bun/bin/bun')
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  await mkdir(join(process.env.HOME!, '.bun/bin'), { recursive: true })
  await writeFile(
    guardedBun,
    `#!/bin/sh\nexec ${quote(bun)} --no-env-file --preload ${quote(join(repo, 'tests/engine-contract/network-guard.ts'))} "$@"\n`,
    { mode: 0o700 }
  )
  await chmod(guardedBun, 0o700)
  process.env.PHI_BUN_PATH = guardedBun
  const provider = await (options.providerFactory ?? startHostResultModel)()
  const providerId = 'phi-facade-regression'
  await writeFile(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        [providerId]: {
          api: 'openai-completions',
          auth: 'oauth',
          baseUrl: provider.url,
          models: ['model-a', 'model-b'].map((id) => ({
            id,
            name: id,
            reasoning: true,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }))
        }
      }
    }),
    { mode: 0o600 }
  )
  const seed = spawn(
    guardedBun,
    [
      '-e',
      `import {discoverAuthStorage} from '@oh-my-pi/pi-coding-agent'; const auth=await discoverAuthStorage(${JSON.stringify(agentDir)}); await auth.credentials.set(${JSON.stringify(providerId)}, {type:'api_key',key:'synthetic-facade-regression-key'}); auth.close();`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let seedError = ''
  seed.stderr.on('data', (chunk) => {
    seedError += chunk.toString()
  })
  assert.equal(await new Promise((resolve) => seed.once('exit', resolve)), 0, seedError)
  const base = await createPersistentLauncherFixture(true)
  const isolatedProject = options.isolatedProject
    ? await realpath(await mkdtemp(join(process.env.TMPDIR!, 'phi-facade-child-project-')))
    : undefined
  const f = isolatedProject
    ? {
        ...base,
        scope: { ...base.scope, projectRoot: isolatedProject },
        async cleanup() {
          try {
            await base.cleanup()
          } finally {
            await rm(isolatedProject, { recursive: true, force: true })
          }
        }
      }
    : base
  const engine = getPhiEngine(),
    bridge = getOmpBridge(),
    runners = new SessionRunnerRegistry()
  const leases: OwnedModelGatewayLease[] = []
  const createLease = bridge.createModelGatewayLease.bind(bridge)
  bridge.createModelGatewayLease = async (...args) => {
    const lease = await createLease(...args)
    leases.push(lease)
    return lease
  }
  const tunnels: Array<{ closed: Promise<void>; close(): Promise<void> }> = []
  const channels: RemoteStdioProcess[] = []
  const rawRetryEvents: RpcFrame[] = []
  const openStdio = f.session.openStdio!
  f.session.openStdio = async (command) => {
    const channel = await openStdio(command)
    if (command.includes('exec env -i') && command.includes("'--mode' 'rpc'")) {
      channels.push(channel)
      let pending = ''
      const decoder = new StringDecoder('utf8')
      channel.stdout.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk)
        let boundary: number
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary)
          pending = pending.slice(boundary + 1)
          const raw: RpcFrame = JSON.parse(line)
          if (raw.type === 'auto_retry_start' || raw.type === 'auto_retry_end')
            rawRetryEvents.push(raw)
        }
      })
    }
    return channel
  }
  const profile = saveRemoteHostProfile(
    { label: 'Private regression fixture', hostAlias: 'synthetic-no-ssh' },
    agentDir,
    join(agentDir, 'empty-ssh-config')
  )
  const project = await createRemoteProject(
    {
      name: 'Private regression project',
      hostProfileId: profile.id,
      remoteRoot: f.scope.projectRoot,
      permissionMode: 'ask'
    },
    { connectImpl: async () => createLocalShellSession() }
  )
  if (project.location.kind !== 'ssh') throw new Error('Expected SSH fixture project')
  const location = project.location,
    anchor = ensureRemoteProjectAnchor(project.id, agentDir)
  const phi = createPhiSession({
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: anchor,
    cwdRealPath: anchor,
    permissionMode: 'ask',
    model: { providerId, modelId: 'model-a' },
    thinkingLevel: 'high'
  })
  const snapshot = await engine.models.snapshot({ agentDir })
  const model = (id: string): RuntimeModel => {
    const found = snapshot.models.find(
      (candidate) => candidate.provider === providerId && candidate.id === id
    )
    assert.ok(found)
    return found
  }
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
  let recovery: 'new' | 'resume' = 'new'
  let approval: RemoteSessionRuntimeOptions['approval'] = {
    shouldGate: () => true,
    requestToolApproval: () => 'denied'
  }
  const uninstall = options.applicationRouting
    ? installAppRemoteSessionRouting(
        {
          enabled: true,
          agentDir,
          runners,
          appPaths: () => ({
            appPath: repo,
            resourcesPath: join(repo, 'resources'),
            isPackaged: false
          }),
          configuredRoot: () => f.runtimeRoot,
          loadAgents: async () => options.applicationRouting!.agents,
          foregroundAgentNames: options.applicationRouting.foregroundAgentNames,
          onChildApprovalEvent: options.applicationRouting.onChildApprovalEvent,
          approval: {
            shouldGate: (request) => approval.shouldGate(request),
            requestToolApproval: (request, signal) => approval.requestToolApproval(request, signal),
            onEvent: (event) => approval.onEvent?.(event)
          }
        },
        {
          resolveBinding: (identity) => {
            const binding = resolveRemoteWorkspaceHostBinding(identity)
            return {
              ...binding,
              config: {
                ...binding.config,
                connect: async () => {
                  await options.applicationRouting?.beforeConnect?.(identity.sessionId)
                  return { ...f.session, ...session, close: async () => undefined }
                }
              }
            }
          },
          openWorkspace: async () => ({
            projectHost: f.host,
            runtimeHost: f.host,
            projectRoot: f.scope.projectRoot,
            runtimeRoot: f.runtimeRoot,
            execWithInput: async () => {
              throw new Error('unexpected raw workspace input')
            }
          }),
          deployment: {
            manifest: f.options.manifest,
            fetchImpl: f.options.fetchImpl,
            uploadOptions: f.options.uploadOptions
          }
        }
      )
    : installRemoteSessionRouting({
        enabled: true,
        runners,
        selected: ({ phiSessionId, projectId }) => {
          const selected: SelectedFacadeRuntime = {
            hostProfileId: profile.id,
            bindingHash: facadeBindingHash(
              resolveRemoteWorkspaceHostBinding({ sessionId: phiSessionId, projectId })
            ),
            projectId,
            projectRoot: f.scope.projectRoot,
            runtime: f.options,
            session,
            bundle,
            recovery,
            recentUserImages: () => [],
            desktopToolNames: [],
            approval
          }
          return options.select ? options.select(selected) : selected
        }
      })
  return {
    f,
    engine,
    bridge,
    runners,
    provider,
    phi,
    model,
    channels,
    rawRetryEvents,
    tunnels,
    leases,
    createApplicationSession() {
      return createRuntimeAgentSession({
        cwd: anchor,
        agentDir,
        model: model('model-a'),
        thinkingLevel: 'high',
        projectBound: true,
        sessionManager: createAppRemoteSessionManager(anchor, phi.sessionId, recovery === 'resume'),
        remoteProject: {
          phiSessionId: phi.sessionId,
          projectId: project.id,
          location,
          contextFiles: []
        }
      })
    },
    params(id: string, selectedModel = 'model-a') {
      return {
        sessionId: id,
        cwd: anchor,
        agentDir,
        model: model(selectedModel),
        thinkingLevel: 'high' as const,
        projectBound: true,
        enableToolApproval: true,
        sessionManager: { kind: 'persistent' as const, cwd: anchor },
        remoteProject: {
          phiSessionId: phi.sessionId,
          projectId: project.id,
          location,
          contextFiles: []
        }
      }
    },
    configureApproval(next) {
      approval = next
    },
    resume() {
      recovery = 'resume'
    },
    disableRouting: uninstall,
    async privateDirectories() {
      return (await readdir(join(f.runtimeRoot, 'rpc-sessions'))).map((nonce) =>
        join(f.runtimeRoot, 'rpc-sessions', nonce)
      )
    },
    async exists(path: string) {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    async close() {
      uninstall()
      await engine.stop()
      await Promise.all(tunnels.map((tunnel) => tunnel.close()))
      await provider.close()
      await f.cleanup()
    }
  }
}
