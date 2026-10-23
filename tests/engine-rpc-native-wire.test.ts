import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  projectNativeWireBody,
  NATIVE_OPTION_WIRE_KEYS,
  NATIVE_TOOL_WIRE_KEYS
} from '../src/main/agent/engine/phi-extension/lib/rpc-native-wire'
import {
  NativeStreamIntegrityError,
  NATIVE_EVENT_BYTES
} from '../src/main/agent/engine/phi-extension/lib/rpc-native-sse'

const modelId = 'fixture/one'
const tool = {
  name: 'preserved_tool',
  description: 'Exact provider description',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      settings: { type: 'object', properties: { runner: { type: 'string' } } }
    },
    required: ['query'],
    additionalProperties: false
  },
  strict: true,
  deferLoading: true,
  customFormat: { syntax: 'lark', definition: 'start: "wire"' },
  customWireName: 'apply_wire',
  native: { type: 'computer' },
  examples: [
    {
      caption: 'Keep all fields',
      call: { query: 'ordinary', settings: { runner: 'legitimate provider example' } }
    }
  ]
}
const messages = [
  {
    role: 'user',
    timestamp: 1,
    content: [
      { type: 'text', text: 'ordinary' },
      { type: 'image', data: 'AA==', mimeType: 'image/png' }
    ]
  },
  {
    role: 'assistant',
    timestamp: 2,
    provider: 'fixture',
    model: 'one',
    api: 'anthropic-messages',
    content: [
      {
        type: 'thinking',
        thinking: 'ordinary signed thought',
        thinkingSignature: 'opaque-signature'
      },
      { type: 'redactedThinking', data: 'opaque-data' },
      { type: 'toolCall', name: 'preserved_tool', id: 'call', arguments: { query: 'ordinary' } }
    ]
  },
  {
    role: 'toolResult',
    timestamp: 3,
    toolCallId: 'call',
    toolName: 'preserved_tool',
    isError: false,
    content: [{ type: 'text', text: 'tool result' }]
  }
]
const body = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    modelId,
    stream: true,
    context: { messages, tools: [tool] },
    options: {},
    ...overrides
  })

test('native Tool DTO keeps all pinned provider fields, schemas/order and exact canonical history', () => {
  const source = {
    systemPrompt: ['Exact system'],
    messages,
    tools: [
      {
        ...tool,
        runner: { private: 'local-marker' },
        session: { capability: 'local-capability' },
        execute: 'local-executor',
        label: 'local-label'
      },
      { ...tool, name: 'second' }
    ],
    inactiveTools: [{ ...tool, name: 'inactive', settings: { private: 'local-marker' } }],
    host: { private: 'local-marker' }
  }
  const original = structuredClone(source)
  const projected = JSON.parse(projectNativeWireBody(body({ context: source }), modelId))
  assert.deepEqual(projected.context, {
    systemPrompt: source.systemPrompt,
    messages,
    tools: [tool, { ...tool, name: 'second' }],
    inactiveTools: [{ ...tool, name: 'inactive' }]
  })
  assert.deepEqual(source, original)
  assert.equal(JSON.stringify(projected).includes('local-marker'), false)
  assert.equal(JSON.stringify(projected).includes('local-capability'), false)
  assert.deepEqual(Object.keys(projected.context.tools[0]), NATIVE_TOOL_WIRE_KEYS)
})

test('nested provider metadata excludes local implementation properties without filtering real example arguments', () => {
  const wrapped = {
    ...tool,
    customFormat: { ...tool.customFormat, runner: 'private-format-marker' },
    native: { ...tool.native, settings: 'private-native-marker' },
    examples: tool.examples.map((example) => ({ ...example, session: 'private-example-marker' }))
  }
  const output = JSON.parse(
    projectNativeWireBody(body({ context: { messages, tools: [wrapped] } }), modelId)
  )
  assert.deepEqual(output.context.tools, [tool])
  for (const marker of ['private-format-marker', 'private-native-marker', 'private-example-marker'])
    assert.equal(JSON.stringify(output).includes(marker), false)
})

test('saved dotted Phi tool names use underscore names on the provider wire', () => {
  const old = {
    messages: [
      { role: 'user', timestamp: 1, content: 'Inspect the notebook' },
      {
        role: 'assistant',
        timestamp: 2,
        provider: 'fixture',
        model: 'one',
        api: 'openai-completions',
        content: [
          {
            type: 'toolCall',
            name: 'notebook.read',
            id: 'old-call',
            arguments: { path: 'a.ipynb' }
          }
        ]
      },
      {
        role: 'toolResult',
        timestamp: 3,
        toolCallId: 'old-call',
        toolName: 'notebook.read',
        isError: false,
        content: [{ type: 'text', text: 'Saved result' }]
      }
    ],
    tools: [{ ...tool, name: 'lib.audit' }]
  }
  const original = structuredClone(old)
  const projected = JSON.parse(
    projectNativeWireBody(
      body({
        context: old,
        options: { toolChoice: { type: 'function', function: { name: 'lib.audit' } } }
      }),
      modelId
    )
  )
  assert.equal(projected.context.tools[0].name, 'lib_audit')
  assert.equal(projected.context.messages[1].content[0].name, 'notebook_read')
  assert.equal(projected.context.messages[2].toolName, 'notebook_read')
  assert.equal(projected.options.toolChoice.function.name, 'lib_audit')
  assert.deepEqual(old, original)
})

test('native wire options match pinned server allowlist except its already discarded incoming headers', async () => {
  const source = await readFile(
    join(process.cwd(), 'node_modules/@oh-my-pi/pi-ai/src/providers/pi-native-server.ts'),
    'utf8'
  )
  const list = /const ALLOWED_OPTION_KEYS:[\s\S]*?new Set\(\[([\s\S]*?)\] as const/u.exec(
    source
  )?.[1]
  assert.ok(list)
  const expected = [...list.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu)]
    .map((match) => match[1])
    .filter((key) => key !== 'headers')
  assert.deepEqual([...NATIVE_OPTION_WIRE_KEYS], expected)
  const legal = Object.fromEntries(expected.map((key) => [key, { preserved: key }]))
  const options = {
    ...legal,
    headers: { authorization: 'private-header-marker' },
    apiKey: 'private-key-marker',
    signal: {},
    onResponse: 'private-hook-marker',
    fetch: 'private-hook-marker',
    providerSessionState: { private: 'private-state-marker' },
    speculativeToolExecution: { enabled: true, host: { settings: 'private-settings-marker' } },
    model: { baseUrl: 'http://localhost/private' },
    cwd: '/local/private'
  }
  const result = JSON.parse(projectNativeWireBody(body({ options }), modelId))
  assert.deepEqual(result.options, legal)
  for (const marker of [
    'private-header-marker',
    'private-key-marker',
    'private-hook-marker',
    'private-state-marker',
    'private-settings-marker',
    '/local/private'
  ])
    assert.equal(JSON.stringify(result).includes(marker), false)
  assert.equal(options.speculativeToolExecution.enabled, true)
})

test('invalid/mismatched/oversized native request fails before network without truncating real schemas', () => {
  for (const value of [
    undefined,
    new Uint8Array(),
    'invalid json',
    body({ modelId: 'other/model' }),
    body({ stream: false }),
    body({ context: { messages, tools: [{ name: 'x' }] } }),
    body({ options: 'wrong' })
  ])
    assert.throws(() => projectNativeWireBody(value, modelId), NativeStreamIntegrityError)
  assert.throws(
    () => projectNativeWireBody(' '.repeat(NATIVE_EVENT_BYTES + 1), modelId),
    NativeStreamIntegrityError
  )
  const many = Array.from({ length: 200 }, (_, index) => ({ ...tool, name: `tool_${index}` }))
  assert.deepEqual(
    JSON.parse(projectNativeWireBody(body({ context: { messages, tools: many } }), modelId)).context
      .tools,
    many
  )
})
