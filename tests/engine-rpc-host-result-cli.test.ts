import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, writeFile, unlink, symlink, link, stat, readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { PhiTool, PhiToolResult } from '../src/main/agent/engine/types'
import { RpcHostToolBridge } from '../src/main/agent/engine/rpc/host-tool-bridge'
import {
  hostResultLookupId,
  encodeHostResultEnvelope,
  signHostResultReceipt,
  type HostResultReceipt,
  HOST_RESULT_FAILURE
} from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'
import { hostUntil } from './helpers/rpc-host-tool-wire'
import { rpcHostResultFixture, resultPng } from './helpers/rpcHostResultFixture'

function echo(result: PhiToolResult): PhiTool {
  return {
    name: 'desktop_echo',
    label: 'Echo',
    description: 'Exact desktop result fixture',
    site: 'host',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => result
  }
}
async function attach(
  f: Awaited<ReturnType<typeof rpcHostResultFixture>>,
  output: PhiToolResult
): Promise<RpcHostToolBridge> {
  const run = Object.freeze({
    id: 'run-1',
    signal: f.run.signal,
    authorizeCall: (id: string, name: string) =>
      id.startsWith('large-') && name === 'desktop_echo' ? ('main' as const) : undefined
  })
  return RpcHostToolBridge.create({
    connection: f.connection,
    tools: [echo(output)],
    resultDelivery: f.delivery,
    scope: {
      sessionId: f.lease.phiSessionId,
      projectId: f.lease.projectId,
      cwd: f.cwd,
      recentUserImages: () => [],
      currentRun: () => run
    }
  })
}
const unicode = Array.from(
  { length: 24_000 },
  (_, index) =>
    Array.from({ length: 16 }, (_, offset) =>
      String.fromCodePoint(0x4e00 + ((index * 17 + offset) % 20_000))
    ).join('') + index.toString(36)
).join('')
assert.ok(unicode.length < 500_000)

for (const mode of [
  'unicode',
  'image',
  'error',
  'null-details',
  'absent-details',
  'small-error'
] as const)
  test(
    `actual private CLI restores complete ${mode} host final and next model history`,
    { timeout: 30_000 },
    async (t) => {
      const output: PhiToolResult = {
        content: [
          {
            type: 'text',
            text:
              mode === 'unicode' || mode === 'absent-details' || mode === 'null-details'
                ? unicode
                : 'exact image and structured result'
          }
        ],
        ...(mode === 'absent-details'
          ? {}
          : { details: mode === 'null-details' ? null : { full: unicode, mode } }),
        ...(mode === 'error' || mode === 'small-error' ? { isError: true } : {})
      }
      if (mode === 'image' || mode === 'error')
        output.content.push({ type: 'image', data: resultPng(), mimeType: 'image/png' })
      if (mode === 'small-error') output.details = { exactError: 'small structured failure' }
      else assert.ok(Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024)
      const f = await rpcHostResultFixture()
      t.after(() => f.close())
      const bridge = await attach(f, output)
      t.after(() => bridge.dispose())
      const id = `large-${mode}`
      f.provider.enqueue(
        { tool: { id, name: 'desktop_echo', args: {} } },
        { text: 'after complete host result' }
      )
      const prompt = await f.connection.prompt('Call desktop_echo once')
      assert.equal(prompt.status, 'completed', f.stderr())
      const end = f.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === id
      )
      assert.deepEqual(end?.result, output)
      assert.equal(end?.isError, mode === 'error' || mode === 'small-error')
      const history = await f.connection.request<{ messages: Array<Record<string, unknown>> }>({
        type: 'get_messages'
      })
      const saved = history.messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === id
      )
      // Real SDK journal persistence has its own 500k UTF-16 character text policy; this fixture remains below it.
      assert.deepEqual(saved?.content, output.content)
      assert.deepEqual(saved?.details, output.details)
      const next = JSON.stringify(f.provider.requests[1].messages)

      for (const part of output.content)
        assert.ok(
          next.includes(
            part.type === 'text' ? part.text : `data:${part.mimeType};base64,${part.data}`
          )
        )
      assert.ok(!next.includes('phi_host_result_receipt'))
      f.provider.enqueue({ text: 'next turn works' })
      assert.equal((await f.connection.prompt('Continue with saved result')).status, 'completed')
      assert.deepEqual(await readdir(f.directory), [])
    }
  )
async function assertGenericFailedPayload(
  f: Awaited<ReturnType<typeof rpcHostResultFixture>>,
  toolCallId: string,
  ended: unknown
): Promise<void> {
  const history = await f.connection.request<{ messages: Array<Record<string, unknown>> }>({
    type: 'get_messages'
  })
  const saved = history.messages.find(
    (message) => message.role === 'toolResult' && message.toolCallId === toolCallId
  )
  assert.equal(saved?.isError, true)
  const generic = [{ type: 'text', text: HOST_RESULT_FAILURE }]
  const terminal = ended as PhiToolResult
  assert.deepEqual(terminal.content, generic)
  assert.equal(terminal.isError, true)
  assert.ok(Object.keys(terminal).every((key) => ['content', 'details', 'isError'].includes(key)))
  // The real agent-loop coerceToolResult defaults absent details to an empty object.
  for (const details of [terminal.details, saved?.details]) {
    if (details !== undefined) assert.deepEqual(details, {})
  }
  assert.deepEqual(saved?.content, generic)
  for (const message of f.provider.requests[1].messages.filter(
    (message) => message.role === 'tool'
  ))
    assert.equal(message.content, HOST_RESULT_FAILURE)
  const surfaces = [
    ended,
    { content: saved?.content, details: saved?.details },
    ...f.provider.requests[1].messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
  ]
  const forbidden = [
    'phi_host_result_receipt',
    'receiptId',
    'invocationId',
    'phiSessionId',
    'leaseId',
    'sha256',
    '"mac"',
    f.lease.leaseId,
    f.lease.phiSessionId,
    f.lease.projectId,
    f.cwd,
    f.capability,
    'run-1'
  ]
  for (const surface of surfaces) {
    const json = JSON.stringify(surface)
    assert.ok(json.includes(HOST_RESULT_FAILURE))
    assert.ok(!json.includes(unicode))
    for (const marker of forbidden)
      assert.ok(!json.includes(marker), `Failed tool payload exposed transport metadata: ${marker}`)
  }
}

for (const hook of ['missing', 'throws'] as const)
  test(
    `actual private CLI ${hook} hydration hook remains explicit failure`,
    { timeout: 30_000 },
    async (t) => {
      const f = await rpcHostResultFixture({ hook })
      t.after(() => f.close())
      const bridge = await attach(f, { content: [{ type: 'text', text: unicode }] })
      t.after(() => bridge.dispose())
      f.provider.enqueue(
        { tool: { id: 'large-failed', name: 'desktop_echo', args: {} } },
        { text: 'failure observed' }
      )
      assert.equal(
        (await f.connection.prompt('Call the host tool')).status,
        'completed',
        f.stderr()
      )
      const end = f.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'large-failed'
      )
      assert.equal(end?.isError, true)
      assert.match(JSON.stringify(end?.result), new RegExp(HOST_RESULT_FAILURE))
      assert.ok(!JSON.stringify(f.provider.requests[1].messages).includes(unicode))
      await assertGenericFailedPayload(f, 'large-failed', end?.result)
    }
  )

for (const fault of [
  'bad-hash',
  'symlink',
  'hardlink',
  'malformed',
  'stale-generation',
  'path-injection',
  'other-capability'
] as const)
  test(
    `actual private CLI rejects ${fault} receipt and the following turn remains usable`,
    { timeout: 30_000 },
    async (t) => {
      const f = await rpcHostResultFixture()
      t.after(() => f.close())
      const publish = f.delivery.publish.bind(f.delivery)
      let outside: string | undefined
      f.delivery.publish = async (...args) => {
        const placeholder = await publish(...args)
        const lookup = hostResultLookupId({ ...f.lease, ...args[1] }, f.capability)
        const path = join(f.directory, `${lookup}.json`)
        const original = JSON.parse(await readFile(path, 'utf8')) as {
          receipt: HostResultReceipt
          result: PhiToolResult
        }
        const receipt = original.receipt
        if (fault === 'bad-hash')
          await writeFile(
            path,
            encodeHostResultEnvelope(
              receipt,
              Buffer.from(JSON.stringify({ ...original.result, details: { tampered: true } }))
            )
          )
        if (fault === 'symlink') {
          outside = join(f.cwd, 'must-survive.json')
          await writeFile(outside, 'outside sentinel')
          await unlink(path)
          await symlink(outside, path)
        }
        if (fault === 'hardlink') {
          outside = join(f.cwd, 'must-survive.json')
          await link(path, outside)
        }
        if (fault === 'malformed') {
          const invalid = Buffer.from('{"content":[{"type":"text","text":42}]}')
          await writeFile(
            path,
            encodeHostResultEnvelope(
              signHostResultReceipt(
                {
                  ...receipt,
                  bytes: invalid.length,
                  sha256: createHash('sha256').update(invalid).digest('hex')
                },
                f.capability
              ),
              invalid
            )
          )
        }
        if (fault === 'stale-generation')
          await writeFile(
            path,
            encodeHostResultEnvelope(
              signHostResultReceipt({ ...receipt, generation: 2 }, f.capability),
              Buffer.from(JSON.stringify(original.result))
            )
          )
        if (fault === 'path-injection')
          await writeFile(
            path,
            JSON.stringify({ ...original, receipt: { ...receipt, path: '/tmp/model-chosen' } })
          )
        if (fault === 'other-capability')
          await writeFile(
            path,
            encodeHostResultEnvelope(
              signHostResultReceipt(receipt, randomBytes(32).toString('hex')),
              Buffer.from(JSON.stringify(original.result))
            )
          )
        return placeholder
      }
      const bridge = await attach(f, {
        content: [{ type: 'text', text: unicode }],
        details: { exact: 'original' }
      })
      t.after(() => bridge.dispose())
      const id = `large-${fault}`
      f.provider.enqueue(
        { tool: { id, name: 'desktop_echo', args: {} } },
        { text: 'explicit failure handled' }
      )
      assert.equal((await f.connection.prompt('Call desktop_echo')).status, 'completed', f.stderr())
      const end = f.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === id
      )
      assert.equal(end?.isError, true)
      assert.match(JSON.stringify(end?.result), new RegExp(HOST_RESULT_FAILURE))
      assert.ok(!JSON.stringify(f.provider.requests[1].messages).includes(unicode))
      await assertGenericFailedPayload(f, id, end?.result)
      if (outside) assert.equal((await stat(outside)).isFile(), true)
      f.provider.enqueue({ text: 'next turn after failure works' })
      assert.equal(
        (await f.connection.prompt('Continue without the host tool')).status,
        'completed'
      )
    }
  )

test(
  'actual private CLI swallowed default hook timeout retains failed placeholder',
  { timeout: 45_000 },
  async (t) => {
    const f = await rpcHostResultFixture({ hook: 'timeout' })
    t.after(() => f.close())
    const bridge = await attach(f, { content: [{ type: 'text', text: unicode }] })
    t.after(() => bridge.dispose())
    f.provider.enqueue(
      { tool: { id: 'large-timeout', name: 'desktop_echo', args: {} } },
      { text: 'hook timeout handled' }
    )
    // Completion budget is disabled only in this oracle so the actual unmodified 30s SDK hook deadline can elapse.
    assert.equal(
      (await f.connection.prompt('Call desktop_echo', { timeoutMs: 0 })).status,
      'completed',
      f.stderr()
    )
    const end = f.frames.find(
      (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'large-timeout'
    )
    assert.equal(end?.isError, true)
    assert.match(JSON.stringify(end?.result), new RegExp(HOST_RESULT_FAILURE))
    await assertGenericFailedPayload(f, 'large-timeout', end?.result)
    assert.ok(
      f.frames.some(
        (frame) => frame.type === 'extension_error' && JSON.stringify(frame).includes('timed out')
      )
    )
  }
)

test(
  'actual private CLI rejects consumed receipt replay and fresh generation reuse, then accepts its own receipt',
  { timeout: 30_000 },
  async (t) => {
    const first = await rpcHostResultFixture()
    t.after(() => first.close())
    const output: PhiToolResult = {
      content: [{ type: 'text', text: unicode }],
      details: { exact: 'preserved' }
    }
    const bridge = await attach(first, output)
    t.after(() => bridge.dispose())
    let saved: Buffer | undefined
    const publish = first.delivery.publish.bind(first.delivery)
    first.delivery.publish = async (...args) => {
      const placeholder = await publish(...args)
      saved = await readFile(
        join(
          first.directory,
          `${hostResultLookupId({ ...first.lease, ...args[1] }, first.capability)}.json`
        )
      )
      return placeholder
    }
    first.provider.enqueue(
      { tool: { id: 'large-original', name: 'desktop_echo', args: {} } },
      { text: 'original complete' }
    )
    assert.equal((await first.connection.prompt('Call original')).status, 'completed')
    assert.ok(saved)
    first.delivery.publish = async (...args) => {
      const placeholder = await publish(...args)
      await writeFile(
        join(
          first.directory,
          `${hostResultLookupId({ ...first.lease, ...args[1] }, first.capability)}.json`
        ),
        saved!
      )
      return placeholder
    }
    first.provider.enqueue(
      { tool: { id: 'large-replay', name: 'desktop_echo', args: {} } },
      { text: 'replay denied' }
    )
    assert.equal((await first.connection.prompt('Call replay')).status, 'completed')
    assert.equal(
      first.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'large-replay'
      )?.isError,
      true
    )
    const second = await rpcHostResultFixture()
    t.after(() => second.close())
    const secondBridge = await attach(second, output)
    t.after(() => secondBridge.dispose())
    const secondPublish = second.delivery.publish.bind(second.delivery)
    second.delivery.publish = async (...args) => {
      const placeholder = await secondPublish(...args)
      await writeFile(
        join(
          second.directory,
          `${hostResultLookupId({ ...second.lease, ...args[1] }, second.capability)}.json`
        ),
        saved!
      )
      return placeholder
    }
    second.provider.enqueue(
      { tool: { id: 'large-original', name: 'desktop_echo', args: {} } },
      { text: 'old generation denied' }
    )
    assert.equal(
      (await second.connection.prompt('Call old generation receipt')).status,
      'completed'
    )
    assert.equal(
      second.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'large-original'
      )?.isError,
      true
    )
    second.delivery.publish = secondPublish
    second.provider.enqueue(
      { tool: { id: 'large-current', name: 'desktop_echo', args: {} } },
      { text: 'current generation works' }
    )
    assert.equal(
      (await second.connection.prompt('Call current generation receipt')).status,
      'completed'
    )
    assert.deepEqual(
      second.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'large-current'
      )?.result,
      output
    )
  }
)

test(
  'actual private CLI abort while upload is held cannot admit a late receipt or resurrect the run',
  { timeout: 30_000 },
  async (t) => {
    let started = false
    const f = await rpcHostResultFixture({
      beforeCopy: async (_remote, signal) => {
        if (started) return
        started = true
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    })
    t.after(() => f.close())
    const bridge = await attach(f, { content: [{ type: 'text', text: unicode }] })
    t.after(() => bridge.dispose())
    f.provider.enqueue({ tool: { id: 'large-cancel', name: 'desktop_echo', args: {} } })
    const pending = f.connection.prompt('Call held upload')
    await hostUntil(() => started)
    await f.connection.abort()
    assert.equal((await pending).status, 'aborted')
    await hostUntil(() => f.frames.some((frame) => frame.type === 'host_tool_cancel'))
    assert.ok(!JSON.stringify(f.frames).includes(unicode))
    assert.ok(!JSON.stringify(f.frames).includes('phi_host_result_receipt'))
    f.provider.enqueue(
      { tool: { id: 'large-after-cancel', name: 'desktop_echo', args: {} } },
      { text: 'connection and upload remain usable after cancellation' }
    )
    assert.equal(
      (await f.connection.prompt('Call the host tool after cancellation')).status,
      'completed'
    )
    assert.deepEqual(
      f.frames.find(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'large-after-cancel'
      )?.result,
      { content: [{ type: 'text', text: unicode }] }
    )
  }
)
