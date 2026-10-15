import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createBrowserModelGateway } from '../src/main/agent/engine/rpc/browser-model-gateway'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import {
  createRpcChildModelHeader,
  verifyRpcChildModelHeader,
  RPC_CHILD_MODEL_HEADER
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-model-authority'
import type { RpcChildScope } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() > end) throw new Error('Child gateway boundary did not settle')
    await delay(5)
  }
}
test(
  'signed child model requests outlive the parent and cancel only their own physical HTTP request',
  { timeout: 10000 },
  async (t) => {
    const responses = new Map<string, ServerResponse>()
    const closed = new Set<string>()
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        const id = JSON.parse(body).messages[0].content
        responses.set(id, response)
        response.on('close', () => {
          closed.add(id)
        })
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const children = new Map<
      string,
      { controller: AbortController; model: AbortController; vault: BrowserTextVault }
    >()
    for (const id of ['child-a', 'child-b'])
      children.set(id, {
        controller: new AbortController(),
        model: new AbortController(),
        vault: new BrowserTextVault({ allowTypeText: false })
      })
    const capability = 'c'.repeat(64)
    const bearer = 'b'.repeat(64)
    const scope = (id: string): RpcChildScope => ({
      phiSessionId: 'phi-one',
      projectId: 'project-one',
      cwd: '/srv/project',
      generation: 1,
      rootAgentId: 'Main',
      rootOmpSessionId: 'root-sdk',
      rootSessionFile: '/srv/history/root.jsonl',
      nativeAgentId: id,
      childOmpSessionId: `sdk-${id}`,
      childSessionFile: `/srv/history/root/${id}.jsonl`,
      parentSession: '/srv/history/root.jsonl',
      nativeName: 'phi_0123456789abcdef01234567_0_bg',
      definitionHash: 'a'.repeat(64)
    })
    let main: AbortSignal | undefined
    const lifetime = new AbortController()
    const gateway = await createBrowserModelGateway({
      lease: {
        leaseId: 'test-lease',
        sessionId: 'phi-one',
        generation: 1,
        localPort: (server.address() as AddressInfo).port,
        bearerToken: bearer,
        models: [
          {
            provider: 'fixture',
            id: 'model',
            name: 'fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 10000,
            maxTokens: 1000
          }
        ]
      },
      vault: new BrowserTextVault(),
      signal: lifetime.signal,
      currentRunSignal: () => main,
      resolveChildRun: (header) => {
        const verified = verifyRpcChildModelHeader(header, capability)
        const child = verified && children.get(verified.nativeAgentId)
        return child && !child.controller.signal.aborted
          ? { signal: child.controller.signal, modelSignal: child.model.signal, vault: child.vault }
          : undefined
      }
    })
    t.after(async () => {
      await gateway.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    })
    const send = (id: string, header?: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${gateway.port}/v1/pi/stream`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          ...(header === undefined ? {} : { [RPC_CHILD_MODEL_HEADER]: header })
        },
        body: JSON.stringify({
          modelId: 'fixture/model',
          messages: [{ role: 'user', content: id }]
        })
      })
    assert.equal((await send('main-ended')).status, 502)
    main = new AbortController().signal
    assert.equal(
      (await send('forged-child', 'forged')).status,
      502,
      'a bad child header cannot inherit an active main run'
    )
    assert.equal(responses.size, 0)
    main = undefined
    const a = send('a', createRpcChildModelHeader(scope('child-a'), capability))
    const b = send('b', createRpcChildModelHeader(scope('child-b'), capability))
    await until(() => responses.size === 2)
    children.get('child-a')!.controller.abort()
    assert.equal(
      (await send('a-revoked', createRpcChildModelHeader(scope('child-a'), capability))).status,
      502
    )
    assert.equal(
      closed.has('a'),
      false,
      'Execution retirement does not truncate an admitted model transport'
    )
    children.get('child-a')!.model.abort()
    assert.equal((await a).status, 502)
    await until(() => closed.has('a'))
    assert.equal(closed.has('b'), false)
    assert.equal(children.get('child-b')!.controller.signal.aborted, false)
    responses.get('b')!.writeHead(503).end('synthetic upstream ended')
    assert.equal((await b).status, 502)
    children.delete('child-b')
    assert.equal(
      (await send('retired-b', createRpcChildModelHeader(scope('child-b'), capability))).status,
      502
    )
    assert.equal(responses.size, 2, 'retired child identity reaches no upstream request')
  }
)
