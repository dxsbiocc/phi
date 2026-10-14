import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { OmpBridge } from '../../src/main/agent/engine/omp-bridge'
import { createDesktopMcpAdapter } from '../../src/main/agent/engine/rpc/desktop-mcp-adapter'
import type { DesktopMcpOptions } from '../../src/main/agent/engine/rpc/desktop-mcp-types'

export const MCP_FIXTURE_SCHEMA = {
  type: 'object',
  properties: { operation: { type: 'string' } },
  required: ['operation'],
  additionalProperties: false
}
export const MCP_FIXTURE_SECRET = 'synthetic-private-mcp-header'
export async function desktopMcpFixture(): Promise<{
  root: string
  agentDir: string
  resourceCwd: string
  url: string
  bridge: OmpBridge
  requests: Array<{
    method: string
    body: Record<string, unknown>
    authorization?: string
    session?: string
  }>
  adapters: Array<Awaited<ReturnType<typeof createDesktopMcpAdapter>>>
  holdList(value: boolean): void
  changeSchema(): void
  failNextToolCall(status: 401 | 403): void
  stdout(): string
  seedOAuth(accessToken: string, directory?: string): Promise<void>
  profile(value: Record<string, unknown>): Promise<void>
  adapter(extra?: Partial<DesktopMcpOptions>): ReturnType<typeof createDesktopMcpAdapter>
  close(): Promise<void>
}> {
  const bun = resolveBunExecutable()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-desktop-mcp-')))
  const agentDir = join(root, 'agent'),
    resourceCwd = join(root, 'anchor')
  for (const path of [agentDir, resourceCwd, join(root, 'home'), join(root, 'tmp')])
    await mkdir(path)
  const cert = join(root, 'cert.pem'),
    key = join(root, 'key.pem')
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE'
    ],
    { maxBuffer: 8192 }
  )
  const requests: Array<{
    method: string
    body: Record<string, unknown>
    authorization?: string
    session?: string
  }> = []
  const responses = new Set<ServerResponse>()
  const notifications = new Set<ServerResponse>()
  let heldList = false
  let schemaChanged = false
  const authFailures: number[] = []
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    async (request, response) => {
      responses.add(response)
      response.once('close', () => responses.delete(response))
      if (request.method === 'GET') {
        notifications.add(response)
        response.once('close', () => notifications.delete(response))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': fixture\n\n')
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(200).end()
        return
      }
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as Record<string, unknown>
      const method = String(body.method)
      requests.push({
        method,
        body,
        authorization: request.headers.authorization,
        session:
          typeof request.headers['mcp-session-id'] === 'string'
            ? request.headers['mcp-session-id']
            : undefined
      })
      if (body.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const reply = (result: unknown): void => {
        response.writeHead(200, {
          'content-type': 'application/json',
          ...(method === 'initialize' ? { 'mcp-session-id': randomUUID() } : {})
        })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      }
      if (method === 'initialize')
        reply({
          protocolVersion: (body.params as Record<string, unknown>).protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'real-private-mcp', version: '1' }
        })
      else if (method === 'tools/list') {
        if (heldList) return
        reply({
          tools: [
            {
              name: 'inspect',
              description: 'Actual fixture MCP tool',
              inputSchema: schemaChanged
                ? { ...MCP_FIXTURE_SCHEMA, required: [] }
                : MCP_FIXTURE_SCHEMA,
              annotations: { readOnlyHint: true }
            }
          ]
        })
      } else if (method === 'tools/call') {
        const privateHeader = request.headers.authorization ?? MCP_FIXTURE_SECRET
        const failureStatus = authFailures.shift()
        if (failureStatus) {
          response.writeHead(failureStatus, { 'content-type': 'text/plain' }).end(privateHeader)
          return
        }
        const params = body.params as Record<string, unknown>
        const operation = (params.arguments as Record<string, unknown>).operation
        if (operation === 'hold') {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken: (params._meta as Record<string, unknown>)?.progressToken,
                progress: 1,
                total: 2,
                message: MCP_FIXTURE_SECRET
              }
            })}\n\n`
          )
        } else if (operation === 'raw-error') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32603, message: privateHeader }
            })
          )
        } else if (operation === 'server-error')
          reply({ content: [{ type: 'text', text: privateHeader }], isError: true })
        else if (operation === 'secret-keys' || operation === 'secret-keys-unsafe')
          reply({
            content: [{ type: 'text', text: 'Structured key privacy fixture' }],
            structuredContent: Object.fromEntries([
              [privateHeader, 'private key value'],
              ['[redacted]', 'ordinary key value'],
              [`${privateHeader}-suffix`, 'suffix key value'],
              ['[redacted] (2)', 'ordinary second value'],
              [
                'nested',
                { [privateHeader]: 'nested key value', ordinary: 'unchanged nested value' }
              ],
              ...(operation === 'secret-keys-unsafe'
                ? [
                    ['__proto__', { polluted: true }],
                    ['constructor', 'constructor value'],
                    ['prototype', 'prototype value'],
                    ['[__proto__]', 'ordinary proto alias value']
                  ]
                : [])
            ])
          })
        else
          reply({
            content: [
              {
                type: 'text',
                text: `Complete MCP result ${String(operation)} ${privateHeader}`
              },
              ...(operation === 'image'
                ? [
                    {
                      type: 'image',
                      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=',
                      mimeType: 'image/png'
                    }
                  ]
                : []),
              ...(operation === 'large' ? [{ type: 'text', text: '完整结果🙂'.repeat(70000) }] : [])
            ],
            structuredContent: { operation, nested: { value: privateHeader } }
          })
      } else reply({})
    }
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP fixture missing port')
  const url = `https://127.0.0.1:${address.port}/mcp`
  const profile = async (value: Record<string, unknown>): Promise<void> =>
    writeFile(join(agentDir, 'mcp.json'), JSON.stringify(value), { mode: 0o600 })
  await profile({
    mcpServers: {
      fixture: {
        type: 'http',
        url,
        headers: { Authorization: MCP_FIXTURE_SECRET },
        headerPolicy: 'origin-locked'
      }
    }
  })
  let stdout = ''
  const bridge = new OmpBridge(() => {
    const child = spawn(
      bun,
      [
        '--no-env-file',
        fileURLToPath(new URL('../../src/main/agent/engine/in-process/main.ts', import.meta.url))
      ],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: agentDir,
          NODE_EXTRA_CA_CERTS: cert,
          NO_PROXY: '127.0.0.1,localhost',
          XDG_CONFIG_HOME: join(root, 'home/.config'),
          XDG_DATA_HOME: join(root, 'home/.local/share'),
          XDG_CACHE_HOME: join(root, 'home/.cache'),
          TMPDIR: join(root, 'tmp')
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    child.stdout.on('data', (bytes: Buffer) => {
      stdout = (stdout + bytes.toString()).slice(-8 * 1024 * 1024)
    })
    return child
  })
  const adapters: Array<Awaited<ReturnType<typeof createDesktopMcpAdapter>>> = []
  return {
    root,
    agentDir,
    resourceCwd,
    url,
    bridge,
    requests,
    adapters,
    holdList(value) {
      heldList = value
    },
    failNextToolCall(status) {
      authFailures.push(status)
    },
    stdout: () => stdout,
    changeSchema() {
      schemaChanged = true
      for (const response of notifications)
        response.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`
        )
    },
    async seedOAuth(accessToken, directory = agentDir) {
      await bridge.request('modelRuntime.snapshot', { agentDir: directory })
      await bridge.stop()
      const database = new DatabaseSync(join(directory, 'agent.db'))
      try {
        // Pinned18.10.3 persistence fixture, matching serializeCredential and
        // mcpOAuthCredentialId; the actual SDK owns auth loading and resolution.
        database
          .prepare(
            "INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'oauth', ?)"
          )
          .run(
            `mcp_oauth:profile:default:${url}`,
            JSON.stringify({
              access: accessToken,
              refresh: `${accessToken}-refresh`,
              expires: Date.UTC(2035, 0, 1)
            })
          )
      } finally {
        database.close()
      }
    },
    profile,
    async adapter(extra = {}) {
      const adapter = await createDesktopMcpAdapter({
        identity: {
          runtimeSessionId: randomUUID(),
          sessionId: randomUUID(),
          projectId: randomUUID(),
          cwd: '/server/project'
        },
        agentDir,
        resourceCwd,
        serverNames: ['fixture'],
        approvalFor: () => 'write',
        bridge,
        ...extra
      })
      adapters.push(adapter)
      return adapter
    },
    async close() {
      await Promise.allSettled(adapters.map((adapter) => adapter.close()))
      await bridge.stop()
      for (const response of responses) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
}
