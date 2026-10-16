import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  extensionPackageBoundary,
  extensionPackageFailures
} from './helpers/extensionPackageBoundary'
import { previousExtensions } from './helpers/previousPhiExtensions'
import { isRecord as packageIsRecord } from '../src/main/agent/engine/phi-extension/lib/common'
import { isRecord as workerIsRecord } from '../src/main/agent/engine/in-process/common'
import { HOST_PROVIDED_OMP_IMPORTS } from '../src/main/agent/engine/rpc/extension-deployment/bundle'

import {
  createMainSessionExtensions,
  createRemoteProjectToolGuardExtension,
  createSpecialistExtensions,
  type PhiExtensionConfig,
  type PhiExtensionHost,
  type RemoteProjectToolInfo
} from '../src/main/agent/engine/phi-extension'

const packageRoot = resolve('src/main/agent/engine/phi-extension')
type PhiExtensionFactory = ReturnType<typeof createMainSessionExtensions>[number]

type RecordedHandler = (event: Record<string, unknown>, context?: unknown) => unknown

async function recordFactories(
  factories: readonly PhiExtensionFactory[],
  tools: readonly RemoteProjectToolInfo[] = []
): Promise<{ events: string[]; handlers: RecordedHandler[] }> {
  const events: string[] = []
  const handlers: RecordedHandler[] = []
  const pi = {
    on(event: string, handler: RecordedHandler): void {
      events.push(event)
      handlers.push(handler)
    },
    getAllTools: () => tools
  }
  for (const factory of factories) await factory(pi as never)
  return { events, handlers }
}

const FIXED_TOOL_EVENTS: Record<string, unknown>[] = [
  { toolCallId: 'read-1', toolName: 'read', input: { path: 'README.md' } },
  {
    toolCallId: 'remote-1',
    toolName: 'read',
    input: { path: 'ssh://unapproved/project/file.txt' }
  },
  {
    toolCallId: 'bash-1',
    toolName: 'bash',
    input: { command: 'nextflow run workflow.nf' }
  },
  { toolCallId: 'write-1', toolName: 'write', input: { path: '../outside.txt' } },
  { toolCallId: 'skill-1', toolName: 'plot_save', input: {} },
  { toolCallId: 'agent-1', toolName: 'Analyst', input: {} },
  { toolCallId: 'mcp-1', toolName: 'mcp__api_fetch', input: {} },
  { toolCallId: 'mcp-2', toolName: 'mcp__api_fetch', input: { path: '/anchor/file' } },
  { toolCallId: 'browser-1', toolName: 'browser', input: { action: 'typeText', text: 'private' } },
  {
    toolCallId: 'env-1',
    toolName: 'bash',
    input: { command: 'python -V', env: { PATH: '/escape', EXTRA: 'keep' } }
  },
  { toolCallId: 'notebook-1', toolName: 'notebook.run_cell', input: {} }
]

async function assertBuilderParity(
  actual: readonly PhiExtensionFactory[],
  previous: readonly PhiExtensionFactory[],
  tools: readonly RemoteProjectToolInfo[] = []
): Promise<void> {
  assert.equal(actual.length, previous.length, 'factory count differs from d422a51b')
  const actualRecord = await recordFactories(actual, tools)
  const previousRecord = await recordFactories(previous, tools)
  assert.deepEqual(actualRecord.events, previousRecord.events)
  assert.equal(actualRecord.handlers.length, previousRecord.handlers.length)
  for (let index = 0; index < actualRecord.handlers.length; index += 1) {
    const events =
      actualRecord.events[index] === 'before_agent_start'
        ? [{ systemPrompt: ['base'] }]
        : FIXED_TOOL_EVENTS
    for (const event of events) {
      const actualResult = await actualRecord.handlers[index]?.(structuredClone(event))
      const previousResult = await previousRecord.handlers[index]?.(structuredClone(event))
      // T8 changes only the environment transport: OMP 18.10 removed native
      // bash's env overlay. Keep the frozen oracle for every other decision,
      // field and handler order; verify the new shell transport separately.
      const previousInput = (previousResult as { input?: Record<string, unknown> } | undefined)
        ?.input
      const actualInput = (actualResult as { input?: Record<string, unknown> } | undefined)?.input
      if (event.toolName === 'bash' && previousInput?.env && actualInput) {
        assert.deepEqual(
          {
            ...(actualResult as object),
            input: { ...actualInput, command: previousInput.command }
          },
          previousResult,
          `factory ${index} changed more than environment transport`
        )
        assert.match(String(actualInput.command), /^__phi_bound_bash_[a-f0-9]+\(\) \{ local -x /)
        assert.match(String(actualInput.command), /; eval -- '/)
      } else {
        assert.deepEqual(
          actualResult,
          previousResult,
          `factory ${index} diverged for ${JSON.stringify(event)}`
        )
      }
    }
  }
}

function config(overrides: Partial<PhiExtensionConfig> = {}): PhiExtensionConfig {
  return {
    cwd: process.cwd(),
    projectBound: false,
    remote: false,
    enableToolApproval: false,
    sessionId: 'session-1',
    useBrowserTextVault: false,
    phiAgents: [],
    ...overrides
  }
}

function host(overrides: Partial<PhiExtensionHost> = {}): PhiExtensionHost {
  return {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => false,
    requestToolApproval: async () => undefined,
    browserApprovalInput: (_toolCallId, input) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({ allowed: true, failures: 0 }),
    remoteSkillToolNames: () => new Set(),
    remoteAgentToolDescriptions: () => new Map(),
    remoteMcpToolState: () => undefined,
    environmentBinding: () => undefined,
    hostEnvironment: () => ({}),
    ...overrides
  }
}

test('Phi extension package imports stay self-contained and OMP root stays type-only', () => {
  const [eventStream, internalUrls, agentLifecycle] = HOST_PROVIDED_OMP_IMPORTS
  const boundary = extensionPackageBoundary(packageRoot, HOST_PROVIDED_OMP_IMPORTS)
  assert.deepEqual(boundary.failures, [])
  assert.deepEqual(boundary.hostImports, [
    `extensions/rpc-child-control.ts -> ${agentLifecycle}`,
    `extensions/rpc-subagents.ts -> ${internalUrls}`,
    `lib/rpc-native-stream-adapter.ts -> ${eventStream}`,
    `rpc-entry.ts -> ${agentLifecycle}`
  ])
})

test('the copied package record predicate agrees with the worker helper', () => {
  for (const value of [
    undefined,
    null,
    true,
    0,
    'text',
    [],
    {},
    { nested: [] },
    new Date(),
    () => 1
  ]) {
    assert.equal(packageIsRecord(value), workerIsRecord(value))
  }
})

test('self-containment checker rejects runtime OMP, every external reference form, and broken relatives', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'phi-extension-boundary-'))
  try {
    mkdirSync(resolve(root, 'lib'))
    writeFileSync(resolve(root, 'lib/valid.ts'), 'export interface Valid {}\n')
    const valid = [
      "import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'",
      "import { type ExtensionFactory } from '@oh-my-pi/pi-coding-agent'",
      "export type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'",
      "export { type ExtensionFactory } from '@oh-my-pi/pi-coding-agent'",
      "type T = import('@oh-my-pi/pi-coding-agent').ExtensionFactory",
      "import type Agent = require('@oh-my-pi/pi-coding-agent')",
      "import type { AssistantMessageEvent } from '@oh-my-pi/pi-ai'",
      "import type { StreamFn } from '@oh-my-pi/pi-agent-core'",
      "import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream'",
      "import { InternalUrlRouter } from '@oh-my-pi/pi-coding-agent/internal-urls'",
      "import type { Valid } from './lib/valid.js'",
      "import { resolve } from 'node:path'",
      "import test from 'node:test'"
    ]
    writeFileSync(resolve(root, 'valid.ts'), valid.join('\n'))
    assert.deepEqual(extensionPackageFailures(root, HOST_PROVIDED_OMP_IMPORTS), [])
    const invalid = [
      ['runtime.ts', "import { createAgentSession } from '@oh-my-pi/pi-coding-agent'"],
      ['side-effect.tsx', "import '@oh-my-pi/pi-coding-agent'"],
      ['export.mts', "export * from '@oh-my-pi/pi-coding-agent'"],
      ['require.cts', "import Agent = require('@oh-my-pi/pi-coding-agent')"],
      ['dynamic.js', "import('@oh-my-pi/pi-coding-agent', { with: {} })"],
      ['require.jsx', "require('@oh-my-pi/pi-coding-agent')"],
      ['runtime-ai.ts', "import { streamSimple } from '@oh-my-pi/pi-ai'"],
      ['runtime-core.ts', "import { Agent } from '@oh-my-pi/pi-agent-core'"],
      ['named-type-coding.ts', "import type from '@oh-my-pi/pi-coding-agent'"],
      ['named-type-ai.ts', "import type, { streamSimple } from '@oh-my-pi/pi-ai'"],
      ['named-type-core.ts', "import type, * as core from '@oh-my-pi/pi-agent-core'"],
      ['dynamic-host.ts', "import('@oh-my-pi/pi-ai/utils/event-stream')"],
      ['require-host.ts', "require('@oh-my-pi/pi-ai/utils/event-stream')"],
      ['host-subpath.ts', "import * as stream from '@oh-my-pi/pi-ai/utils/event-stream/other'"],
      ['dynamic-router.ts', "import('@oh-my-pi/pi-coding-agent/internal-urls')"],
      ['require-router.ts', "require('@oh-my-pi/pi-coding-agent/internal-urls')"],
      [
        'router-subpath.ts',
        "import * as router from '@oh-my-pi/pi-coding-agent/internal-urls/router'"
      ],
      [
        'router-alias.ts',
        "import * as router from '@oh-my-pi/pi-coding-agent/internal-urls/../internal-urls'"
      ],
      ['router-suffix.ts', "import * as router from '@oh-my-pi/pi-coding-agent/internal-urls.ts'"],
      ['type.mjs', "/** @type {import('outside')} */ let value"],
      ['external.cjs', "require.resolve('outside')"],
      ['type.ts', "type T = import('outside').Type"],
      ['type-export.ts', "export type * from 'outside'"],
      ['escape.ts', "export * from '../escape'"],
      ['missing.ts', "import './not-present'"],
      ['unknown.ts', 'import(moduleName)'],
      ['subpath.ts', "import type { X } from '@oh-my-pi/pi-coding-agent/src/extension'"],
      ['fake-builtin.ts', "import 'node:missing-builtin'"],
      [
        'mixed.ts',
        "import { type ExtensionFactory, createAgentSession } from '@oh-my-pi/pi-coding-agent'"
      ]
    ]
    for (const [name, source] of invalid) writeFileSync(resolve(root, name), source)
    const failedFiles = extensionPackageFailures(root, HOST_PROVIDED_OMP_IMPORTS)
      .map((failure) => failure.split(' -> ')[0])
      .sort()
    assert.deepEqual(failedFiles, invalid.map(([name]) => name).sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote dynamic agent registrations require both declared names and exact descriptions as before T6', async () => {
  const prior = previousExtensions(config(), host())
  const tools: RemoteProjectToolInfo[] = [
    { name: 'skill_run', description: 'sentinel', sourceInfo: { source: 'extension' } },
    { name: 'Analyst', description: 'sentinel', sourceInfo: { source: 'extension' } }
  ]
  for (const toolName of ['skill_run', 'Analyst']) {
    for (const includeNames of [false, true]) {
      const options = {
        ...(includeNames ? { dynamicAgentToolNames: () => new Set<string>() } : {}),
        dynamicAgentToolDescriptions: () => new Map([[toolName, 'sentinel']])
      }
      const event = { toolName, input: { action: 'navigate', url: 'https://example.com' } }
      const actual = await recordFactories([createRemoteProjectToolGuardExtension(options)], tools)
      const previous = await recordFactories([prior.remoteGuard(options)], tools)
      const expected = await previous.handlers[0]?.(event)
      assert.equal((expected as { block?: boolean })?.block, true)
      assert.deepEqual(
        await actual.handlers[0]?.(event),
        expected,
        `${toolName}, explicit names: ${includeNames}`
      )
    }
  }
})

test('PhiExtensionConfig survives a JSON round trip unchanged', () => {
  const original = config({
    cwd: '/work/project',
    projectBound: true,
    remote: true,
    enableToolApproval: true,
    sessionId: 'session-json',
    agentRunId: 'run-json',
    useBrowserTextVault: true,
    environmentBinding: {
      ref: 'phi:python@1',
      variables: { PATH: '/runtime/bin', PHI_ENV_PREFIX: '/runtime' },
      pluginId: 'analysis'
    },
    phiAgents: [
      {
        name: 'Wrapper',
        delegationMode: 'required-first',
        fallback: { afterFailures: 2, tools: ['bash'], match: ['nextflow'] }
      }
    ]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(original)), original)
})

test('main and specialist builders preserve prior decisions except the OMP 18.10 environment transport', async () => {
  const tools: RemoteProjectToolInfo[] = [
    { name: 'plot_save', description: 'plot', sourceInfo: { source: 'extension' } },
    { name: 'Analyst', description: 'remote analyst', sourceInfo: { source: 'extension' } },
    { name: 'mcp__api_fetch', description: 'fetch', sourceInfo: { source: 'mcp' } }
  ]
  for (const remote of [false, true]) {
    for (const active of [false, true]) {
      for (const bound of [false, true]) {
        const binding = bound
          ? { ref: 'phi:python@1', variables: { PATH: '/runtime/bin' } }
          : undefined
        const extensionConfig = config({
          remote,
          projectBound: bound,
          enableToolApproval: bound,
          useBrowserTextVault: bound,
          ...(binding ? { environmentBinding: binding } : {}),
          phiAgents: bound
            ? [
                {
                  name: 'Analyst',
                  delegationMode: 'required-first',
                  fallback: { afterFailures: 1, tools: ['bash'], match: ['nextflow'] }
                }
              ]
            : []
        })
        const extensionHost = host({
          nextActionSuggestionsEnabled: async () => active,
          planModeActive: () => active,
          environmentBinding: () => binding,
          hostEnvironment: () => ({ PATH: '/host/bin', SECRET: 'hidden' }),
          fallbackReadiness: () => ({ allowed: !active, failures: active ? 0 : 1 }),
          remoteSkillToolNames: () => new Set(['plot_save']),
          remoteAgentToolDescriptions: () => new Map(bound ? [['Analyst', 'remote analyst']] : []),
          remoteMcpToolState: () => ({
            allowedToolNames: new Set(['mcp__api_fetch']),
            blockedServerReasons: new Map(),
            agentDir: '/agent',
            localProjectAnchor: '/anchor'
          }),
          requestToolApproval: async () =>
            active ? { block: true, reason: 'approval sentinel' } : null,
          browserApprovalInput: () => ({ action: 'typeText', text: '[vault]' })
        })
        const previous = previousExtensions(extensionConfig, extensionHost)
        await assertBuilderParity(
          createMainSessionExtensions(extensionConfig, extensionHost),
          previous.main,
          tools
        )
        // Specialists never receive the main browser vault or Phi agent registrations.
        const specialistConfig = { ...extensionConfig, useBrowserTextVault: false, phiAgents: [] }
        const specialistHost = {
          ...extensionHost,
          remoteAgentToolDescriptions: () => new Map<string, string>()
        }
        await assertBuilderParity(
          createSpecialistExtensions(specialistConfig, specialistHost),
          previousExtensions(specialistConfig, specialistHost).specialist,
          tools
        )
      }
    }
  }
})

test('main builder preserves local order and optional factory counts', async () => {
  const localBoundConfig = config({
    projectBound: true,
    enableToolApproval: true,
    phiAgents: [
      {
        name: 'Wrapper',
        delegationMode: 'required-first',
        fallback: { afterFailures: 1, tools: ['bash'], match: ['nextflow'] }
      }
    ]
  })
  const localBoundHost = host({
    fallbackReadiness: () => ({
      allowed: false,
      failures: 0,
      reason: 'Wrapper must be delegated first.'
    }),
    requestToolApproval: async () => ({ block: true, reason: 'approval sentinel' })
  })
  const localBoundFactories = createMainSessionExtensions(localBoundConfig, localBoundHost)
  await assertBuilderParity(
    localBoundFactories,
    previousExtensions(localBoundConfig, localBoundHost).main
  )
  const localBound = await recordFactories(localBoundFactories)
  assert.deepEqual(localBound.events, [
    'before_agent_start',
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_call'
  ])

  const localUnboundConfig = config()
  const localUnboundHost = host()
  const localUnboundFactories = createMainSessionExtensions(localUnboundConfig, localUnboundHost)
  await assertBuilderParity(
    localUnboundFactories,
    previousExtensions(localUnboundConfig, localUnboundHost).main
  )
  const localUnbound = await recordFactories(localUnboundFactories)
  assert.deepEqual(localUnbound.events, ['before_agent_start', 'tool_call', 'tool_call'])
})

test('main builder handlers retain next-action, plan, URL, boundary, fallback, and approval decisions', async () => {
  const approval = { block: true, reason: 'approval sentinel' }
  const recorded = await recordFactories(
    createMainSessionExtensions(
      config({
        projectBound: true,
        enableToolApproval: true,
        phiAgents: [
          {
            name: 'Wrapper',
            delegationMode: 'required-first',
            fallback: { afterFailures: 1, tools: ['bash'], match: ['nextflow'] }
          }
        ]
      }),
      host({
        nextActionSuggestionsEnabled: async () => true,
        planModeActive: () => true,
        fallbackReadiness: () => ({
          allowed: false,
          failures: 0,
          reason: 'Wrapper must be delegated first.'
        }),
        requestToolApproval: async () => approval
      })
    )
  )
  const next = await recorded.handlers[0]?.({ systemPrompt: ['base'] })
  assert.match(
    ((next as { systemPrompt?: string[] })?.systemPrompt ?? []).at(-1) ?? '',
    /phi_next_action_instruction/
  )
  assert.equal(
    (
      (await recorded.handlers[1]?.({ toolName: 'bash', input: { command: 'pwd' } })) as {
        block?: boolean
      }
    )?.block,
    true
  )
  assert.equal(
    (
      (await recorded.handlers[2]?.({
        toolName: 'read',
        input: { path: 'ssh://host/project/file' }
      })) as { block?: boolean }
    )?.block,
    true
  )
  assert.equal(
    (
      (await recorded.handlers[3]?.({ toolName: 'write', input: { path: '../outside' } })) as {
        block?: boolean
      }
    )?.block,
    true
  )
  assert.match(
    (
      (await recorded.handlers[4]?.({
        toolName: 'bash',
        input: { command: 'nextflow run workflow.nf' }
      })) as { reason?: string }
    )?.reason ?? '',
    /delegated first/
  )
  assert.equal(
    await recorded.handlers[5]?.({ toolCallId: 'call-1', toolName: 'bash', input: {} }),
    approval
  )
})

test('browser approval preserves d422a51b sanitized inputs, request metadata, and denial side effects', async () => {
  const extensionConfig = config({ enableToolApproval: true, useBrowserTextVault: true })
  const event = {
    toolCallId: 'browser-private',
    toolName: 'browser',
    input: { action: 'typeText', text: 'private text' }
  }
  for (const denied of [false, true]) {
    const observe = async (previous: boolean): Promise<{ effects: unknown[]; result: unknown }> => {
      const effects: unknown[] = []
      const extensionHost = host({
        requestToolApproval: async (request) => {
          effects.push(['request', request])
          return denied ? { block: true, reason: 'denied' } : null
        },
        browserApprovalInput: (toolCallId) => {
          effects.push(['vault', toolCallId])
          return { action: 'typeText', text: '[vault]' }
        },
        markBrowserTextDenied: (toolCallId) => effects.push(['denied', toolCallId])
      })
      const factories = previous
        ? previousExtensions(extensionConfig, extensionHost).main
        : createMainSessionExtensions(extensionConfig, extensionHost)
      const recorded = await recordFactories(factories)
      return { effects, result: await recorded.handlers.at(-1)?.(structuredClone(event)) }
    }
    const actual = await observe(false)
    assert.deepEqual(actual, await observe(true))
    assert.deepEqual(actual.effects, [
      ['request', { sessionId: extensionConfig.sessionId, ...event }],
      ['vault', event.toolCallId],
      ...(denied ? [['denied', event.toolCallId]] : [])
    ])
    assert.deepEqual(
      actual.result,
      denied
        ? { block: true, reason: 'denied' }
        : { input: { action: 'typeText', text: '[vault]' } }
    )
  }
})

test('main remote builder reads live skill, agent, and MCP policy from the host', async () => {
  const agentDescription = 'dynamic remote agent'
  const tools: RemoteProjectToolInfo[] = [
    { name: 'plot_save', description: 'plot', sourceInfo: { source: 'extension' } },
    { name: 'Analyst', description: agentDescription, sourceInfo: { source: 'extension' } },
    { name: 'mcp__api_fetch', description: 'fetch', sourceInfo: { source: 'mcp' } }
  ]
  const extensionHost = host({
    remoteSkillToolNames: () => new Set(['plot_save']),
    remoteAgentToolDescriptions: () => new Map([['Analyst', agentDescription]]),
    remoteMcpToolState: () => ({
      allowedToolNames: new Set(['mcp__api_fetch']),
      blockedServerReasons: new Map(),
      agentDir: '/agent',
      localProjectAnchor: '/anchor'
    })
  })
  const remoteConfig = config({
    remote: true,
    phiAgents: [{ name: 'Analyst', delegationMode: 'optional' }]
  })
  const remoteFactories = createMainSessionExtensions(remoteConfig, extensionHost)
  await assertBuilderParity(
    remoteFactories,
    previousExtensions(remoteConfig, extensionHost).main,
    tools
  )
  const recorded = await recordFactories(remoteFactories, tools)
  assert.deepEqual(recorded.events, [
    'before_agent_start',
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_call'
  ])
  const remoteGuard = recorded.handlers[2]
  assert.equal(await remoteGuard?.({ toolName: 'plot_save', input: {} }), undefined)
  assert.equal(await remoteGuard?.({ toolName: 'Analyst', input: {} }), undefined)
  assert.equal(await remoteGuard?.({ toolName: 'mcp__api_fetch', input: {} }), undefined)
})

test('plan guard follows live mode changes without rebuilding extensions', async () => {
  let active = false
  const recorded = await recordFactories(
    createMainSessionExtensions(config(), host({ planModeActive: () => active }))
  )
  const planGuard = recorded.handlers[1]
  assert.equal(await planGuard?.({ toolName: 'bash', input: { command: 'pwd' } }), undefined)
  active = true
  assert.equal(
    ((await planGuard?.({ toolName: 'bash', input: { command: 'pwd' } })) as { block?: boolean })
      ?.block,
    true
  )
})

test('specialist builder preserves remote, URL, plan, approval, and binding order', async () => {
  const binding = { ref: 'phi:python@1', variables: { PATH: '/runtime/bin' } }
  const specialistConfig = config({
    remote: true,
    enableToolApproval: true,
    agentRunId: 'run-1',
    environmentBinding: binding
  })
  const specialistHost = host({
    planModeActive: () => true,
    requestToolApproval: async () => ({ block: true, reason: 'approval sentinel' }),
    environmentBinding: () => binding,
    hostEnvironment: () => ({ PATH: '/host/bin', SECRET: 'hidden' })
  })
  const specialistFactories = createSpecialistExtensions(specialistConfig, specialistHost)
  await assertBuilderParity(
    specialistFactories,
    previousExtensions(specialistConfig, specialistHost).specialist
  )
  const recorded = await recordFactories(specialistFactories)
  assert.deepEqual(recorded.events, [
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_call'
  ])
  const rewritten = await recorded.handlers[4]?.({
    toolName: 'bash',
    input: { command: 'python run.py' }
  })
  assert.deepEqual((rewritten as { input?: { env?: unknown } })?.input?.env, binding.variables)

  const minimalConfig = config()
  const minimalHost = host()
  const minimalFactories = createSpecialistExtensions(minimalConfig, minimalHost)
  await assertBuilderParity(
    minimalFactories,
    previousExtensions(minimalConfig, minimalHost).specialist
  )
  const minimal = await recordFactories(minimalFactories)
  assert.deepEqual(minimal.events, ['tool_call', 'tool_call'])
})

test('specialist environment binding reads the rebound holder on every call', async () => {
  const binding = { ref: 'phi:python@1', variables: { PATH: '/one/bin' } }
  const recorded = await recordFactories(
    createSpecialistExtensions(
      config({ environmentBinding: binding }),
      host({ environmentBinding: () => binding, hostEnvironment: () => ({}) })
    )
  )
  const bindingHandler = recorded.handlers.at(-1)
  const first = await bindingHandler?.({ toolName: 'bash', input: { command: 'python -V' } })
  assert.deepEqual((first as { input?: { env?: unknown } })?.input?.env, { PATH: '/one/bin' })
  binding.ref = 'phi:python@2'
  binding.variables = { PATH: '/two/bin' }
  const second = await bindingHandler?.({ toolName: 'bash', input: { command: 'python -V' } })
  assert.deepEqual((second as { input?: { env?: unknown } })?.input?.env, { PATH: '/two/bin' })
})
