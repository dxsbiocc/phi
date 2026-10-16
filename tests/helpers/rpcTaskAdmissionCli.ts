import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame } from '../../src/main/agent/engine/rpc/types'
import { compileRpcAgentDefinitions } from '../../src/main/agent/engine/rpc/subagents/definition-compiler'
import { rpcChildProfileFromDefinition } from '../../src/main/agent/engine/rpc/subagents/run-registry'
import { compileOptions, definition } from './rpcAgentDefinitionFixture'
import {
  nextRpcAgentAlias,
  planRpcPublishedAgentNames
} from '../../src/main/agent/engine/rpc/subagents/published-agent-names'

export interface TaskAdmissionFixture {
  root: string
  cwd: string
  agentDir: string
  nativeName: string
  defaultNativeName: string
  connection: RpcConnection
  frames: RpcFrame[]
  requests: Array<{ actor: 'root' | 'child'; body: Record<string, unknown> }>
  errors: Error[]
  close(): Promise<void>
}
function emit(res: ServerResponse, call?: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [delta, finish] of [
    [
      call
        ? { role: 'assistant', tool_calls: [call] }
        : { role: 'assistant', content: 'TASK_ADMISSION_COMPLETE' },
      null
    ],
    [{}, call ? 'tool_calls' : 'stop']
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'task-seam-response',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }) +
        '\n\n'
    )
  res.end('data: [DONE]\n\n')
}
export async function taskAdmissionCli(
  options: {
    extra?: Readonly<Record<string, unknown>>
    prepare?: (context: {
      root: string
      cwd: string
      agentDir: string
      nativeName: string
      defaultNativeName: string
    }) => Promise<void>
    ambient?: boolean
    admission?: boolean
    pythonOnlyPreflight?: boolean
    aliasPhi?: boolean
    blockedConflict?: boolean
  } = {}
): Promise<TaskAdmissionFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-task-admission-')))
  const home = join(root, 'home'),
    cwd = join(root, 'project'),
    agentDir = join(home, '.omp/agent'),
    history = join(root, 'history')
  const frames: RpcFrame[] = [],
    requests: TaskAdmissionFixture['requests'] = [],
    errors: Error[] = []
  const model = {
    provider: 'fixture',
    id: 'model',
    name: 'model',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    contextWindow: 32768,
    maxTokens: 1024
  }
  const binding = {
    serverId: 'seam',
    serverIdentitySha256: 'a'.repeat(64),
    projectId: 'seam-project',
    projectRoot: cwd
  }
  const definitions = [
    definition({
      name: 'Native',
      tools: ['write'],
      skills: [],
      systemPrompt: 'PRIVATE_TASK_SEAM',
      thinkingLevel: 'off'
    })
  ]
  const defaultNativeName = planRpcPublishedAgentNames(definitions, binding).find(
    (entry) => entry.blocking
  )!.defaultName
  const aliases = options.aliasPhi
    ? { Native: nextRpcAgentAlias('Native', new Set([defaultNativeName])) }
    : {}
  const compiled = await compileRpcAgentDefinitions(
    compileOptions({
      binding,
      definitions,
      publishedNames: aliases,
      availableModels: [model],
      availableTools: [{ name: 'write', site: 'native' }],
      availableSkills: [],
      parentThinkingLevel: 'off'
    })
  )
  const nativeName = compiled.manifest.entries.find((entry) => entry.blocking)!.nativeName
  let rootHits = 0
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url !== '/chat/completions') throw new Error('Unexpected private provider route')
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk)
        length += bytes.length
        if (length > 1024 * 1024) throw new Error('Task seam request bound exceeded')
        chunks.push(bytes)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      const tools = body.tools as Array<{ function: { name: string } }>
      const actor = tools.some((tool) => tool.function.name === 'task') ? 'root' : 'child'
      requests.push({ actor, body })
      if (requests.length > 8) throw new Error('Unexpected task seam continuation')
      if (actor === 'root' && ++rootHits === 1)
        emit(res, {
          index: 0,
          id: 'real-root-task',
          type: 'function',
          function: {
            name: 'task',
            arguments: JSON.stringify({
              i: 'Check raw task parameters',
              agent: nativeName,
              name: 'seam-child',
              task: 'Return a plain final response',
              solutionSpace: 'Private controlled fixture',
              ...options.extra
            })
          }
        })
      else emit(res)
    })().catch((error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)))
      res.writeHead(500).end('Private task seam failed')
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Private provider address absent')
    for (const path of [home, cwd, agentDir, history, join(root, 'tmp')])
      await mkdir(path, { recursive: true, mode: 0o700 })
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
            apiKey: 'synthetic-task-seam',
            models: [model]
          }
        }
      }),
      { mode: 0o600 }
    )
    await options.prepare?.({ root, cwd, agentDir, nativeName, defaultNativeName })
    const entry = compiled.manifest.entries.find((item) => item.blocking)!
    const childConfig = join(root, 'child-runtime.json')
    await writeFile(
      childConfig,
      JSON.stringify({
        schema: 1,
        nonce: 'r'.repeat(32),
        phiSessionId: 'seam-session',
        projectId: 'seam-project',
        projectRoot: cwd,
        generation: 1,
        manifestHash: compiled.manifestHash,
        manifestBinding: compiled.manifest.binding,
        capability: 'f'.repeat(64),
        profiles: [
          rpcChildProfileFromDefinition(entry, ['PRIVATE_TASK_SEAM'], model, {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${address.port}`,
            transport: 'sse'
          })
        ],
        ...(options.blockedConflict
          ? {
              blockedAgents: [
                {
                  nativeName,
                  filePath: join(cwd, '.omp/agents', `${defaultNativeName}.md`),
                  contentHash: createHash('sha256')
                    .update(await readFile(join(cwd, '.omp/agents', `${defaultNativeName}.md`)))
                    .digest('hex')
                }
              ]
            }
          : {}),
        files: compiled.files
          .filter(
            (file) =>
              file.path === `agents/${nativeName}.md` || file.path === 'phi-agent-definitions.json'
          )
          .map(({ path, sha256 }) => ({ path, sha256 })),
        policy: { mode: 'foreground-native', taskShape: 'single' }
      }),
      { mode: 0o600 }
    )
    const policy = join(root, 'startup-policy.json')
    await writeFile(
      policy,
      JSON.stringify({
        disabledProviders: options.ambient
          ? []
          : ['native', 'claude', 'codex', 'omp-plugins', 'claude-plugins'],
        mcp: { enableProjectConfig: options.ambient === true },
        extensions: options.ambient
          ? [
              join(cwd, '.omp/extensions/sentinel.ts'),
              join(agentDir, 'extensions/sentinel.ts'),
              join(cwd, '.omp/hooks/sentinel.ts')
            ]
          : [],
        skills: [],
        lsp: { enabled: false },
        memory: { enabled: false },
        tools: { xdev: false },
        ...(options.pythonOnlyPreflight ? { eval: { py: true, js: false } } : {}),
        async: { enabled: false },
        task: {
          batch: false,
          structured: false,
          isolation: { enabled: false },
          enableEffort: false,
          speculativeLaunch: false
        }
      }),
      { mode: 0o600 }
    )
    let stderr = ''
    const child = spawn(
      resolveBunExecutable(),
      [
        '--no-env-file',
        '--preload',
        fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
        fileURLToPath(new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))),
        '--mode',
        'rpc',
        '--cwd',
        cwd,
        '--provider',
        'fixture',
        '--model',
        'model',
        '--config',
        policy,
        ...(options.ambient ? [] : ['--no-extensions']),
        options.ambient ? '--extension' : '--trusted-extension',
        fileURLToPath(new URL('./rpcTaskAdmissionExtension.ts', import.meta.url)),
        '--no-skills',
        '--no-rules',
        '--no-title',
        '--no-prewalk',
        '--no-lsp',
        '--no-pty',
        '--tools',
        'task',
        '--system-prompt',
        'PRIVATE_TASK_ROOT'
      ],
      {
        cwd: options.ambient ? cwd : home,
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
          PI_CODING_AGENT_SESSION_DIR: history,
          ...(options.admission ? { PHI_TASK_ADMISSION_CONFIG: childConfig } : {}),
          NO_PROXY: '127.0.0.1,localhost',
          DO_NOT_TRACK: '1',
          PI_REQ_DEBUG: '0'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    child.stderr.on('data', (part: Buffer) => {
      stderr = (stderr + part.toString()).slice(-65536)
    })
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      }
    )
    let closing: Promise<void> | undefined
    const shutdown = (): Promise<void> =>
      (closing ??= (async () => {
        child.stdin.end()
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        try {
          assert.deepEqual(
            await closed,
            { code: 0, signal: null },
            'Task seam CLI must exit naturally: ' + stderr
          )
        } finally {
          clearTimeout(timer)
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
      if (frames.length > 4096) throw new Error('Task seam frame bound exceeded')
      frames.push(frame)
    })
    await connection.start()
    await connection.request({ type: 'set_subagent_subscription', level: 'events' })
    return {
      root,
      cwd,
      agentDir,
      nativeName,
      defaultNativeName,
      connection,
      frames,
      requests,
      errors,
      close: async () => {
        await connection.close()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
        await rm(root, { recursive: true, force: true })
        assert.deepEqual(errors, [])
      }
    }
  } catch (error) {
    server.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
export function taskProbeFrames(
  fixture: TaskAdmissionFixture,
  type: string
): Record<string, unknown>[] {
  return fixture.frames.flatMap((frame) => {
    if (frame.type !== 'extension_ui_request' || typeof frame.message !== 'string') return []
    try {
      const value = JSON.parse(frame.message) as Record<string, unknown>
      return value.type === type ? [value] : []
    } catch {
      return []
    }
  })
}
