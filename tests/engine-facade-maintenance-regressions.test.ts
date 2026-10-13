import test from 'node:test'
import assert from 'node:assert/strict'
import { RpcFacadeEventProjector } from '../src/main/agent/engine/rpc/facade-event-projection'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import type { PhiTool } from '../src/main/agent/engine/types'
import type { RpcFrame } from '../src/main/agent/engine/rpc/types'

const maintenance = [
  { type: 'auto_compaction_start', reason: 'threshold', action: 'shake' },
  {
    type: 'auto_compaction_end',
    action: 'shake',
    result: undefined,
    aborted: false,
    willRetry: false,
    tokensAfter: 42
  },
  {
    type: 'auto_compaction_end',
    action: 'remote',
    result: {
      summary: 'preserved summary',
      shortSummary: 'short',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 123,
      details: { domain: true },
      preserveData: { goal: 'user authored' }
    },
    aborted: false,
    willRetry: true
  },
  {
    type: 'auto_compaction_end',
    action: 'context-full',
    result: undefined,
    aborted: true,
    willRetry: false,
    errorMessage: 'context maintenance cancelled',
    skipped: false
  },
  {
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: 'unsupported_country_region_territory',
    errorId: 1
  },
  {
    type: 'auto_retry_end',
    success: true,
    attempt: 1,
    retryErrors: [
      {
        entryId: 'error-entry',
        persistenceKey: 'error-key',
        note: 'recovered',
        retryRecovery: {
          kind: 'auto-retry',
          status: 'recovered',
          attempt: 1,
          recoveredAt: '2026-10-14T00:00:00.000Z',
          recovery: 'plain',
          note: 'recovered',
          supersededBy: {
            timestamp: 3,
            responseId: 'answer-id',
            provider: 'synthetic',
            model: 'synthetic-model'
          }
        }
      }
    ]
  },
  {
    type: 'auto_retry_end',
    success: false,
    attempt: 2,
    finalError: 'permanent region failure',
    retryErrors: [
      {
        entryId: 'failed-entry',
        note: 'superseded',
        retryRecovery: {
          kind: 'auto-retry',
          status: 'superseded',
          attempt: 2,
          recovery: 'wait',
          note: 'superseded'
        }
      }
    ]
  }
] satisfies RpcFrame[]

test('known maintenance/retry public contracts survive exact projection without protocol extras', () => {
  const projector = new RpcFacadeEventProjector()
  const secret = 'synthetic-private-control-key'
  for (const expected of maintenance) {
    const raw: RpcFrame = structuredClone(expected)
    raw.privateCapability = secret
    if ('result' in raw && raw.result && typeof raw.result === 'object')
      Object.assign(raw.result, { privateCapability: secret })
    if ('retryErrors' in raw && Array.isArray(raw.retryErrors))
      for (const item of raw.retryErrors) {
        Object.assign(item, { privateCapability: secret })
        Object.assign(item.retryRecovery, { privateCapability: secret })
        if ('supersededBy' in item.retryRecovery)
          Object.assign(item.retryRecovery.supersededBy, { privateCapability: secret })
      }
    assert.deepEqual(projector.event(raw), expected)
    assert.equal(JSON.stringify(projector.event(raw)).includes(secret), false)
  }
})

test('malformed known maintenance fields never become public events', () => {
  const projector = new RpcFacadeEventProjector()
  for (const raw of [
    { type: 'auto_compaction_start', reason: 'unknown', action: 'shake' },
    { type: 'auto_compaction_end', action: 'shake', aborted: 'false', willRetry: false },
    {
      type: 'auto_compaction_end',
      action: 'remote',
      result: { summary: 'bad', firstKeptEntryId: 'id', tokensBefore: -1 },
      aborted: false,
      willRetry: true
    },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: -1, errorMessage: 'failure' },
    {
      type: 'auto_retry_end',
      success: true,
      attempt: 1,
      retryErrors: [{ entryId: 'id', note: 'bad', retryRecovery: { kind: 'unknown' } }]
    }
  ])
    assert.equal(projector.event(raw), undefined)
})

test(
  'actual default SDK maintenance publishes its real compaction events after genuine shake',
  { timeout: 65000 },
  async () => {
    const f = await runtimeCompositionFixture()
    const rawEvents: RpcFrame[] = [],
      publicEvents: unknown[] = []
    const projector = new RpcFacadeEventProjector()
    const original = Array.from({ length: 360000 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 20000))
    ).join('')
    const tool: PhiTool = {
      name: 'desktop_shake',
      label: 'Synthetic context pressure',
      description: 'Produce a complete synthetic host result',
      site: 'host',
      approval: 'read',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: original }] }
      }
    }
    try {
      const runtime = await f.create({ tools: [tool] })
      runtime.onEvent((frame) => {
        if (frame.type.startsWith('auto_compaction_')) {
          rawEvents.push(frame)
          const event = projector.event(frame)
          if (event) publicEvents.push(event)
        }
      })
      await f.sdk.enqueue(
        { tool: { name: tool.name, args: {}, id: 'actual-shake-call' } },
        { text: 'shake accepted' },
        ...Array.from({ length: 12 }, () => ({ text: 'Private maintenance response' }))
      )
      const turn = await runtime.prompt(
        'actual-maintenance-phi-run',
        'Call the host tool under ordinary default context pressure'
      )
      assert.equal(turn.outcome, 'completed')
      assert.ok(
        JSON.stringify(turn.snapshot.messages).includes('[shaken ~'),
        'ordinary mechanical shake occurred under unchanged default maintenance'
      )
      assert.ok(
        rawEvents.some((event) => event.type === 'auto_compaction_start'),
        JSON.stringify(rawEvents.map(({ type, action }) => ({ type, action })))
      )
      assert.ok(rawEvents.some((event) => event.type === 'auto_compaction_end'))
      assert.equal(
        publicEvents.length,
        rawEvents.length,
        'every actual supported maintenance event must reach the public consumer'
      )
      assert.ok(
        publicEvents.some(
          (event) =>
            !!event &&
            typeof event === 'object' &&
            'type' in event &&
            event.type === 'auto_compaction_end'
        )
      )
    } finally {
      await f.close()
    }
  }
)
