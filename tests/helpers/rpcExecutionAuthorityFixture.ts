import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBootstrapFixture } from '../engine-contract/bootstrap-stdio-fixture'
import { createRpcExecutionAuthorityExtension } from '../../src/main/agent/engine/phi-extension/extensions/rpc-execution-authority'
import type {
  RpcExecutionLaunchIdentity,
  RpcExecutionTool
} from '../../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'

export async function executionFixture(
  options: { roster?: readonly RpcExecutionTool[]; missingExtension?: boolean } = {}
): Promise<
  Awaited<ReturnType<typeof createBootstrapFixture>> & {
    identity: RpcExecutionLaunchIdentity
    capability: string
    roster: readonly RpcExecutionTool[]
  }
> {
  const f = await createBootstrapFixture({ missingEntry: true })
  const identity: RpcExecutionLaunchIdentity = {
    nonce: f.expected.nonce,
    phiSessionId: f.expected.sessionId,
    projectId: f.expected.projectId,
    cwd: f.cwd,
    generation: 1
  }
  const capability = randomBytes(32).toString('hex')
  const roster = options.roster ?? [
    { name: 'read', site: 'native' },
    { name: 'write', site: 'native' },
    { name: 'edit', site: 'native' },
    { name: 'bash', site: 'native' }
  ]
  const privatePath = join(f.root, 'execution-private.json')
  writeFileSync(privatePath, JSON.stringify({ identity, capability, roster }), { mode: 0o600 })
  const module = fileURLToPath(
    new URL(
      '../../src/main/agent/engine/phi-extension/extensions/rpc-execution-authority.ts',
      import.meta.url
    )
  )
  const approval = fileURLToPath(
    new URL(
      '../../src/main/agent/engine/phi-extension/extensions/rpc-tool-approval.ts',
      import.meta.url
    )
  )
  writeFileSync(
    join(f.root, 'missing-entry.ts'),
    options.missingExtension
      ? 'export default () => {}'
      : `import { readFileSync } from 'node:fs';
import { createRpcExecutionAuthorityExtension } from ${JSON.stringify(module)};
import { createRpcToolApprovalExtension } from ${JSON.stringify(approval)};
export default async (pi) => {
  const execution = createRpcExecutionAuthorityExtension(JSON.parse(readFileSync(${JSON.stringify(privatePath)},'utf8')));
  await execution.extension(pi);
  await createRpcToolApprovalExtension({ readiness: execution.readiness, classifyTool: (name) => ['write','edit'].includes(name) ? 'write' : ['bash','powershell'].includes(name) ? 'exec' : name === 'desktop_echo' ? 'host' : name === 'read' ? 'read' : undefined })(pi);
};`,
    { mode: 0o600 }
  )
  try {
    await f.connection.start()
    return { ...f, identity, capability, roster }
  } catch (error) {
    await f.close()
    throw error
  }
}
export function privateHistoryText(root: string): string {
  const text: string[] = []
  const walk = (dir: string): void => {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, file.name)
      if (file.isDirectory()) walk(path)
      else if (file.isFile()) text.push(readFileSync(path).toString('utf8'))
    }
  }
  walk(root)
  return text.join('\n')
}
export async function executionUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Execution authority state did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export { deferred } from './rpc-initialization-wire'

export interface ExecutionHookContext {
  cwd: string
  agent: { kind: 'main' | 'sub'; depth: number }
  sessionManager: { getSessionId(): string }
  isIdle(): boolean
  abort(): void
  ui: { notify(message: string, level: string): void }
}
/** Narrow public-hook capture only; real CLI remains the transport/effect oracle. */
export async function captureExecutionExtension(
  options: Parameters<typeof createRpcExecutionAuthorityExtension>[0]
): Promise<{
  server: ReturnType<typeof createRpcExecutionAuthorityExtension>
  command(args: string, ctx: ExecutionHookContext): Promise<void>
  hooks: Map<string, (event: Record<string, unknown>, ctx: ExecutionHookContext) => unknown>
}> {
  const server = createRpcExecutionAuthorityExtension(options)
  const hooks = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExecutionHookContext) => unknown
  >()
  let command: ((args: string, ctx: ExecutionHookContext) => Promise<void>) | undefined
  const api = {
    on(name: string, handler: unknown): void {
      hooks.set(
        name,
        handler as (event: Record<string, unknown>, ctx: ExecutionHookContext) => unknown
      )
    },
    registerCommand(_name: string, definition: { handler: unknown }): void {
      command = definition.handler as (args: string, ctx: ExecutionHookContext) => Promise<void>
    }
  }
  type Api = Parameters<typeof server.extension>[0]
  await server.extension(api as unknown as Api)
  if (!command) throw new Error('Expected execution authority command')
  return { server, command, hooks }
}

/** Measure the actual repository MCP fixture wire schemas without SDK state or real services. */
export function fixtureMcpSchemas(): Array<{ name: string; inputSchema: Record<string, unknown> }> {
  const root = mkdtempSync(join(tmpdir(), 'phi-execution-schema-'))
  try {
    const input =
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'second' } }
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n'
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtureMcpServer.mjs', import.meta.url)),
        join(root, 'snapshot.json'),
        'success'
      ],
      {
        input,
        encoding: 'utf8',
        timeout: 3000,
        env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root }
      }
    )
    if (result.status !== 0) throw new Error('Repository MCP schema fixture failed')
    return result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .flatMap((message) => message.result?.tools ?? [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
