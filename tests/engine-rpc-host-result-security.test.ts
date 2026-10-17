import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { consumeHostResultFile } from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-file'
import {
  encodeHostResult,
  encodeHostResultEnvelope,
  hostResultLookupId,
  parseHostResultReceipt,
  signHostResultReceipt,
  MAX_HOST_RESULT_BYTES,
  type HostResultReceipt
} from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'
import { RpcHostResultDelivery } from '../src/main/agent/engine/rpc/host-result-delivery'
import {
  RpcHostToolBridge,
  type RpcHostToolRun
} from '../src/main/agent/engine/rpc/host-tool-bridge'
import { resultHost, resultStartup } from './helpers/rpcHostResultFixture'
import { hostToolWire, hostUntil } from './helpers/rpc-host-tool-wire'

function fixture(): {
  root: string
  directory: string
  bytes: Buffer
  payload: Buffer
  capability: string
  receipt: HostResultReceipt
  path: string
  close(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-result-security-'))
  // macOS tmpdir may have a canonical /private ancestor.
  const canonical = requireCanonical(root)
  const directory = join(canonical, `host-results-${'a'.repeat(64)}`)
  mkdirSync(directory, { mode: 0o700 })
  const payload = encodeHostResult({
    content: [{ type: 'text', text: 'complete exact text' }],
    details: { answer: 42 },
    isError: false
  })
  const capability = randomBytes(32).toString('hex')
  const receipt = signHostResultReceipt(
    {
      type: 'phi_host_result_receipt',
      version: 1,
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: canonical,
      runId: 'run',
      invocationId: 'invocation',
      toolCallId: 'call',
      toolName: 'desktop_echo',
      receiptId: hostResultLookupId(
        {
          leaseId: 'lease',
          generation: 1,
          phiSessionId: 'phi',
          projectId: 'project',
          cwd: canonical,
          runId: 'run',
          toolCallId: 'call',
          toolName: 'desktop_echo'
        },
        capability
      ),
      bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex')
    },
    capability
  )
  const bytes = encodeHostResultEnvelope(receipt, payload)
  const path = join(directory, `${receipt.receiptId}.json`)
  writeFileSync(path, bytes, { mode: 0o600 })
  return {
    root: canonical,
    directory,
    bytes,
    payload,
    capability,
    receipt,
    path,
    close: () => rmSync(canonical, { recursive: true, force: true })
  }
}
function requireCanonical(path: string): string {
  return realpathSync(path)
}
for (const attack of [
  'symlink',
  'hardlink',
  'fifo',
  'world-readable',
  'bad-hash',
  'bad-size',
  'malformed',
  'bad-schema',
  'changed-directory'
] as const)
  test(`private host result fd rejects ${attack} without following/blocking`, () => {
    const f = fixture()
    try {
      let receipt: HostResultReceipt = f.receipt
      if (attack === 'symlink' || attack === 'fifo') {
        rmSync(f.path)
        if (attack === 'symlink') {
          const outside = join(f.root, 'outside')
          writeFileSync(outside, f.bytes, { mode: 0o600 })
          symlinkSync(outside, f.path)
        } else assert.equal(spawnSync('mkfifo', [f.path]).status, 0)
      }
      if (attack === 'hardlink') linkSync(f.path, join(f.directory, 'second-link'))
      if (attack === 'world-readable') chmodSync(f.path, 0o644)
      if (attack === 'bad-hash')
        writeFileSync(
          f.path,
          encodeHostResultEnvelope(
            receipt,
            Buffer.from(f.payload.toString().replace('complete exact text', 'changed exact text!'))
          )
        )
      if (attack === 'bad-size') {
        receipt = signHostResultReceipt({ ...receipt, bytes: receipt.bytes + 1 }, f.capability)
        writeFileSync(f.path, encodeHostResultEnvelope(receipt, f.payload))
      }
      if (attack === 'malformed') writeFileSync(f.path, '{brokenJSON')
      if (attack === 'bad-schema') {
        const invalid = Buffer.from('{"content":[{"type":"text","text":42}]}')
        receipt = signHostResultReceipt(
          {
            ...receipt,
            bytes: invalid.length,
            sha256: createHash('sha256').update(invalid).digest('hex')
          },
          f.capability
        )
        writeFileSync(f.path, encodeHostResultEnvelope(receipt, invalid))
      }
      if (attack === 'changed-directory') {
        renameSync(f.directory, `${f.directory}-old`)
        symlinkSync(`${f.directory}-old`, f.directory)
      }
      assert.throws(() =>
        consumeHostResultFile(
          f.root,
          f.directory,
          receipt,
          f.capability,
          new AbortController().signal
        )
      )
    } finally {
      f.close()
    }
  })
test('private file consumes once and aborted reads never admit payload', () => {
  const f = fixture()
  try {
    const abort = new AbortController()
    abort.abort()
    assert.throws(() =>
      consumeHostResultFile(f.root, f.directory, f.receipt, f.capability, abort.signal)
    )
    assert.equal(existsSync(f.path), true)
    assert.deepEqual(
      consumeHostResultFile(
        f.root,
        f.directory,
        f.receipt,
        f.capability,
        new AbortController().signal
      ),
      JSON.parse(f.payload.toString())
    )
    assert.equal(existsSync(f.path), false)
    assert.throws(() =>
      consumeHostResultFile(
        f.root,
        f.directory,
        f.receipt,
        f.capability,
        new AbortController().signal
      )
    )
  } finally {
    f.close()
  }
})

test('host result startup queues its private directory without a remote command', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  const host = resultHost(f.root)
  let runs = 0
  let queued: { readonly path: string; readonly ifAbsent?: boolean } | undefined
  const run = host.exec.run.bind(host.exec)
  host.exec.run = (...args) => {
    runs++
    return run(...args)
  }
  const delivery = await RpcHostResultDelivery.create({
    host,
    startup: {
      addDirectory(directory) {
        queued = directory
      },
      addFile() {
        assert.fail('Host result startup must not enqueue a file')
      }
    },
    generationDirectory: f.root,
    lease: {
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: f.root
    },
    capability: f.capability,
    signal: lifetime.signal
  })
  try {
    assert.equal(runs, 0)
    assert.deepEqual(queued, { path: delivery.directory, ifAbsent: true })
  } finally {
    await delivery.dispose()
    f.close()
  }
})
test('receipt HMAC binds every authority field and rejects paths, stale generations and other capabilities', () => {
  const f = fixture()
  try {
    assert.deepEqual(parseHostResultReceipt(f.receipt, f.capability), f.receipt)
    for (const key of [
      'leaseId',
      'phiSessionId',
      'projectId',
      'cwd',
      'runId',
      'invocationId',
      'toolCallId',
      'toolName',
      'receiptId',
      'sha256'
    ] as const)
      assert.equal(
        parseHostResultReceipt({ ...f.receipt, [key]: `${f.receipt[key]}a` }, f.capability),
        undefined
      )
    assert.equal(parseHostResultReceipt({ ...f.receipt, generation: 2 }, f.capability), undefined)
    assert.equal(
      parseHostResultReceipt({ ...f.receipt, bytes: f.receipt.bytes + 1 }, f.capability),
      undefined
    )
    assert.equal(
      parseHostResultReceipt({ ...f.receipt, path: '/tmp/model-path' }, f.capability),
      undefined
    )
    assert.equal(parseHostResultReceipt(f.receipt, randomBytes(32).toString('hex')), undefined)
  } finally {
    f.close()
  }
})
test('strict result serialization rejects cycles, accessors, coercion, nonfinite JSON and logical overflow', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const details of [
    cycle,
    new Date(),
    { value: NaN },
    { value: BigInt(1) },
    {
      get value() {
        throw new Error('getter must not execute')
      }
    },
    { toJSON: () => 'silently changed' }
  ])
    assert.throws(() => encodeHostResult({ content: [], details }))
  assert.throws(
    () =>
      encodeHostResult({ content: [{ type: 'text', text: 'x'.repeat(MAX_HOST_RESULT_BYTES) }] }),
    /logical limit/
  )
})
test('toolCallId reuse in a later authorized main run executes once per run', async () => {
  const wire = await hostToolWire()
  let executions = 0
  let run: RpcHostToolRun = Object.freeze({
    id: 'run-1',
    signal: new AbortController().signal,
    authorizeCall: () => 'main' as const
  })
  const bridge = await RpcHostToolBridge.create({
    connection: wire.connection,
    tools: [
      {
        name: 'desktop_echo',
        label: 'Echo',
        description: 'reuse id',
        site: 'host',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: String(executions) }] }
        }
      }
    ],
    scope: {
      sessionId: 'session',
      projectId: 'project',
      cwd: '/project',
      recentUserImages: () => [],
      currentRun: () => run
    }
  })
  try {
    wire.emit({
      type: 'host_tool_call',
      id: 'invoke-1',
      toolCallId: 'same-id',
      toolName: 'desktop_echo',
      arguments: {}
    })
    await hostUntil(() => wire.commands.some((command) => command.type === 'host_tool_result'))
    run = Object.freeze({ ...run, id: 'run-2', signal: new AbortController().signal })
    wire.emit({
      type: 'host_tool_call',
      id: 'invoke-2',
      toolCallId: 'same-id',
      toolName: 'desktop_echo',
      arguments: {}
    })
    await hostUntil(
      () => wire.commands.filter((command) => command.type === 'host_tool_result').length === 2
    )
    assert.equal(executions, 2)
  } finally {
    bridge.dispose()
    await wire.connection.close()
  }
})
test('cancelled queued publication cannot upload, publish or revive a retired generation', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  let uploads = 0
  let release!: () => void
  const host = resultHost(f.root, async (_path, signal) => {
    uploads++
    await new Promise<void>((resolve) => {
      release = resolve
    })
    signal?.throwIfAborted()
  })
  const delivery = await RpcHostResultDelivery.create({
    host,
    startup: resultStartup(),
    generationDirectory: f.root,
    lease: {
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: f.root
    },
    capability: f.capability,
    signal: lifetime.signal
  })
  const call = {
    runId: 'run',
    invocationId: 'invoke',
    toolCallId: 'call',
    toolName: 'desktop_echo'
  }
  try {
    const first = delivery.publish({ content: [] }, call, lifetime.signal)
    const second = delivery.publish(
      { content: [] },
      { ...call, invocationId: 'invoke-2', toolCallId: 'call-2' },
      lifetime.signal
    )
    const settled = Promise.allSettled([first, second])
    await hostUntil(() => !!release)
    lifetime.abort()
    release()
    const results = await settled
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected']
    )
    await delivery.dispose()
    assert.equal(uploads, 1)
    assert.equal(existsSync(delivery.directory), false)
    await assert.rejects(
      delivery.publish({ content: [] }, call, new AbortController().signal),
      /retired/
    )
  } finally {
    await delivery.dispose()
    f.close()
  }
})

test('publication reserves a bounded queue before waiting behind ordered progress writes', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  let release!: () => void
  let uploads = 0
  const after = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivery = await RpcHostResultDelivery.create({
    host: resultHost(f.root, async () => {
      uploads++
    }),
    startup: resultStartup(),
    generationDirectory: f.root,
    lease: {
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: f.root
    },
    capability: f.capability,
    signal: lifetime.signal
  })
  try {
    const pending = Array.from({ length: 16 }, (_, index) =>
      delivery.publish(
        { content: [] },
        {
          runId: 'run',
          invocationId: `inv-${index}`,
          toolCallId: `call-${index}`,
          toolName: 'desktop_echo'
        },
        lifetime.signal,
        after
      )
    )
    const observed = Promise.allSettled(pending)
    await assert.rejects(
      delivery.publish(
        { content: [] },
        {
          runId: 'run',
          invocationId: 'overflow',
          toolCallId: 'overflow',
          toolName: 'desktop_echo'
        },
        lifetime.signal,
        after
      ),
      /budget exhausted/
    )
    assert.equal(uploads, 0)
    lifetime.abort()
    // The progress predecessor deliberately remains unresolved through disposal.
    assert.ok((await observed).every((result) => result.status === 'rejected'))
    await delivery.dispose()
    assert.equal(uploads, 0)
  } finally {
    release()
    await delivery.dispose()
    f.close()
  }
})

test('complete result byte reservations reject aggregate overflow before any upload', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  let release!: () => void
  let uploads = 0
  const after = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivery = await RpcHostResultDelivery.create({
    host: resultHost(f.root, async () => {
      uploads++
    }),
    startup: resultStartup(),
    generationDirectory: f.root,
    lease: {
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: f.root
    },
    capability: f.capability,
    signal: lifetime.signal
  })
  const call = { runId: 'run', invocationId: 'inv', toolCallId: 'call', toolName: 'desktop_echo' }
  try {
    const large = { content: [{ type: 'text' as const, text: 'x'.repeat(31 * 1024 * 1024) }] }
    const one = delivery.publish(large, call, lifetime.signal, after)
    const two = delivery.publish(
      large,
      { ...call, invocationId: 'inv-2', toolCallId: 'call-2' },
      lifetime.signal,
      after
    )
    const observed = Promise.allSettled([one, two])
    await assert.rejects(
      delivery.publish(
        { content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }] },
        { ...call, invocationId: 'overflow', toolCallId: 'overflow' },
        lifetime.signal,
        after
      ),
      /budget exhausted/
    )
    lifetime.abort()
    release()
    assert.ok((await observed).every((result) => result.status === 'rejected'))
    assert.equal(uploads, 0)
  } finally {
    release()
    await delivery.dispose()
    f.close()
  }
})

test('opt-in delivery preserves legacy small-success serialization without uploading', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  const wire = await hostToolWire()
  let uploads = 0
  const delivery = await RpcHostResultDelivery.create({
    host: resultHost(f.root, async () => {
      uploads++
    }),
    startup: resultStartup(),
    generationDirectory: f.root,
    lease: {
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'session',
      projectId: 'project',
      cwd: '/project'
    },
    capability: f.capability,
    signal: lifetime.signal
  })
  const output = {
    content: [{ type: 'text' as const, text: 'small legacy result' }],
    details: { optional: undefined, date: new Date('2026-01-01T00:00:00Z') }
  }
  const run: RpcHostToolRun = Object.freeze({
    id: 'run',
    signal: lifetime.signal,
    authorizeCall: () => 'main'
  })
  const bridge = await RpcHostToolBridge.create({
    connection: wire.connection,
    resultDelivery: delivery,
    tools: [
      {
        name: 'desktop_echo',
        label: 'Echo',
        description: 'small JSON contract',
        site: 'host',
        parameters: { type: 'object', properties: {} },
        execute: async () => output
      }
    ],
    scope: {
      sessionId: 'session',
      projectId: 'project',
      cwd: '/project',
      recentUserImages: () => [],
      currentRun: () => run
    }
  })
  try {
    wire.emit({
      type: 'host_tool_call',
      id: 'inv',
      toolCallId: 'call',
      toolName: 'desktop_echo',
      arguments: {}
    })
    await hostUntil(() => wire.commands.some((command) => command.type === 'host_tool_result'))
    assert.deepEqual(
      wire.commands.find((command) => command.type === 'host_tool_result')?.result,
      JSON.parse(JSON.stringify(output))
    )
    assert.equal(uploads, 0)
  } finally {
    bridge.dispose()
    await delivery.dispose()
    await wire.connection.close()
    f.close()
  }
})

test('retirement while queueing the private directory preserves the primary abort', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  const host = resultHost(f.root)
  const reason = new Error('initialization retired')
  try {
    await assert.rejects(
      RpcHostResultDelivery.create({
        host,
        startup: {
          addDirectory() {
            lifetime.abort(reason)
          },
          addFile() {
            assert.fail('Host result startup must not enqueue a file')
          }
        },
        generationDirectory: f.root,
        lease: {
          leaseId: 'lease',
          generation: 1,
          phiSessionId: 'phi',
          projectId: 'project',
          cwd: f.root
        },
        capability: f.capability,
        signal: lifetime.signal
      }),
      (error) => error === reason
    )
    assert.deepEqual(readdirSync(f.root), [f.directory.split('/').at(-1)])
  } finally {
    f.close()
  }
})

test('terminal receipt cleanup uses the captured run even after the desktop run is cleared', async () => {
  const f = fixture()
  const lifetime = new AbortController()
  const wire = await hostToolWire()
  const delivery = await RpcHostResultDelivery.create({
    host: resultHost(f.root),
    startup: resultStartup(),
    generationDirectory: f.root,
    lease: {
      leaseId: 'lease',
      generation: 1,
      phiSessionId: 'session',
      projectId: 'project',
      cwd: '/project'
    },
    capability: f.capability,
    signal: lifetime.signal
  })
  let current: RpcHostToolRun | undefined = Object.freeze({
    id: 'captured-run',
    signal: lifetime.signal,
    authorizeCall: () => 'main'
  })
  const bridge = await RpcHostToolBridge.create({
    connection: wire.connection,
    resultDelivery: delivery,
    tools: [
      {
        name: 'desktop_echo',
        label: 'Echo',
        description: 'captured cleanup',
        site: 'host',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({
          content: [{ type: 'text', text: 'small structured error' }],
          details: { exact: true },
          isError: true
        })
      }
    ],
    scope: {
      sessionId: 'session',
      projectId: 'project',
      cwd: '/project',
      recentUserImages: () => [],
      currentRun: () => current
    }
  })
  const consumed = delivery.consumed.bind(delivery)
  const observed: string[][] = []
  delivery.consumed = (runId, callId) => {
    observed.push([runId, callId])
    consumed(runId, callId)
  }
  try {
    wire.emit({
      type: 'host_tool_call',
      id: 'inv',
      toolCallId: 'call',
      toolName: 'desktop_echo',
      arguments: {}
    })
    await hostUntil(() => wire.commands.some((command) => command.type === 'host_tool_result'))
    current = undefined
    wire.emit({
      type: 'tool_execution_end',
      toolCallId: 'call',
      toolName: 'desktop_echo',
      result: { content: [] },
      isError: true
    })
    assert.deepEqual(observed, [['captured-run', 'call']])
  } finally {
    bridge.dispose()
    await delivery.dispose()
    await wire.connection.close()
    f.close()
  }
})
