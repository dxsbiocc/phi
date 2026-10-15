import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import { childBatchStream } from './rpcChildAuthorityProvider'

export interface ControlSnapshot {
  id: string
  status: string
  sessionFile?: string
  parentToolCallId?: string
  index: number
}
type Request = { actor: 'root' | 'A' | 'B'; messages: Array<Record<string, unknown>> }

export async function controlUntil(
  check: () => boolean | Promise<boolean>,
  label: string
): Promise<void> {
  const deadline = Date.now() + 10000
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('Actual child control boundary not reached: ' + label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Official CLI, two private background definitions, actual native task and public control RPC. */
export async function rpcChildControlOracle(): Promise<{
  root: string
  requests: Request[]
  frames: RpcFrame[]
  readonly connection: RpcConnection
  launch(): Promise<{ sessionSettled: boolean }>
  list(): Promise<ControlSnapshot[]>
  trace(): Promise<Array<Record<string, unknown>>>
  release(id: string): Promise<void>
  wait(id: string): Promise<{ id: string; status: string }>
  messages(id: string): Promise<{ messages: unknown[]; sessionFile: string }>
  reopen(): Promise<void>
  close(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-child-control-')))
  const home = join(root, 'home'),
    cwd = join(root, 'project'),
    agentDir = join(home, '.omp/agent')
  const tracePath = join(root, 'trace.jsonl')
  const requests: Request[] = []
  const frames: RpcFrame[] = []
  const errors: Error[] = []
  let rootHits = 0
  const hits = { A: 0, B: 0 }
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: Request['messages']
        tools: Array<{ function: { name: string } }>
      }
      const system = JSON.stringify(
        body.messages.filter((message) => message.role === 'system' || message.role === 'developer')
      )
      const actor = body.tools.some((tool) => tool.function.name === 'task')
        ? 'root'
        : system.includes('CHILD_CONTROL_A')
          ? 'A'
          : 'B'
      requests.push({ actor, messages: body.messages })
      assert.ok(requests.length <= 12, 'unexpected native continuation')
      if (actor === 'root' && ++rootHits === 1) {
        childBatchStream(response, [
          {
            name: 'task',
            id: 'parallel-control-task',
            args: {
              i: 'Run two independent child controls',
              context: 'Private SDK child control contract.',
              tasks: ['A', 'B'].map((tag) => ({
                agent: 'control-profile-' + tag.toLowerCase(),
                name: 'control-' + tag.toLowerCase(),
                task: 'INITIAL_CHILD_' + tag,
                solutionSpace: 'Use only the private controllable gate.'
              }))
            }
          }
        ])
      } else if (actor !== 'root' && ++hits[actor] === 1) {
        childBatchStream(response, [
          { name: 'control_gate', id: 'gate-' + actor, args: { tag: actor } }
        ])
      } else {
        text(response, actor === 'root' ? 'ROOT_CONTROL_COMPLETE' : 'CHILD_' + actor + '_COMPLETE')
      }
    })().catch((error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)))
      if (!response.headersSent) response.writeHead(500)
      response.end('Private child control provider failed')
    })
  })
  let connection: RpcConnection | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await connection?.close()
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    })())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    for (const path of [cwd, join(agentDir, 'agents'), join(root, 'history'), join(root, 'tmp')])
      await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(tracePath, '', { mode: 0o600 })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await writeFile(
      join(agentDir, 'models.yml'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: 'synthetic-child-control-key',
            models: [
              {
                id: 'model',
                name: 'model',
                reasoning: false,
                input: ['text'],
                contextWindow: 32768,
                maxTokens: 1024
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
        defaultProvider: 'fixture',
        defaultModel: 'model',
        async: { enabled: true },
        task: {
          batch: true,
          maxConcurrency: 2,
          maxRecursionDepth: 1,
          disabledAgents: ['task', 'scout']
        },
        memory: { enabled: false },
        extensions: [],
        skills: [],
        mcp: { enableProjectConfig: false }
      }),
      { mode: 0o600 }
    )
    for (const tag of ['A', 'B'])
      await writeFile(
        join(agentDir, 'agents', tag + '.md'),
        `---\nname: control-profile-${tag.toLowerCase()}\ndescription: Private control ${tag}\nmodel: [fixture/model]\ntools: [control_gate]\nblocking: false\n---\nCHILD_CONTROL_${tag}\nUse the controllable gate once, then finish.\n`,
        { mode: 0o600 }
      )
    const open = async (sessionFile?: string): Promise<RpcConnection> => {
      const next = new RpcConnection(
        () => {
          const child = spawn(
            resolveBunExecutable(),
            [
              '--no-env-file',
              '--preload',
              fileURLToPath(new URL('../engine-contract/network-guard.ts', import.meta.url)),
              fileURLToPath(
                new URL('../dist/cli.js', import.meta.resolve('@oh-my-pi/pi-coding-agent'))
              ),
              '--mode',
              'rpc',
              '--no-extensions',
              '--trusted-extension',
              fileURLToPath(new URL('./rpcChildControlOracleExtension.ts', import.meta.url)),
              '--no-skills',
              '--no-rules',
              '--no-title',
              '--no-prewalk',
              '--no-lsp',
              '--no-pty',
              '--tools',
              'task',
              '--system-prompt',
              'ROOT_CHILD_CONTROL_CONTRACT',
              ...(sessionFile
                ? ['--session', sessionFile]
                : ['--provider', 'fixture', '--model', 'model'])
            ],
            {
              cwd,
              env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: home,
                USERPROFILE: home,
                PI_CODING_AGENT_DIR: agentDir,
                PI_CODING_AGENT_SESSION_DIR: join(root, 'history'),
                PHI_CHILD_CONTROL_TRACE: tracePath,
                TMPDIR: join(root, 'tmp'),
                XDG_CONFIG_HOME: join(home, '.config'),
                XDG_CACHE_HOME: join(home, '.cache'),
                XDG_DATA_HOME: join(home, '.local/share'),
                NO_PROXY: '127.0.0.1,localhost',
                DO_NOT_TRACK: '1'
              },
              stdio: ['pipe', 'pipe', 'pipe']
            }
          )
          let stderr = ''
          child.stderr.on('data', (bytes: Buffer) => {
            stderr = (stderr + bytes.toString()).slice(-16000)
          })
          const closed = new Promise<{ code: number | null; signal: string | null }>(
            (resolve, reject) => {
              child.once('error', reject)
              child.once('close', (code, signal) => resolve({ code, signal }))
            }
          )
          let retiring: Promise<void> | undefined
          const transport: RpcTransport = {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            closed,
            close: () =>
              (retiring ??= (async () => {
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
          void closed.then(
            (value) => {
              if (value.code && !retiring)
                errors.push(new Error('Official child control CLI exited: ' + stderr))
            },
            () => {}
          )
          return transport
        },
        { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 15000 }
      )
      next.onEvent((frame) => frames.push(frame))
      try {
        await next.start()
        await next.request({ type: 'set_subagent_subscription', level: 'events' })
        return next
      } catch (error) {
        await next.close().catch(() => {})
        throw error
      }
    }
    connection = await open()
    const current = (): RpcConnection => {
      assert.ok(connection)
      assert.equal(errors.length, 0, errors.map(String).join('\n'))
      return connection
    }
    return {
      root,
      requests,
      frames,
      get connection() {
        return current()
      },
      async launch() {
        const result = await current().prompt('Launch the two private child controls.')
        assert.equal(result.status, 'completed', JSON.stringify(frames.slice(-12)))
        assert.equal(
          result.sessionSettled,
          false,
          'early parent completion precedes child admission'
        )
        const admitted = await current().prompt('/child-control-admit')
        assert.equal(admitted.agentInvoked, false)
        assert.equal(admitted.status, 'completed')
        try {
          await controlUntil(
            async () =>
              (await readFile(tracePath, 'utf8'))
                .split('\n')
                .filter((line) => line.includes('"type":"gate"')).length === 2,
            'both real child tools held'
          )
        } catch (error) {
          throw new Error(
            'Child control launch failed: ' +
              (await readFile(tracePath, 'utf8')).slice(-12000) +
              '\nframes=' +
              JSON.stringify(frames.slice(-12)),
            { cause: error }
          )
        }
        return { sessionSettled: result.sessionSettled }
      },
      list: async () =>
        (await current().request<{ subagents: ControlSnapshot[] }>({ type: 'get_subagents' }))
          .subagents,
      trace: async () =>
        (await readFile(tracePath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      async release(id) {
        const result = await current().prompt('/child-control-release ' + id)
        assert.equal(result.agentInvoked, false)
        assert.equal(result.status, 'completed')
      },
      async wait(id) {
        const token = randomUUID()
        const result = await current().prompt('/child-control-wait ' + id + ' ' + token)
        assert.equal(result.agentInvoked, false)
        assert.equal(result.status, 'completed')
        const notification = frames.findLast(
          (frame) => typeof frame.message === 'string' && frame.message.includes(token)
        )
        assert.ok(notification)
        return JSON.parse(String(notification.message))
      },
      messages: (id) => current().request({ type: 'get_subagent_messages', subagentId: id }),
      async reopen() {
        const state = await current().request<{ sessionFile: string }>({ type: 'get_state' })
        await current().close()
        connection = await open(state.sessionFile)
      },
      close
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}

function text(response: ServerResponse, content: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content }, null],
    [{}, 'stop']
  ])
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'control-response',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }) +
        '\n\n'
    )
  response.end('data: [DONE]\n\n')
}
