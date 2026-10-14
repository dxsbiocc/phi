import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import { buildBrowserTool } from '../src/main/agent/browser/browser-tool'
import { createBrowserModelGateway } from '../src/main/agent/engine/rpc/browser-model-gateway'
import { RpcHostToolBridge } from '../src/main/agent/engine/rpc/host-tool-bridge'
import { startNativeStreamCli, NATIVE_CLI_MODELS } from './helpers/rpcNativeStreamCliFixture'

async function diskText(directory: string): Promise<string> {
  let result = ''
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result += await diskText(path)
    else if (entry.isFile()) result += await readFile(path, 'utf8')
  }
  return result
}
for (const decision of ['approve', 'deny'] as const)
  test(
    `actual native CLI ${decision}: browser text enters desktop vault before server events, arguments and journal`,
    { timeout: 30_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'phi-browser-native-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const secret = 'BROWSER_TYPED_SECRET_' + decision + '_中文🙂'
      const original = {
        action: 'typeText',
        tabId: 'live-tab',
        expectedDocumentRevision: 7,
        text: secret,
        consequence: 'write'
      }
      const requests: unknown[] = []
      let turn = 0
      const upstream = createServer(async (request, response) => {
        let raw = ''
        for await (const part of request) raw += part
        const body = JSON.parse(raw)
        requests.push(body)
        const call = {
          type: 'toolCall',
          id: 'private-browser-call',
          name: 'browser',
          arguments: original,
          rawBlock: '<tool_call name="browser">' + JSON.stringify(original) + '</tool_call>',
          providerMetadata: {
            name: 'browser',
            arguments: original,
            computer: { type: 'computer', actions: [{ type: 'type', text: secret }] }
          },
          thoughtSignature: JSON.stringify({ name: 'browser', input: original })
        }
        const message = {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: NATIVE_CLI_MODELS[0],
          content: turn++ === 0 ? [call] : [{ type: 'text', text: 'Completed browser step' }],
          timestamp: 1,
          stopReason: turn === 1 ? 'toolUse' : 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          ...(turn === 1
            ? {
                providerPayload: {
                  type: 'cursorHistory',
                  wireRoute: 'synthetic-native-route',
                  digest: 'opaque-replay-digest',
                  records: [
                    JSON.stringify({
                      role: 'assistant',
                      content: [
                        {
                          type: 'tool-call',
                          toolCallId: call.id,
                          toolName: 'browser',
                          args: original
                        },
                        {
                          type: 'tool-call',
                          toolCallId: 'read-preserved',
                          toolName: 'read',
                          args: { path: 'unchanged' }
                        }
                      ]
                    })
                  ],
                  anthropic: {
                    content: [{ type: 'tool_use', id: call.id, name: 'browser', input: original }]
                  }
                }
              }
            : {})
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const events =
          turn === 1
            ? [
                { type: 'start', partial: { ...message, content: [] } },
                {
                  type: 'toolcall_start',
                  contentIndex: 0,
                  partial: { ...message, content: [{ ...call, arguments: {} }] }
                },
                {
                  type: 'toolcall_delta',
                  contentIndex: 0,
                  delta: JSON.stringify(original),
                  partial: message
                },
                { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message }
              ]
            : [
                { type: 'text_start', contentIndex: 0, partial: message },
                {
                  type: 'text_delta',
                  contentIndex: 0,
                  delta: 'Completed browser step',
                  partial: message
                },
                {
                  type: 'text_end',
                  contentIndex: 0,
                  content: 'Completed browser step',
                  partial: message
                }
              ]
        for (const event of [...events, { type: 'done', reason: message.stopReason, message }])
          response.write('data: ' + JSON.stringify(event) + '\n\n')
        response.end('data: [DONE]\n\n')
      })
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      t.after(async () => {
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      })
      const lifetime = new AbortController(),
        run = new AbortController(),
        vault = new BrowserTextVault()
      const proxy = await createBrowserModelGateway({
        lease: {
          leaseId: 'private-lease',
          sessionId: 'phi-session',
          generation: 1,
          localPort: (upstream.address() as AddressInfo).port,
          bearerToken: 'synthetic-gateway-bearer',
          models: NATIVE_CLI_MODELS.map((id) => ({
            provider: 'anthropic',
            id,
            name: id,
            reasoning: true,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 1024
          }))
        },
        vault,
        signal: lifetime.signal,
        currentRunSignal: () => run.signal
      })
      t.after(() => proxy.close())
      const cli = await startNativeStreamCli(root, `http://127.0.0.1:${proxy.port}`)
      t.after(() => cli.close())
      const frames: unknown[] = [],
        actual: unknown[] = [],
        approval: unknown[] = []
      cli.connection.onEvent((frame) => frames.push(frame))
      const browser = buildBrowserTool(
        'phi-session',
        async (request) => {
          actual.push(request.command)
          return {
            ok: true,
            snapshot: {
              sessionId: 'phi-session',
              activeTabId: null,
              revision: 1,
              tabs: [],
              capabilities: {
                presentation: 'native',
                screenshot: true,
                coordinateInput: true,
                semanticInspection: false,
                downloads: false,
                recording: false,
                persistentProfile: false
              }
            },
            screenshot: {
              mediaType: 'image/png',
              data: 'iVBORw0KGgo=',
              width: 1,
              height: 1,
              tabId: 'live-tab',
              url: 'http://127.0.0.1/form',
              documentRevision: 7
            }
          }
        },
        { takeText: (id, placeholder) => vault.take(id, placeholder), allowTypeText: () => true }
      )
      const live = Object.freeze({
        id: 'run-1',
        signal: run.signal,
        authorizeCall: (id: string, _name: string, args: Readonly<Record<string, unknown>>) => {
          approval.push(vault.approvalInput(id, args))
          assert.ok(!JSON.stringify(args).includes(secret))
          if (decision === 'deny') {
            vault.markDenied(id)
            return undefined
          }
          return 'main' as const
        }
      })
      const bridge = await RpcHostToolBridge.create({
        connection: cli.connection,
        tools: [browser],
        scope: {
          sessionId: 'phi-session',
          projectId: 'project',
          cwd: join(root, 'project'),
          currentRun: () => live,
          recentUserImages: () => []
        }
      })
      t.after(() => bridge.dispose())
      assert.equal(
        (await cli.connection.prompt('Perform browser step')).status,
        'completed',
        cli.stderr()
      )
      assert.equal(actual.length, decision === 'approve' ? 1 : 0)
      if (decision === 'approve') assert.equal((actual[0] as { text: string }).text, secret)
      assert.equal(approval.length, 1)
      if (decision === 'approve')
        assert.equal(
          (
            frames.find((frame) => (frame as { type?: string }).type === 'tool_execution_end') as {
              isError?: boolean
            }
          ).isError,
          false
        )
      const history = await cli.connection.request({ type: 'get_messages' })
      const surfaces = {
        frames,
        history,
        requests,
        approval,
        stderr: cli.stderr(),
        disk: await diskText(root)
      }
      for (const [name, surface] of Object.entries(surfaces))
        assert.ok(!JSON.stringify(surface).includes(secret), 'Private typed text reached ' + name)
      const input = approval[0] as Record<string, unknown>
      assert.deepEqual(
        vault.take('private-browser-call', input.text),
        decision === 'deny' ? { denied: true } : undefined
      )
      await proxy.close()
      assert.equal(vault.take('private-browser-call', input.text), undefined)
    }
  )
