import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { RpcChildAuthority } from '../../src/main/agent/engine/rpc/subagents/child-authority'
import { RpcChildHostUriBridge } from '../../src/main/agent/engine/rpc/subagents/host-uri-bridge'
import { rpcChildProfileFromDefinition } from '../../src/main/agent/engine/rpc/subagents/run-registry'
import { compileRpcAgentDefinitions } from '../../src/main/agent/engine/rpc/subagents/definition-compiler'
import type { RpcChildRootScope } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import type {
  RpcApprovalDecision,
  RpcApprovalEvent
} from '../../src/main/agent/engine/rpc/approval-bridge'
import type { ToolApprovalRequest } from '../../src/main/agent/tool-approval'
import type { RpcFrame, RpcControlChannel } from '../../src/main/agent/engine/rpc/types'
import {
  createRpcChildCall,
  encodeRpcChildRequest,
  parseRpcChildRequest
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import type { SafeModelDescriptor } from '../../src/main/agent/engine/model-gateway-types'
import {
  childStream as stream,
  childBatchStream,
  type ChildProviderToolCall
} from './rpcChildAuthorityProvider'
import { compileOptions, definition } from './rpcAgentDefinitionFixture'

export interface ChildCliOptions {
  readonly nativeSequence?: (cwd: string) => readonly ChildProviderToolCall[]
  readonly nativeTools?: readonly string[]
  readonly editMode?: 'replace'
  readonly decision?: (
    request: Readonly<ToolApprovalRequest>,
    signal: AbortSignal
  ) => RpcApprovalDecision | Promise<RpcApprovalDecision>
  readonly shadow?: boolean
  readonly reservedInput?: boolean
  readonly reasoning?: boolean
  readonly thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  readonly tool?: 'write' | 'read' | 'bash'
  readonly batch?: 'write' | 'bash-shared' | 'bash-pty'
  readonly holdBash?: boolean
  readonly firstCancel?: 'refuse' | 'timeout'
  readonly fault?: 'register-error' | 'activate-error' | 'cross-child-scope'
  readonly onEvent?: (event: RpcApprovalEvent) => void
}
export interface ChildCliFixture {
  root: string
  cwd: string
  journal: string
  connection: RpcConnection
  authority: RpcChildAuthority
  frames: RpcFrame[]
  requests: Request[]
  approvals: Readonly<ToolApprovalRequest>[]
  events: RpcApprovalEvent[]
  errors: Error[]
  capability: string
  faults: string[]
  cancelAttempts: string[]
  close(): Promise<void>
  stderr(): string
}
interface Request {
  actor: 'root' | 'child'
  body: {
    model: string
    reasoning_effort?: string
    messages: Array<Record<string, unknown>>
    tools: Array<{ function: { name: string } }>
  }
}
export async function childUntil(
  check: () => boolean | Promise<boolean>,
  label: string
): Promise<void> {
  const end = Date.now() + 15000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Private child fixture timed out: ' + label)
    await delay(10)
  }
}
/** Real pinned OMP CLI, actual native task and both production authority modules. */
export async function childAuthorityCli(options: ChildCliOptions = {}): Promise<ChildCliFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-child-authority-')))
  const home = join(root, 'home'),
    cwd = join(root, 'project'),
    agentDir = join(home, '.omp/agent'),
    journalDirectory = join(root, 'history')
  const tool =
    options.batch === 'write' ? 'write' : options.batch ? 'bash' : (options.tool ?? 'write')
  const sequence = options.nativeSequence ? structuredClone(options.nativeSequence(cwd)) : undefined
  let journal = ''
  const frames: RpcFrame[] = [],
    requests: Request[] = [],
    errors: Error[] = [],
    approvals: Readonly<ToolApprovalRequest>[] = [],
    events: RpcApprovalEvent[] = []
  const faults: string[] = [],
    cancelAttempts: string[] = []
  let stderr = '',
    rootHits = 0,
    childHits = 0
  const capability = randomBytes(32).toString('hex')
  const trustedModel: SafeModelDescriptor = {
    provider: 'fixture',
    id: 'model',
    name: 'model',
    reasoning: options.reasoning ?? false,
    input: ['text'],
    contextWindow: 32768,
    maxTokens: 1024
  }
  const compiled = await compileRpcAgentDefinitions(
    compileOptions({
      binding: {
        serverId: 'private-server',
        serverIdentitySha256: 'a'.repeat(64),
        projectId: 'private-project',
        projectRoot: cwd
      },
      definitions: [
        definition({
          name: 'Authority',
          systemPrompt: 'PRIVATE_TRUSTED_CHILD',
          tools: sequence
            ? [...new Set(sequence.map((call) => call.name))]
            : ['write', ...(tool !== 'write' ? [tool] : [])],
          skills: [],
          thinkingLevel: options.thinkingLevel ?? 'off'
        })
      ],
      availableTools: (options.nativeTools ?? ['write', 'read', 'bash']).map((name) => ({
        name,
        site: 'native'
      })),
      availableModels: [trustedModel],
      availableSkills: [],
      parentThinkingLevel: 'off'
    })
  )
  const entry = compiled.manifest.entries.find((item) => item.blocking)!
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url !== '/chat/completions') throw new Error('Unexpected private provider route')
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const part = Buffer.from(chunk)
        bytes += part.length
        if (bytes > 1024 * 1024) throw new Error('Private provider bound exceeded')
        chunks.push(part)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Request['body']
      const actor = body.tools.some((tool) => tool.function.name === 'task') ? 'root' : 'child'
      requests.push({ actor, body })
      if (requests.length > 12) throw new Error('Unexpected private native continuation loop')
      if (actor === 'root') {
        if (++rootHits === 1)
          stream(
            res,
            'task',
            {
              i: 'Verify trusted child authority',
              agent: entry.nativeName,
              name: 'authority-child',
              task: 'Perform a private write',
              solutionSpace: 'Use only the private fixture'
            },
            'outer-authority-task'
          )
        else stream(res)
      } else if (sequence) {
        const call = sequence[childHits++]
        call ? stream(res, call.name, call.args, call.id) : stream(res)
      } else if (++childHits === 1) {
        if (options.batch) {
          childBatchStream(
            res,
            [1, 2].map((index) => ({
              name: tool,
              id: `outer-authority-${tool}-${index}`,
              args:
                tool === 'write'
                  ? {
                      path: join(cwd, 'native-effect.txt'),
                      content: index === 1 ? 'FIRST\n' : 'SECOND\n'
                    }
                  : {
                      command: `printf '${index === 1 ? 'FIRST' : 'SECOND'}\\n' > '${join(cwd, `bash-effect-${index}.txt`)}'`,
                      ...(options.batch === 'bash-pty' ? { pty: true } : {})
                    }
            }))
          )
        } else if (tool === 'read')
          stream(res, 'read', { path: join(cwd, 'read-input.txt') }, 'outer-authority-read')
        else if (tool === 'bash')
          stream(
            res,
            'bash',
            {
              command: options.holdBash
                ? `printf STARTED > '${join(cwd, 'native-started.txt')}'; while ! test -f '${join(cwd, 'native-release.txt')}'; do sleep 0.02; done; printf LATE > '${join(cwd, 'native-late-effect.txt')}'`
                : `printf 'REAL_PRODUCTION_CHILD_BASH\\n' > '${join(cwd, 'bash-effect.txt')}'`
            },
            'outer-authority-bash'
          )
        else
          stream(
            res,
            'write',
            {
              path: options.reservedInput
                ? 'phi-child://request/00000000-0000-4000-8000-000000000000'
                : join(cwd, 'native-effect.txt'),
              content: 'REAL_PRODUCTION_CHILD_WRITE\n'
            },
            'outer-authority-write'
          )
      } else stream(res)
    })().catch((error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)))
      res.writeHead(500).end('Private fixture failed')
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private server address unavailable')
  const profile = rpcChildProfileFromDefinition(entry, ['PRIVATE_TRUSTED_CHILD'], trustedModel, {
    api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${address.port}`,
    transport: 'sse'
  })
  for (const path of [home, cwd, agentDir, journalDirectory, join(root, 'tmp')])
    await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(join(cwd, 'read-input.txt'), 'REAL_PRODUCTION_CHILD_READ\n', { mode: 0o600 })
  for (const file of compiled.files) {
    const path = join(agentDir, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, file.bytes, { mode: 0o600 })
  }
  await writeFile(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: 'synthetic-child-authority-key',
          models: ['model', 'shadow'].map((id) => ({
            id,
            name: id,
            reasoning: trustedModel.reasoning,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 1024
          }))
        }
      }
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      ...(options.editMode ? { edit: { mode: options.editMode } } : {}),
      compaction: { enabled: false },
      mcp: { enableProjectConfig: false },
      memory: { enabled: false },
      extensions: [],
      skills: [],
      task: {
        maxConcurrency: 4,
        maxRecursionDepth: 1,
        isolation: false,
        batch: false,
        speculativeLaunch: false,
        enableLsp: false,
        enableIrc: false
      },
      eval: { tools: { enabled: false } },
      goal: { continuationModes: [] }
    }),
    { mode: 0o600 }
  )
  if (options.shadow) {
    const path = join(cwd, '.omp/agents', entry.nativeName + '.md')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(
      path,
      `---\nname: ${entry.nativeName}\ndescription: private shadow\ntools: [bash]\nmodel: [fixture/model]\nblocking: true\n---\nUNTRUSTED_SHADOW\n`,
      { mode: 0o600 }
    )
  }
  const config = join(root, 'child-server-config.json')
  await writeFile(
    config,
    JSON.stringify({
      phiSessionId: 'private-phi-child-session',
      projectId: 'private-project',
      cwd,
      generation: 1,
      capability,
      profiles: [profile],
      rootSessionDirectory: journalDirectory
    }),
    { mode: 0o600 }
  )
  const child = spawn(
    resolveBunExecutable(),
    [
      '--no-env-file',
      '--preload',
      fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
      fileURLToPath(new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))),
      '--mode',
      'rpc',
      '--provider',
      'fixture',
      '--model',
      'model',
      '--no-extensions',
      '--trusted-extension',
      fileURLToPath(new URL('./rpcChildServerExtension.ts', import.meta.url)),
      '--no-skills',
      '--no-rules',
      '--no-title',
      '--no-prewalk',
      '--no-lsp',
      '--no-pty',
      '--tools',
      'task',
      '--system-prompt',
      'PRIVATE_ROOT_AUTHORITY'
    ],
    {
      cwd,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local/share'),
        TMPDIR: join(root, 'tmp'),
        TMP: join(root, 'tmp'),
        TEMP: join(root, 'tmp'),
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: journalDirectory,
        PHI_CHILD_SERVER_CONFIG: config,
        NO_PROXY: '127.0.0.1,localhost',
        PI_REQ_DEBUG: '0',
        DO_NOT_TRACK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  child.stderr.on('data', (part: Buffer) => {
    stderr = (stderr + part.toString()).slice(-65536)
  })
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let closing: Promise<void> | undefined
  const shutdown = (): Promise<void> =>
    (closing ??= (async () => {
      child.stdin.end()
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        assert.deepEqual(
          await closed,
          { code: 0, signal: null },
          'OMP CLI must exit naturally: ' + stderr
        )
      } finally {
        clearTimeout(kill)
      }
    })())
  const connection = new RpcConnection(
    () => ({
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      closed,
      close: shutdown
    }),
    { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 30000 }
  )
  connection.onEvent((frame) => {
    if (frames.length >= 4096) throw new Error('Private frame bound exceeded')
    frames.push(frame)
  })
  let authority: RpcChildAuthority | undefined,
    bridge: RpcChildHostUriBridge | undefined,
    detach: (() => void) | undefined
  try {
    await connection.start()
    const state = await connection.request<{ sessionId: string; sessionFile?: string }>({
      type: 'get_state'
    })
    await childUntil(
      () =>
        frames.some(
          (frame) =>
            frame.type === 'extension_ui_request' &&
            typeof frame.message === 'string' &&
            frame.message.includes('phi_child_root_ready')
        ),
      'actual root readiness'
    )
    const readyFrame = frames.find(
      (frame) =>
        frame.type === 'extension_ui_request' &&
        typeof frame.message === 'string' &&
        frame.message.includes('phi_child_root_ready')
    )!
    const ready = JSON.parse(String(readyFrame.message)) as { identity: RpcChildRootScope }
    assert.equal(ready.identity.rootOmpSessionId, state.sessionId)
    assert.equal(dirname(ready.identity.rootSessionFile), journalDirectory)
    journal = ready.identity.rootSessionFile
    assert.equal(state.sessionFile, journal)
    assert.equal(ready.identity.cwd, cwd)
    assert.equal(ready.identity.rootAgentId, 'Main')
    const channel = connection.bindControl()
    authority = new RpcChildAuthority({
      identity: ready.identity,
      manifestBinding: compiled.manifest.binding,
      capability,
      profiles: [profile],
      signal: channel.signal,
      captureParent: (started) =>
        started.parentToolCallId === 'outer-authority-task'
          ? { runId: 'private-parent-run' }
          : undefined,
      cancellationTimeoutMs: options.firstCancel === 'timeout' ? 250 : undefined,
      cancelNativeChild: async (nativeAgentId) => {
        cancelAttempts.push(nativeAgentId)
        if (cancelAttempts.length === 1 && options.firstCancel) {
          if (options.firstCancel === 'timeout') await delay(500)
          return false
        }
        const result = await connection.request<{ cancelled: boolean }>({
          type: 'cancel_subagent',
          subagentId: nativeAgentId
        })
        return result.cancelled
      },
      approval: {
        shouldGate: () => true,
        requestToolApproval: (request, signal) => {
          approvals.push(request)
          return options.decision?.(request, signal) ?? 'approved'
        },
        onEvent: (event) => {
          events.push(event)
          options.onEvent?.(event)
        }
      }
    })
    detach = channel.onFrame((frame) => authority!.observe(frame))
    const faultChannel: RpcControlChannel = {
      ...channel,
      onFrame: (listener) =>
        channel.onFrame((frame) => {
          if (
            options.fault === 'cross-child-scope' &&
            !faults.length &&
            frame.type === 'host_uri_request' &&
            frame.operation === 'write' &&
            typeof frame.content === 'string'
          ) {
            const request = parseRpcChildRequest(frame.content)
            if (request.operation === 'approve') {
              const scope = { ...request.scope, childOmpSessionId: 'different-sdk-child-session' }
              const call = createRpcChildCall(
                scope,
                request.call.toolCallId,
                request.call.toolName,
                request.call.input
              )
              faults.push(options.fault)
              return listener({
                ...frame,
                content: encodeRpcChildRequest({ ...request, scope, call })
              })
            }
          }
          return listener(frame)
        }),
      sendControl: async (frame, commit) => {
        if (
          options.fault &&
          !faults.length &&
          frame.type === 'host_uri_result' &&
          typeof frame.content === 'string'
        ) {
          const reply: unknown = JSON.parse(frame.content)
          if (
            reply &&
            typeof reply === 'object' &&
            'operation' in reply &&
            'allowed' in reply &&
            reply.allowed === true &&
            ((options.fault === 'register-error' && reply.operation === 'register') ||
              (options.fault === 'activate-error' && reply.operation === 'activate'))
          ) {
            faults.push(options.fault)
            return channel.sendControl(
              {
                type: 'host_uri_result',
                id: frame.id,
                isError: true,
                error: 'Private injected control refusal'
              },
              commit
            )
          }
        }
        return channel.sendControl(frame, commit)
      }
    }
    bridge = new RpcChildHostUriBridge({ channel: faultChannel, authority })
    await connection.request({ type: 'set_subagent_subscription', level: 'events' })
    await connection.request({
      type: 'set_host_uri_schemes',
      schemes: [{ scheme: 'phi-child', writable: true }]
    })
  } catch (error) {
    await connection.close().catch(() => undefined)
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true })
    throw new Error(String(error) + '\n' + stderr)
  }
  return {
    root,
    cwd,
    journal,
    connection,
    authority,
    frames,
    requests,
    approvals,
    events,
    errors,
    capability,
    faults,
    cancelAttempts,
    close: async () => {
      try {
        bridge?.dispose()
        detach?.()
        await connection.close()
        assert.deepEqual(errors, [])
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    },
    stderr: () => stderr
  }
}
