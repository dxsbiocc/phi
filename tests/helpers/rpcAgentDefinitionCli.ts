import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcFrame, RpcTransport } from '../../src/main/agent/engine/rpc/types'
import type { RpcAgentDefinitionCompilation } from '../../src/main/agent/engine/rpc/subagents/types'

export interface AgentDefinitionProbeResult {
  type: 'phi_agent_definition_probe'
  agents: Array<{
    name: string
    description: string
    systemPrompt: string
    tools?: string[]
    spawns?: string[]
    model?: string[]
    thinkingLevel?: string
    blocking?: boolean
    autoloadSkills?: string[]
    source: string
    filePath?: string
  }>
  task: { description: string; parameters: { properties: Record<string, unknown> }; source: string }
}

/** Private HOME/project, synthetic auth and guarded networking; no fake SDK session. */
export async function rpcAgentDefinitionCli(
  compilation: RpcAgentDefinitionCompilation,
  shadow?: { name: string; content: string }
): Promise<{ result: AgentDefinitionProbeResult; stderr: string; frames: RpcFrame[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-agent-definition-cli-')))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  const agentDir = join(home, '.omp', 'agent')
  const bundle = agentDir
  const temporary = join(root, 'tmp')
  let transport: RpcTransport | undefined
  let stderr = ''
  const frames: RpcFrame[] = []
  const connection = new RpcConnection(
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
          '--provider',
          'fixture',
          '--model',
          'model',
          '--no-extensions',
          '--trusted-extension',
          fileURLToPath(new URL('./rpcAgentDefinitionProbe.ts', import.meta.url)),
          '--no-skills',
          '--no-rules',
          '--no-title',
          '--no-prewalk',
          '--no-lsp',
          '--no-pty',
          '--no-session',
          '--tools',
          'task',
          '--system-prompt',
          'Private discovery test. Do not invoke a model.'
        ],
        {
          cwd,
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(home, '.cache'),
            XDG_DATA_HOME: join(home, '.local', 'share'),
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_SESSION_DIR: join(root, 'history'),
            NO_PROXY: '127.0.0.1,localhost',
            PI_REQ_DEBUG: '0'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      child.stderr.on('data', (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-65536)
      })
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
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
    { startupTimeoutMs: 15000, requestTimeoutMs: 10000, promptTimeoutMs: 15000 }
  )
  connection.onEvent((frame) => frames.push(frame))
  try {
    for (const dir of [home, cwd, agentDir, bundle, temporary, join(root, 'history')])
      await mkdir(dir, { recursive: true, mode: 0o700 })
    for (const file of compilation.files) {
      const path = join(bundle, file.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, file.bytes, { mode: 0o600 })
    }
    await writeFile(
      join(agentDir, 'models.yml'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:9',
            apiKey: 'synthetic-fixture-key',
            models: [
              {
                id: 'model',
                name: 'Fixture',
                reasoning: true,
                input: ['text'],
                contextWindow: 32768,
                maxTokens: 256
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
        compaction: { enabled: false },
        mcp: { enableProjectConfig: false },
        extensions: [],
        skills: [],
        memory: { enabled: false },
        lsp: { enabled: false },
        task: {
          maxConcurrency: 4,
          maxRecursionDepth: 1,
          isolation: false,
          batch: false,
          speculativeLaunch: false
        },
        eval: { tools: { enabled: false } }
      }),
      { mode: 0o600 }
    )
    if (shadow) {
      await mkdir(join(cwd, '.omp', 'agents'), { recursive: true, mode: 0o700 })
      await writeFile(join(cwd, '.omp', 'agents', `${shadow.name}.md`), shadow.content, {
        mode: 0o600
      })
    }
    await connection.start()
    const commands = await connection.request<{
      commands: Array<{ name: string; source?: string }>
    }>({ type: 'get_available_commands' })
    if (
      !commands.commands.some(
        (command) => command.name === 'phi-agent-definition-probe' && command.source === 'extension'
      )
    )
      throw new Error(`Probe command unavailable: ${stderr}`)
    const completion = await connection.prompt('/phi-agent-definition-probe')
    if (completion.agentInvoked !== false)
      throw new Error('Discovery probe unexpectedly invoked a model')
    const frame = frames.find(
      (item) =>
        item.type === 'extension_ui_request' &&
        item.method === 'notify' &&
        typeof item.message === 'string' &&
        item.message.includes('phi_agent_definition_probe')
    )
    if (!frame || typeof frame.message !== 'string')
      throw new Error(`Probe result missing: ${stderr}`)
    return { result: JSON.parse(frame.message) as AgentDefinitionProbeResult, stderr, frames }
  } catch (error) {
    throw new Error(`Private native agent CLI oracle failed: ${String(error)}\n${stderr}`, {
      cause: error
    })
  } finally {
    try {
      await connection.close()
    } finally {
      try {
        await transport?.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}
