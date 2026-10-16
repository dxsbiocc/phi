import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhiExtensionBundle } from '../../src/main/agent/engine/rpc/extension-deployment'
import { prepareSshRpcSessionTransport } from '../../src/main/agent/engine/rpc/ssh-stdio-factory'
import { prepareRemoteSessionStorage } from '../../src/main/agent/engine/rpc/session-storage/writer-lease'
import { deriveRemoteSessionPaths } from '../../src/main/agent/engine/rpc/session-storage/paths'
import type { RemoteSessionStoragePreparation } from '../../src/main/agent/engine/rpc/session-storage/types'
import type { PreparePersistentLaunchStorage } from '../../src/main/agent/engine/rpc/persistent-launch-storage'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { shellQuote } from '../../src/main/agent/wrappers/remote-ssh-session'
import { createPhiExtensionDeploymentFixture } from './phiExtensionDeploymentFixture'
import { createLocalShellSession } from './localShellSession'
import type { RemoteSessionScope } from '../../src/main/agent/engine/rpc/session-storage/types'
import type { RpcSessionCreateParams } from '../../src/main/agent/engine/rpc/rpc-session-backend'
import type {
  SshRpcSessionTransport,
  SshRpcSessionTransportOptions
} from '../../src/main/agent/engine/rpc/ssh-stdio-factory'

interface PersistentLauncherFixture extends Omit<
  Awaited<ReturnType<typeof createPhiExtensionDeploymentFixture>>,
  'session'
> {
  session: ReturnType<typeof createLocalShellSession>
  scope: RemoteSessionScope
  paths: ReturnType<typeof deriveRemoteSessionPaths>
  params: RpcSessionCreateParams
  preparations: RemoteSessionStoragePreparation[]
  acquire: PreparePersistentLaunchStorage
  factory(extra?: Partial<SshRpcSessionTransportOptions>): Promise<SshRpcSessionTransport>
  connect(transport: SshRpcSessionTransport): Promise<{
    connection: RpcConnection
    nonce: string
    home: string
    frames: string[]
    stderr(): string
  }>
}

export async function createPersistentLauncherFixture(
  realCli = false
): Promise<PersistentLauncherFixture> {
  const payload = realCli
    ? `exec ${shellQuote(join(process.env.HOME!, '.bun/bin/bun'))} --no-env-file --preload ${shellQuote(join(process.cwd(), 'tests/engine-contract/network-guard.ts'))} ${shellQuote(join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js'))} "$@"`
    : 'cat'
  const base = await createPhiExtensionDeploymentFixture(
    `#!/bin/sh\nif [ "$1" = --version ]; then printf 'omp/18.10.3\\n'; exit 0; fi\n${payload}\n`
  )
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'phi-launcher-project-')))
  const session = createLocalShellSession(base.runtimeRoot)
  const openStdio = session.openStdio!
  // Model a normal remote account explicitly; preparation-shell umasks do not carry over.
  session.openStdio = (command) =>
    openStdio(command.includes('exec env -i') ? `umask 022\n${command}` : command)
  const scope: RemoteSessionScope = {
    hostProfileId: 'launcher-fixture-host',
    bindingHash: 'a'.repeat(64),
    projectId: 'launcher-project',
    projectRoot,
    runtimeRoot: base.runtimeRoot,
    phiSessionId: 'launcher-phi-session'
  }
  const paths = deriveRemoteSessionPaths(scope)
  const params = { sessionId: scope.phiSessionId, cwd: projectRoot, agentDir: 'desktop-not-copied' }
  const preparations: RemoteSessionStoragePreparation[] = []
  const connections = new Set<RpcConnection>()
  const acquire: PreparePersistentLaunchStorage = async ({ signal }) => {
    const preparation = await prepareRemoteSessionStorage({
      runtimeHost: base.host,
      scope,
      signal,
      openLockStdio: (command) => session.openStdio!(command)
    })
    preparations.push(preparation)
    return preparation
  }
  const bundle = realCli
    ? await createPhiExtensionBundle(join(process.cwd(), 'src/main/agent/engine/phi-extension'))
    : base.bundle
  const factory = (
    extra: Partial<SshRpcSessionTransportOptions> = {}
  ): Promise<SshRpcSessionTransport> =>
    prepareSshRpcSessionTransport({
      session,
      runtime: base.options,
      bundle,
      projectId: scope.projectId,
      preparePersistentStorage: acquire,
      ...extra
    })
  return {
    ...base,
    session,
    scope,
    paths,
    params,
    preparations,
    acquire,
    factory,
    async connect(transport: Awaited<ReturnType<typeof factory>>) {
      const channel = await transport.open(params, new AbortController().signal)
      const connection = new RpcConnection(() => channel, {
        startupTimeoutMs: 15000,
        promptTimeoutMs: 20000
      })
      connections.add(connection)
      const frames: string[] = []
      connection.onEvent((frame) => frames.push(frame.type))
      let stderr = ''
      channel.stderr.on('data', (bytes: Buffer) => {
        stderr += bytes.toString()
      })
      try {
        await connection.start()
        await transport.initialize({ connection, params, signal: new AbortController().signal })
      } catch (error) {
        await connection.close()
        throw new Error(`Persistent launcher CLI failed: ${stderr}`, { cause: error })
      }
      const [nonce] = await readdir(join(base.runtimeRoot, 'rpc-sessions'))
      return {
        connection,
        nonce,
        home: join(base.runtimeRoot, 'rpc-sessions', nonce, 'home'),
        frames,
        stderr: () => stderr
      }
    },
    async cleanup() {
      await Promise.all([...connections].map((connection) => connection.close()))
      await Promise.all(preparations.map((preparation) => preparation.lease.release()))
      await session.close()
      await base.cleanup()
      await rm(projectRoot, { recursive: true, force: true })
    }
  }
}

export async function writePersistentLauncherModel(
  agentDir: string,
  url: string,
  key: string
): Promise<void> {
  await writeFile(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        'phi-contract': {
          baseUrl: url,
          api: 'openai-completions',
          apiKey: key,
          models: [
            {
              id: 'contract-model',
              name: 'Private launcher model',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 32768,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      defaultProvider: 'phi-contract',
      defaultModel: 'contract-model',
      compaction: { enabled: false },
      extensions: [],
      skills: [],
      memory: { enabled: false },
      goal: { continuationModes: ['rpc'] }
    }),
    { mode: 0o600 }
  )
}

export async function scanPersistentLauncherFiles(
  root: string
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await scanPersistentLauncherFiles(path)))
    else if (entry.isFile()) files.push({ path, bytes: await readFile(path) })
  }
  return files
}
