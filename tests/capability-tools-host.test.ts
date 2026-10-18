import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiHostRequestContext, PhiTool, PhiToolContext } from '../src/main/agent/engine/types'
import { planModeToolDecision } from '../src/main/agent/engine/phi-extension'
import { capabilityApprovalSummary } from '../src/main/agent/packages/capability-approval'
import { createCapabilityHost } from '../src/main/agent/packages/capability-host'
import type { CapabilitySearchResult } from '../src/main/agent/packages/capability-service'
import { buildCapabilityTools } from '../src/main/agent/packages/capability-tools'

const toolContext: PhiToolContext = { cwd: '/workspace', recentUserImages: () => [] }
const empty = (): CapabilitySearchResult => ({
  candidates: [],
  errors: [],
  officialAvailable: true,
  canFindExternal: true
})
const identity = {
  runtimeSessionId: 'runtime-1',
  toolCallId: 'tool-1',
  requestId: 'request-1'
}
const context = { originSessionId: 'runtime-1', toolCallId: 'tool-1' }

function fixture(): {
  host: ReturnType<typeof createCapabilityHost>
  tools: PhiTool[]
  observed: Array<{ params: unknown; context: PhiHostRequestContext }>
  retire(): void
  setResult(value: CapabilitySearchResult): void
  externalSearches(): number
} {
  let current = true
  let result = empty()
  let externalSearches = 0
  const observed: Array<{ params: unknown; context: PhiHostRequestContext }> = []
  const host = createCapabilityHost({
    service: {
      search: async (params, trusted) => {
        observed.push({ params, context: trusted })
        return result
      },
      install: async () => ({
        ok: false,
        installed: false,
        status: 'denied',
        message: 'denied'
      })
    },
    external: {
      findSkills: async () => {
        externalSearches += 1
        return { candidates: ['external'], errors: [] }
      },
      ownsCandidate: () => false,
      install: async () => ({ ok: false })
    },
    resolveRun: (id) => {
      assert.equal(id, identity.runtimeSessionId)
      return {
        assertCurrent() {
          if (!current) throw new Error('retired')
        }
      }
    }
  })
  const tools = buildCapabilityTools(
    (method, params, trusted) => Promise.resolve(host.handlers[method](params, trusted ?? {})),
    { runtimeSessionId: identity.runtimeSessionId }
  )
  return {
    host,
    tools,
    observed,
    retire: () => {
      current = false
    },
    setResult: (value: CapabilitySearchResult) => {
      result = value
    },
    externalSearches: () => externalSearches
  }
}

test('capability builders bind session and call identity and normalize connector discovery', async () => {
  const f = fixture()
  const output = await f.tools[0].execute(
    'tool-1',
    {
      query: 'molecular structure',
      type: 'connector',
      runtimeSessionId: 'peer',
      toolCallId: 'peer',
      requestId: 'peer'
    },
    undefined,
    toolContext
  )
  assert.equal(output.isError, undefined)
  const observed = f.observed[0]
  assert.equal((observed.params as Record<string, unknown>).runtimeSessionId, 'runtime-1')
  assert.equal((observed.params as Record<string, unknown>).toolCallId, 'tool-1')
  assert.equal((observed.params as Record<string, unknown>).type, 'mcp')
  assert.equal(observed.context.originSessionId, 'runtime-1')
  assert.equal(observed.context.toolCallId, 'tool-1')
  assert(observed.context.signal)
})

test('fallback cannot bypass application matches or an unavailable official source', async () => {
  const f = fixture()
  f.setResult({ ...empty(), canFindExternal: false })
  await f.tools[2].execute('tool-1', { query: 'scanpy' }, undefined, toolContext)
  assert.equal(f.externalSearches(), 0)
  f.setResult(empty())
  const result = await f.tools[2].execute('tool-1', { query: 'scanpy' }, undefined, toolContext)
  assert.equal(f.externalSearches(), 1)
  assert.deepEqual(result.details, { candidates: ['external'], errors: [] })
})

test('host refuses peer identities, unbound calls and retired runs', async () => {
  const f = fixture()
  const search = f.host.handlers['capabilities.search']
  await assert.rejects(
    Promise.resolve().then(() => search(identity, {})),
    /来源无效/
  )
  await assert.rejects(
    Promise.resolve().then(() => search(identity, { ...context, toolCallId: 'peer' })),
    /来源无效/
  )
  await assert.rejects(
    Promise.resolve().then(() => search(identity, { ...context, agentRunId: 'child' })),
    /来源无效/
  )
  f.retire()
  await assert.rejects(
    Promise.resolve().then(() => search(identity, context)),
    /retired/
  )
})

test('host cancellation is bound to the original pending tool call', async () => {
  let trusted: PhiHostRequestContext | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const host = createCapabilityHost({
    service: {
      search: async (_params, scope) => {
        trusted = scope
        started()
        await new Promise<void>((resolve) =>
          scope.signal!.addEventListener('abort', () => resolve(), { once: true })
        )
        return empty()
      },
      install: async () => ({
        ok: false,
        installed: false,
        status: 'cancelled',
        message: 'cancelled'
      })
    },
    external: { findSkills: async () => [], install: async () => null, ownsCandidate: () => false },
    resolveRun: () => ({ assertCurrent: () => undefined })
  })
  const pending = host.handlers['capabilities.search'](identity, context)
  await ready
  host.handlers['capabilities.cancel'](identity, { ...context, toolCallId: 'peer' })
  assert.equal(trusted?.signal?.aborted, false)
  host.handlers['capabilities.cancel'](identity, context)
  assert.equal(trusted?.signal?.aborted, true)
  await pending
})

test('both approved application and external installs notify resource views while denial does not', async () => {
  const notifications: unknown[] = []
  let denied = false
  const receipt = {
    ok: true as const,
    installed: true as const,
    root: { type: 'skill' as const, id: 'new-skill', version: '1.0.0' },
    packages: [],
    usage: []
  }
  const host = createCapabilityHost({
    service: {
      search: async () => empty(),
      install: async () =>
        denied ? { ok: false, installed: false, status: 'denied', message: 'denied' } : receipt
    },
    external: {
      ownsCandidate: (candidate) => candidate === 'external',
      findSkills: async () => [],
      install: async () => receipt
    },
    resolveRun: () => ({ assertCurrent: () => undefined }),
    onInstalled: (result, trusted) => {
      assert.equal(trusted.originSessionId, identity.runtimeSessionId)
      notifications.push(result)
    }
  })
  for (const candidateId of ['application', 'external'])
    await host.handlers['capabilities.install']({ ...identity, candidateId }, context)
  assert.equal(notifications.length, 2)
  denied = true
  await host.handlers['capabilities.install']({ ...identity, candidateId: 'application' }, context)
  assert.equal(notifications.length, 2)
})

test('only a confirmed successful installation triggers refresh and refresh failures preserve its receipt', async () => {
  let refreshes = 0
  let response: unknown = { ok: false, installed: false, status: 'denied' }
  const tools = buildCapabilityTools(async () => response, {
    runtimeSessionId: 'runtime-1',
    onInstalled: async () => {
      refreshes += 1
      throw new Error('resource unavailable')
    }
  })
  const install = (): ReturnType<PhiTool['execute']> =>
    tools[1].execute(
      'tool-1',
      { candidateId: 'candidate', reason: 'needed' },
      undefined,
      toolContext
    )
  assert.equal((await install()).isError, true)
  assert.equal(refreshes, 0)
  response = { ok: true, installed: true, packages: [] }
  const result = await install()
  assert.equal(refreshes, 1)
  assert.equal(result.isError, true)
  assert.deepEqual(result.details, response)
  assert.match(JSON.stringify(result.content), /模块已安装.*刷新失败/)
})

test('approval presents exact source, dependency versions and task purpose', () => {
  const summary = capabilityApprovalSummary({
    runtimeSessionId: 'runtime-1',
    candidateId: 'candidate',
    root: { type: 'wrapper', id: 'module-local-demo', version: '2.0.0' },
    action: 'install',
    reason: '分析当前样本',
    source: 'Phi Packages',
    trust: 'official',
    totalSize: 2048,
    environments: ['phi:nextflow@1'],
    packages: [
      {
        type: 'wrapper',
        id: 'module-nf-core-dependency',
        version: '1.2.3',
        title: '依赖模块',
        source: 'Phi Packages',
        trust: 'official',
        size: 2048,
        alreadyInstalled: false
      }
    ]
  })
  assert.match(summary, /module-local-demo @ 2.0.0/)
  assert.match(summary, /module-nf-core-dependency @ 1.2.3/)
  assert.match(summary, /官方签名软件源/)
  assert.match(summary, /分析当前样本/)
  assert.match(summary, /phi:nextflow@1/)
})

test('plan mode can discover modules while installation stays blocked until the plan is approved', () => {
  assert.equal(planModeToolDecision(true, 'capability_search', { query: 'scanpy' }).allowed, true)
  assert.equal(planModeToolDecision(true, 'find_skills', { query: 'scanpy' }).allowed, true)
  assert.equal(
    planModeToolDecision(true, 'capability_install', { candidateId: 'candidate' }).allowed,
    false
  )
})

test('runtimes without live refresh return an explicit installation receipt requiring a new session', async () => {
  const tools = buildCapabilityTools(async () => ({ ok: true, installed: true, packages: [] }), {
    runtimeSessionId: 'runtime-1'
  })
  const result = await tools[1].execute(
    'tool-1',
    { candidateId: 'candidate', reason: 'needed' },
    undefined,
    toolContext
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.details, {
    ok: true,
    installed: true,
    packages: [],
    requiresSessionRefresh: true,
    notice: '模块已安装。请重新打开当前会话后使用新模块。'
  })
})
