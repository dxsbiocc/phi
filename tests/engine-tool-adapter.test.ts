import assert from 'node:assert/strict'
import test from 'node:test'

import { toOmpCustomTool } from '../src/main/agent/engine/tool-adapter'
import type {
  PhiTool,
  PhiToolContext,
  PhiToolImage,
  PhiToolResult
} from '../src/main/agent/engine/types'
import { buildPaletteRecommendationTool } from '../src/main/agent/palettes/tools'

function context(
  getCwd: () => string,
  getBranch?: () => unknown[]
): Parameters<ReturnType<typeof toOmpCustomTool>['execute']>[3] {
  return {
    sessionManager: {
      getCwd,
      ...(getBranch ? { getBranch } : {})
    }
  } as never
}

function basicTool(overrides: Partial<PhiTool> = {}): PhiTool {
  return {
    name: 'example',
    label: 'Example',
    description: 'Example tool.',
    parameters: { type: 'object', properties: {} },
    site: 'host',
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    ...overrides
  }
}

test('toOmpCustomTool maps every OMP field, omits Phi metadata, and preserves absent optionals', () => {
  const parameters = {
    type: 'object',
    required: ['value'],
    properties: { value: { type: 'string' } }
  }
  const mapped = toOmpCustomTool(
    basicTool({
      name: 'mapped',
      label: 'Mapped',
      description: 'Mapped tool.',
      parameters,
      site: 'runtime',
      strict: true,
      hidden: false,
      loadMode: 'essential',
      approval: 'write',
      lenientArgValidation: true
    })
  )

  assert.equal(mapped.name, 'mapped')
  assert.equal(mapped.label, 'Mapped')
  assert.equal(mapped.description, 'Mapped tool.')
  assert.strictEqual(mapped.parameters, parameters)
  assert.equal(mapped.strict, true)
  assert.equal(mapped.hidden, false)
  assert.equal(mapped.loadMode, 'essential')
  assert.equal(mapped.approval, 'write')
  assert.equal((mapped as unknown as { lenientArgValidation?: boolean }).lenientArgValidation, true)
  assert.equal('site' in mapped, false)

  const minimal = toOmpCustomTool(basicTool()) as unknown as Record<string, unknown>
  for (const field of ['strict', 'hidden', 'loadMode', 'approval', 'lenientArgValidation']) {
    assert.equal(field in minimal, false, `${field} should be absent when undefined`)
  }
})

test('execute builds cwd at call time and forwards call values, updates, and results unchanged', async () => {
  let cwd = '/first'
  let cwdCalls = 0
  let branchCalls = 0
  const params = { value: 'same object' }
  const signal = new AbortController().signal
  const update: PhiToolResult<{ phase: number }> = {
    content: [{ type: 'text', text: 'working' }],
    details: { phase: 1 }
  }
  const result: PhiToolResult<{ code: string }> = {
    content: [{ type: 'text', text: 'failed as expected' }],
    details: { code: 'EXPECTED' },
    isError: true
  }
  const updates: unknown[] = []
  const onUpdate = (partial: unknown): void => {
    updates.push(partial)
  }
  let received:
    | {
        toolCallId: string
        params: unknown
        onUpdate: unknown
        ctx: PhiToolContext
        signal: unknown
      }
    | undefined
  const adapted = toOmpCustomTool(
    basicTool({
      async execute(toolCallId, receivedParams, receivedUpdate, ctx, receivedSignal) {
        received = {
          toolCallId,
          params: receivedParams,
          onUpdate: receivedUpdate,
          ctx,
          signal: receivedSignal
        }
        receivedUpdate?.(update)
        return result
      }
    })
  )
  const ompContext = context(
    () => {
      cwdCalls += 1
      return cwd
    },
    () => {
      branchCalls += 1
      return []
    }
  )

  cwd = '/second'
  const actual = await adapted.execute('call-42', params, onUpdate as never, ompContext, signal)

  assert.equal(received?.toolCallId, 'call-42')
  assert.strictEqual(received?.params, params)
  assert.strictEqual(received?.onUpdate, onUpdate)
  assert.equal(received?.ctx.cwd, '/second')
  assert.equal(cwdCalls, 1)
  assert.strictEqual(received?.signal, signal)
  assert.deepEqual(updates, [update])
  assert.strictEqual(actual, result)
  assert.equal(branchCalls, 0, 'getBranch stays lazy when recentUserImages is unused')
})

test('recentUserImages reads lazily with newest-first, three-user, type, data, and cap rules', async () => {
  let branch: unknown[] = []
  let branchCalls = 0
  const observed: PhiToolImage[][] = []
  const adapted = toOmpCustomTool(
    basicTool({
      async execute(_id, _params, _update, ctx) {
        observed.push(ctx.recentUserImages())
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    })
  )
  const ompContext = context(
    () => '/project',
    () => {
      branchCalls += 1
      return branch
    }
  )
  const user = (content: unknown[]): unknown => ({
    type: 'message',
    message: { role: 'user', content }
  })
  const image = (data: string, mimeType = 'image/png'): PhiToolImage => ({
    type: 'image',
    data,
    mimeType
  })

  branch = [user([image('older')]), user([image('newest')])]
  await adapted.execute('newest', {}, undefined, ompContext)
  assert.deepEqual(observed.pop(), [image('newest')])

  branch = [
    user([image('fourth-too-old')]),
    user([
      image('one'),
      image('', 'image/png'),
      image('bad-mime', 'image/svg+xml'),
      image('two', 'image/jpeg'),
      image('three', 'image/gif'),
      image('four', 'image/webp'),
      image('five'),
      image('six')
    ]),
    user([{ type: 'text', text: 'second has no image' }]),
    { type: 'message', message: { role: 'assistant', content: [image('assistant')] } },
    user([image('', 'image/png')])
  ]
  await adapted.execute('third-and-cap', {}, undefined, ompContext)
  assert.deepEqual(observed.pop(), [
    image('one'),
    image('two', 'image/jpeg'),
    image('three', 'image/gif'),
    image('four', 'image/webp'),
    image('five')
  ])

  branch = [
    user([image('fourth-too-old')]),
    user([{ type: 'text', text: 'third' }]),
    user([{ type: 'text', text: 'second' }]),
    user([{ type: 'text', text: 'newest' }])
  ]
  await adapted.execute('three-message-limit', {}, undefined, ompContext)
  assert.deepEqual(observed.pop(), [])
  assert.equal(branchCalls, 3)

  const withoutBranch = toOmpCustomTool(
    basicTool({
      async execute(_id, _params, _update, ctx) {
        assert.deepEqual(ctx.recentUserImages(), [])
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    })
  )
  await withoutBranch.execute(
    'missing-getBranch',
    {},
    undefined,
    context(() => '/project')
  )
})

test('a repository Phi tool produces the same result directly and through the adapter', async () => {
  const tool = buildPaletteRecommendationTool()
  const params = { use: 'categorical', limit: 2 }
  const phiContext: PhiToolContext = { cwd: '/project', recentUserImages: () => [] }

  const direct = await tool.execute('palette-call', params, undefined, phiContext)
  const adapted = await toOmpCustomTool(tool).execute(
    'palette-call',
    params,
    undefined,
    context(() => '/project')
  )

  assert.deepEqual(adapted, direct)
  assert.equal(adapted.isError, undefined)
  assert.match(adapted.content[0]?.type === 'text' ? adapted.content[0].text : '', /categorical/u)
})
