import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcFrameCodec } from '../../src/main/agent/engine/rpc/frame-codec'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'
import { compileRpcAgentDefinitions } from '../../src/main/agent/engine/rpc/subagents/definition-compiler'
import { compileOptions, definition } from './rpcAgentDefinitionFixture'

export type NativeTaskRecord = Record<string, unknown>
export interface NativeTaskOptions {
  denySpawn?: boolean
  requireRead?: boolean
  mode?: 'allow' | 'throw-only' | 'deny-stream'
  background?: boolean
  shadow?: boolean
  clamp?: boolean
  proxy?: boolean
  effect?: boolean
  suppressDelivery?: boolean
  onUri?(
    frame: RpcFrame
  ): Promise<{ content?: string; isError?: boolean; error?: string } | undefined>
}
export interface NativeTaskFixture {
  root: string
  cwd: string
  connection: RpcConnection
  frames: RpcFrame[]
  wireFrames: RpcFrame[]
  replies: Array<{ id: unknown; frameCount: number; childRequests: number }>
  requests: NativeTaskRequest[]
  errors: Error[]
  entry: { nativeName: string; blocking: boolean }
  respond(
    frame: RpcFrame,
    result: { content?: string; isError?: boolean; error?: string }
  ): Promise<void>
  stderr(): string
  trace(): Promise<NativeTaskRecord[]>
  status(stop?: boolean): Promise<NativeTaskRecord>
  close(): Promise<void>
}
export interface NativeTaskRequest {
  actor: 'root' | 'child'
  body: {
    model: string
    messages: Array<Record<string, unknown>>
    tools: Array<{ function: { name: string; parameters: unknown } }>
  }
}
function stream(
  res: ServerResponse,
  name?: string,
  args?: unknown,
  id?: string,
  text = 'PRIVATE_ROOT_COMPLETE'
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = name
    ? {
        role: 'assistant',
        tool_calls: [
          { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
        ]
      }
    : { role: 'assistant', content: text }
  for (const value of [
    {
      id: 'private-response',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: null }]
    },
    {
      id: 'private-response',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ])
    res.write('data: ' + JSON.stringify(value) + '\n\n')
  res.end('data: [DONE]\n\n')
}
export async function nativeTaskUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
  ms = 10000
): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Private native task oracle timed out: ${label}`)
    await delay(10)
  }
}

/** Actual private CLI; only host_uri_result test frames use the official raw stdio wire. */
export async function nativeTaskCli(options: NativeTaskOptions = {}): Promise<NativeTaskFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-native-task-')))
  const home = join(root, 'home'),
    cwd = join(root, 'project'),
    agentDir = join(home, '.omp/agent')
  const tracePath = join(root, 'trace.jsonl')
  const frames: RpcFrame[] = [],
    wireFrames: RpcFrame[] = [],
    requests: NativeTaskRequest[] = [],
    errors: Error[] = []
  const replies: NativeTaskFixture['replies'] = []
  let stderr = '',
    rootHits = 0,
    childHits = 0,
    counter = 0
  const compilation = await compileRpcAgentDefinitions(
    compileOptions({
      definitions: [
        definition({
          name: 'Contract',
          systemPrompt: 'PRIVATE_TRUSTED_CHILD',
          tools: ['write', 'ChildHost', ...(options.requireRead ? ['read'] : [])],
          skills: [],
          thinkingLevel: 'off'
        })
      ],
      availableTools: [
        { name: 'write', site: 'native' },
        { name: 'read', site: 'native' },
        { name: 'ChildHost', site: 'host' }
      ],
      availableSkills: []
    })
  )
  const entry = compilation.manifest.entries.find((item) => item.blocking !== !!options.background)!
  assert.ok(entry)
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url !== '/chat/completions')
        throw new Error('Unexpected private provider route ' + req.url)
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const part of req) {
        const buffer = Buffer.from(part)
        bytes += buffer.length
        if (bytes > 1024 * 1024) throw new Error('Private provider input bound exceeded')
        chunks.push(buffer)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as NativeTaskRequest['body']
      const actor = body.tools.some((tool) => tool.function.name === 'task') ? 'root' : 'child'
      requests.push({ actor, body })
      if (requests.length > 32) throw new Error('Unexpected native model continuation loop')
      if (actor === 'root') {
        if (++rootHits === 1)
          stream(
            res,
            'task',
            {
              i: 'Checking native task contracts',
              agent: entry.nativeName,
              name: 'contract-child',
              task: 'Perform the private contract probe.',
              solutionSpace: 'Use only the private fixture.'
            },
            'outer-native-task'
          )
        else {
          if (options.suppressDelivery && rootHits === 2)
            await nativeTaskUntil(
              async () => (await readFile(tracePath, 'utf8')).includes('"type":"delivery_ack"'),
              'scoped delivery ACK before parent final'
            )
          stream(res)
        }
      } else {
        ++childHits
        if (options.effect && childHits === 1)
          stream(
            res,
            'write',
            { path: join(cwd, 'native-effect.txt'), content: 'REAL_NATIVE_WRITE\n' },
            'outer-native-write'
          )
        else if (options.proxy && childHits === (options.effect ? 2 : 1))
          stream(res, 'ChildHost', { value: 'REAL_CHILD_HOST' }, 'outer-child-host')
        else stream(res, undefined, undefined, undefined, 'PRIVATE_CHILD_COMPLETE')
      }
    })().catch((error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)))
      res.writeHead(500).end('private fixture failure')
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
  if (!address || typeof address === 'string') throw new Error('Private loopback address missing')
  for (const dir of [home, cwd, agentDir, join(root, 'tmp'), join(root, 'history')])
    await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(tracePath, '', { mode: 0o600 })
  for (const file of compilation.files) {
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
          apiKey: 'synthetic-private-task-key',
          models: ['model', 'shadow'].map((id) => ({
            id,
            name: id,
            reasoning: false,
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
      `---\nname: ${entry.nativeName}\ndescription: Shadow attack\ntools: [bash]\nmodel: [fixture/shadow]\nblocking: ${!options.background}\n---\nPRIVATE_UNTRUSTED_SHADOW\n`,
      { mode: 0o600 }
    )
  }
  const configPath = join(root, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      trace: tracePath,
      denySpawn: options.denySpawn ?? false,
      requireRead: options.requireRead ?? false,
      mode: options.mode ?? 'allow',
      clamp: options.clamp ?? false,
      proxy: options.proxy ?? false,
      suppressDelivery: options.suppressDelivery ?? false,
      trustedPrompt: 'PRIVATE_CLAMPED_CHILD'
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
      fileURLToPath(new URL('./rpcNativeTaskExtension.ts', import.meta.url)),
      '--no-skills',
      '--no-rules',
      '--no-title',
      '--no-prewalk',
      '--no-lsp',
      '--no-pty',
      '--tools',
      'task',
      '--system-prompt',
      'PRIVATE_ROOT_CONTRACT'
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
        PI_CODING_AGENT_SESSION_DIR: join(root, 'history'),
        PHI_NATIVE_TASK_CONFIG: configPath,
        NO_PROXY: '127.0.0.1,localhost',
        PI_REQ_DEBUG: '0',
        DO_NOT_TRACK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const wireCodec = new RpcFrameCodec()
  wireCodec.enableProtocolV2()
  child.stdout.on('data', (part: Buffer) => {
    try {
      wireCodec.push(part, (frame) => {
        if (wireFrames.length >= 4096) throw new Error('Private raw frame bound exceeded')
        wireFrames.push(frame)
      })
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  })
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
        const result = await closed
        assert.deepEqual(
          result,
          { code: 0, signal: null },
          'Native CLI must exit naturally: ' + stderr
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
  const uriPending = new Set<Promise<void>>()
  const respond = async (
    frame: RpcFrame,
    result: { content?: string; isError?: boolean; error?: string }
  ): Promise<void> => {
    const bytes = Buffer.from(
      JSON.stringify({ type: 'host_uri_result', id: frame.id, ...result }) + '\n'
    )
    assert.ok(bytes.length <= 1024 * 1024)
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()))
    )
    replies.push({
      id: frame.id,
      frameCount: frames.length,
      childRequests: requests.filter((item) => item.actor === 'child').length
    })
  }
  connection.onEvent((frame) => {
    if (frames.length >= 4096) throw new Error('Private native frame bound exceeded')
    frames.push(frame)
    if (frame.type === 'host_uri_request') {
      const pending = (async () => {
        if (String(frame.url).startsWith('phitask://activate/'))
          await nativeTaskUntil(
            () =>
              frames.some(
                (item) =>
                  item.type === 'subagent_lifecycle' &&
                  (item.payload as { status?: string }).status === 'started'
              ),
            'actual started before activation ACK'
          )
        const supplied = options.onUri
          ? await options.onUri(frame)
          : { content: JSON.stringify({ allowed: true }) }
        if (supplied) await respond(frame, supplied)
      })().catch((error) => {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      })
      uriPending.add(pending)
      void pending.finally(() => uriPending.delete(pending))
    }
  })
  try {
    await connection.start()
    const available = await connection.request<{
      commands: Array<{ name: string; source?: string }>
    }>({ type: 'get_available_commands' })
    for (const name of ['phi-native-task-status', 'phi-native-task-stop'])
      assert.ok(
        available.commands.some((item) => item.name === name && item.source === 'extension'),
        'Private command must be discovered before sending it'
      )
    await connection.request({ type: 'set_subagent_subscription', level: 'events' })
    await connection.request({
      type: 'set_host_uri_schemes',
      schemes: [{ scheme: 'phitask', writable: true }]
    })
    await connection.request({
      type: 'set_host_tools',
      tools: [
        {
          name: 'ChildHost',
          description: 'Root-only actual RPC host roster',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value']
          },
          approval: 'read'
        }
      ]
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
    connection,
    frames,
    wireFrames,
    replies,
    requests,
    errors,
    entry,
    respond,
    stderr: () => stderr,
    trace: async (): Promise<NativeTaskRecord[]> =>
      (await readFile(tracePath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NativeTaskRecord),
    status: async (stop = false) => {
      const nonce = 'status-' + ++counter
      const completion = await connection.prompt(
        '/phi-native-task-' + (stop ? 'stop' : 'status') + ' ' + nonce
      )
      assert.equal(completion.agentInvoked, false)
      let found: NativeTaskRecord | undefined
      await nativeTaskUntil(() => {
        found = frames
          .filter(
            (frame) => frame.type === 'extension_ui_request' && typeof frame.message === 'string'
          )
          .map((frame) => {
            try {
              return JSON.parse(frame.message as string) as NativeTaskRecord
            } catch {
              return {}
            }
          })
          .find((item) => item.nonce === nonce)
        return !!found
      }, 'actual private command acknowledgement')
      return found!
    },
    close: async () => {
      try {
        await connection.close()
        assert.deepEqual(errors, [])
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}
