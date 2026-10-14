import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { deriveRemoteSessionPaths } from '../../src/main/agent/engine/rpc/session-storage/paths'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { prepareRemoteSessionStorage } from '../../src/main/agent/engine/rpc/session-storage/writer-lease'
import { preflightRemoteJournal } from '../../src/main/agent/engine/rpc/session-storage/remote-preflight'
import { publishRemoteSessionManifest } from '../../src/main/agent/engine/rpc/session-storage/remote-manifest'
import { RemoteRecoveryError } from '../../src/main/agent/engine/rpc/session-recovery'
import type {
  RemoteSessionRecoveryOptions,
  RemoteRecoveryAction
} from '../../src/main/agent/engine/rpc/session-recovery'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { startLoopbackModel } from '../engine-contract/loopback-model'
import { createRemoteSessionStorageFixture } from './remoteSessionStorageFixture'

export const recoveryModel = Object.freeze({ provider: 'phi-contract', id: 'contract-model' })
export const replacementModel = Object.freeze({ provider: 'phi-contract', id: 'replacement-model' })

/** Standalone protocol/storage oracle. Product rpc-entry and backend integration remain root-owned. */
export async function createRemoteSessionRecoveryFixture(): Promise<{
  fixture: Awaited<ReturnType<typeof createRemoteSessionStorageFixture>>
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  open(defaultModel?: string): Promise<{
    connection: RpcConnection
    frames: RpcFrame[]
    home: string
    running(): boolean
    options(action: RemoteRecoveryAction): RemoteSessionRecoveryOptions
    close(): Promise<void>
    stderr(): string
  }>
  close(): Promise<void>
}> {
  const base = await createRemoteSessionStorageFixture()
  // Bun normalizes macOS /private/var to /var in process.cwd. Keep the exact project
  // proof symlink-free under the checkout; the durable temp runtime is unchanged.
  const projectRoot = await realpath(
    await mkdtemp(fileURLToPath(new URL('../../.omx/t15c-project-', import.meta.url)))
  )
  const scope = { ...base.scope, projectRoot }
  const paths = deriveRemoteSessionPaths(scope)
  const fixture = {
    ...base,
    scope,
    paths,
    options: { ...base.options, scope },
    cleanup: async () => {
      await base.cleanup()
      await rm(projectRoot, { recursive: true, force: true })
    }
  }
  const provider = await startLoopbackModel().catch(async (error) => {
    await fixture.cleanup()
    throw error
  })
  const channels = new Set<{ close(): Promise<void> }>()
  let generation = 0
  return {
    fixture,
    provider,
    async open(defaultModel = recoveryModel.id) {
      const preparation = await prepareRemoteSessionStorage(fixture.options)
      const generationRoot = join(fixture.root, `generation-${++generation}`)
      const home = join(generationRoot, 'home')
      // The exact default agent directory is required for SDK XDG blob resolution.
      const agentDir = join(home, '.omp/agent')
      const temp = join(generationRoot, 'tmp')
      for (const dir of [agentDir, temp]) await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(agentDir, 'models.yml'),
        JSON.stringify({
          providers: {
            [recoveryModel.provider]: {
              baseUrl: provider.url,
              api: 'openai-completions',
              apiKey: `ephemeral-proxy-bearer-recovery-only-${generation}`,
              models: [recoveryModel, replacementModel].map((model) => ({
                id: model.id,
                name: model.id,
                reasoning: false,
                input: ['text', 'image'],
                contextWindow: 32768,
                maxTokens: 256,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              }))
            }
          }
        }),
        { mode: 0o600 }
      )
      await writeFile(
        join(agentDir, 'config.yml'),
        JSON.stringify({
          defaultProvider: recoveryModel.provider,
          defaultModel,
          compaction: { enabled: false },
          extensions: [],
          skills: [],
          mcp: { enableProjectConfig: false },
          memory: { enabled: false },
          goal: { continuationModes: [] },
          retry: { modelFallback: false }
        }),
        { mode: 0o600 }
      )
      let running = false
      let stderr = ''
      const frames: RpcFrame[] = []
      let transport: RpcTransport | undefined
      const connection = new RpcConnection(
        () => {
          const child = spawn(
            '/bin/sh',
            [
              '-c',
              'umask 077; exec "$@"',
              'phi-recovery-fixture',
              resolveBunExecutable(),
              '--preload',
              fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
              fileURLToPath(
                new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
              ),
              '--mode',
              'rpc',
              '--provider',
              recoveryModel.provider,
              '--model',
              defaultModel,
              '--session-dir',
              preparation.paths.journals,
              '--no-extensions',
              '--no-skills',
              '--no-rules',
              '--no-tools',
              '--no-title',
              '--no-prewalk',
              '--no-lsp',
              '--no-pty',
              '--system-prompt',
              'Reply to the scripted request.'
            ],
            {
              cwd: fixture.scope.projectRoot,
              env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: home,
                USERPROFILE: home,
                PI_CODING_AGENT_DIR: agentDir,
                XDG_DATA_HOME: preparation.paths.data,
                XDG_CONFIG_HOME: join(home, '.config'),
                XDG_CACHE_HOME: join(generationRoot, 'cache'),
                XDG_STATE_HOME: join(generationRoot, 'state'),
                TMPDIR: temp,
                TEMP: temp,
                TMP: temp,
                NO_PROXY: '127.0.0.1,localhost'
              },
              stdio: ['pipe', 'pipe', 'pipe']
            }
          )
          running = true
          child.stderr.on('data', (bytes: Buffer) => {
            stderr += bytes.toString()
          })
          const closed = new Promise<{ code: number | null; signal: string | null }>(
            (resolve, reject) => {
              child.once('error', reject)
              child.once('close', (code, signal) => {
                running = false
                resolve({ code, signal })
              })
            }
          )
          let closing: Promise<void> | undefined
          transport = {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            closed,
            close: () =>
              (closing ??= (async () => {
                if (child.exitCode !== null || child.signalCode !== null) return
                child.kill('SIGTERM')
                const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
                try {
                  await closed
                } finally {
                  clearTimeout(timer)
                }
              })())
          }
          return transport
        },
        { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 20000 }
      )
      connection.onEvent((frame) => {
        frames.push(frame)
      })
      let closing: Promise<void> | undefined
      const channel = {
        connection,
        frames,
        home,
        running: () => running,
        stderr: () => stderr,
        options(action: RemoteRecoveryAction): RemoteSessionRecoveryOptions {
          const control = connection.bindControl()
          return {
            action,
            storage: preparation,
            connection,
            control,
            signal: new AbortController().signal,
            availableModels: [recoveryModel, replacementModel],
            preflight: (reference) => preflightRemoteJournal(preparation, reference),
            async verifySavedState(reference, signal) {
              const script = `
                import { readFile, lstat } from 'node:fs/promises';
                import { createHash } from 'node:crypto';
                import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager';
                import { getRestorableSessionModels } from '@oh-my-pi/pi-coding-agent/session/session-context';
                const file = process.argv[1];
                const raw = await readFile(file, 'utf8');
                const records = raw.trimEnd().split('\\n').map(line => JSON.parse(line));
                // This test oracle verifies actual image/blob records, including their bytes.
                const walk = async value => {
                  if (typeof value === 'string' && /^blob:sha256:[a-f0-9]{64}$/.test(value)) {
                    const hash = value.slice(12); const path = process.argv[2] + '/' + hash;
                    const stat = await lstat(path).catch(() => { throw new Error('ASSET_MISSING') });
                    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ASSET_MISSING');
                    if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('ASSET_MISSING');
                  } else if (Array.isArray(value)) { for (const item of value) await walk(item); }
                  else if (value && typeof value === 'object') { for (const item of Object.values(value)) await walk(item); }
                };
                await walk(records);
                const manager = await SessionManager.open(file, undefined, undefined, { throwIfMissing:true, suppressBreadcrumb:true });
                const selectors = getRestorableSessionModels(manager.buildSessionContext().models, manager.getLastModelChangeRole());
                const selector = selectors[0]; const split = selector?.indexOf('/');
                console.log(JSON.stringify({model: selector && split > 0 ? {provider:selector.slice(0,split),id:selector.slice(split+1)} : null}));
              `
              try {
                const result = await promisify(execFile)(
                  resolveBunExecutable(),
                  [
                    '--preload',
                    fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
                    '-e',
                    script,
                    join(preparation.paths.journals, reference.journalBasename),
                    preparation.paths.blobs
                  ],
                  {
                    cwd: fileURLToPath(new URL('../../', import.meta.url)),
                    signal,
                    timeout: 10000,
                    maxBuffer: 16384,
                    env: {
                      PATH: '/usr/bin:/bin',
                      HOME: home,
                      PI_CODING_AGENT_DIR: agentDir,
                      XDG_DATA_HOME: preparation.paths.data
                    }
                  }
                )
                return JSON.parse(result.stdout) as { model: typeof recoveryModel | null }
              } catch (error) {
                if (signal.aborted) throw signal.reason
                const details = error as { stderr?: string }
                throw new RemoteRecoveryError(
                  details.stderr?.includes('ASSET_MISSING') ? 'ASSET_MISSING' : 'FILE_INVALID',
                  'Strict test journal/assets proof failed',
                  { cause: error }
                )
              }
            },
            // Protocol oracle only: production uses T11's exact metadata/nullable-limit selector.
            async selectModel(_reference, selection) {
              await connection.request({
                type: 'set_model',
                provider: selection.model.provider,
                modelId: selection.model.id
              })
              if (selection.thinkingLevel !== undefined)
                await connection.request({
                  type: 'set_thinking_level',
                  level: selection.thinkingLevel
                })
            },
            // Test-only actual SDK get_entries plus private header; product attested checkpoint command is pending.
            async verifyAttachment(identity) {
              const entries = await connection.request<{ leafId: string | null }>({
                type: 'get_entries'
              })
              const header = (await readFile(identity.journalPath, 'utf8'))
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .find((entry) => entry.type === 'session') as { cwd: string }
              return { ...identity, projectRoot: header.cwd, leafId: entries.leafId }
            },
            publish: async (reference, _checkpoint, signal) => {
              await publishRemoteSessionManifest(preparation, reference, signal)
            },
            interrupt: () => connection.close()
          }
        },
        close: () =>
          (closing ??= (async () => {
            await connection.close()
            await transport?.close()
            await preparation.lease.release()
            await rm(generationRoot, { recursive: true, force: true })
            channels.delete(channel)
          })())
      }
      channels.add(channel)
      try {
        await connection.start()
      } catch (error) {
        await channel.close()
        throw error
      }
      return channel
    },
    async close() {
      await Promise.all([...channels].map((channel) => channel.close()))
      await provider.close()
      await fixture.cleanup()
    }
  }
}
