import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { JsonValue } from '../src/shared/kernel-protocol'
import {
  DESKTOP_MCP_HOST_CAPABILITIES,
  registerDesktopMcpHostBroker
} from '../src/main/agent/engine/kernel-host/desktop-mcp-broker'
import { createKernelFixture, type KernelEngineFixture } from './engine-contract/kernel-factory'
import { desktopMcpFixture, MCP_FIXTURE_SECRET } from './helpers/desktopMcpFixture'

const MCP_SERVER = fileURLToPath(new URL('./helpers/kernelA13McpServer.mjs', import.meta.url))

type McpSnapshot = {
  pid: number
  methods: string[]
  calls: Array<{ name: string; arguments: Record<string, unknown> }>
}

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}

function snapshot(path: string): McpSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as McpSnapshot
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(message)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function mcpServer(
  root: string,
  serverName: string,
  toolName: string,
  marker: string
): {
  snapshotPath: string
  schemaPath: string
  definition: { name: string; config: Record<string, unknown> }
} {
  const snapshotPath = join(root, `${serverName}-snapshot.json`)
  const schemaPath = join(root, `${serverName}-schema.json`)
  writeFileSync(schemaPath, JSON.stringify({ toolName }))
  return {
    snapshotPath,
    schemaPath,
    definition: {
      name: serverName,
      config: {
        command: process.execPath,
        args: [MCP_SERVER, snapshotPath, schemaPath],
        env: { MCP_SESSION_MARKER: marker },
        cwd: root
      }
    }
  }
}

async function createSession(
  fixture: KernelEngineFixture,
  options: {
    cwd: string
    mcpServers?: Array<{ name: string; config: Record<string, unknown> }>
    environment?: { ref: string }
    phiAgents?: Array<Record<string, unknown>>
  }
): Promise<string> {
  const created = record(
    await fixture.client.request('session.create', {
      cwd: options.cwd,
      model: { provider: fixture.model.provider, id: fixture.model.id },
      sessionManager: { kind: 'memory' },
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      autoCompaction: { enabled: false },
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.phiAgents ? { phiAgents: options.phiAgents } : {})
    } as unknown as JsonValue)
  )
  assert.equal(typeof created.sessionId, 'string')
  return created.sessionId as string
}

async function prompt(
  fixture: KernelEngineFixture,
  sessionId: string,
  text: string
): Promise<void> {
  const accepted = record(await fixture.client.request('session.prompt', { text }, { sessionId }))
  assert.equal(typeof accepted.runId, 'string')
  const completion = await fixture.waitForRun(accepted.runId as string)
  assert.equal(completion.status, 'completed', completion.detail)
}

function registerOrdinaryHostServices(fixture: KernelEngineFixture): void {
  fixture.client.registerHostCapability('settings.nextActionSuggestionsEnabled', () => false)
  fixture.client.registerHostCapability('skills.scriptTools', () => ({ tools: [] }))
}

test('A13 real kernel process refreshes stdio MCP schema and isolates two sessions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-a13-mcp-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  mkdirSync(projectA)
  mkdirSync(projectB)
  const first = mcpServer(projectA, 'alpha', 'first', 'mcp-a')
  const second = mcpServer(projectB, 'beta', 'inspect', 'mcp-b')
  const fixture = await createKernelFixture({
    hostCapabilities: [
      'settings.nextActionSuggestionsEnabled',
      'skills.scriptTools',
      'environments.bindSession'
    ]
  })
  t.after(() => fixture.close())
  registerOrdinaryHostServices(fixture)
  fixture.client.registerHostCapability('environments.bindSession', ({ ref }) => ({
    ref,
    envId: `id-${ref}`,
    variables: { SESSION_MARKER: ref }
  }))

  const sessionA = await createSession(fixture, {
    cwd: projectA,
    mcpServers: [first.definition],
    environment: { ref: 'env-a' }
  })
  const sessionB = await createSession(fixture, {
    cwd: projectB,
    mcpServers: [second.definition],
    environment: { ref: 'env-b' }
  })
  await eventually(
    () =>
      snapshot(first.snapshotPath).methods.includes('tools/list') &&
      snapshot(second.snapshotPath).methods.includes('tools/list'),
    'MCP servers were not discovered'
  )

  let requestStart = fixture.provider.requests.length
  fixture.provider.enqueue(
    { tool: { name: 'mcp__alpha_first', args: { value: 'one' }, id: 'mcp-a-one' } },
    { text: 'alpha complete' }
  )
  await prompt(fixture, sessionA, 'Use the alpha MCP tool.')
  const requestsA = fixture.provider.requests.slice(requestStart)
  assert.match(JSON.stringify(requestsA[0]), /mcp__alpha_first/)
  assert.doesNotMatch(JSON.stringify(requestsA[0]), /mcp__beta_inspect/)
  assert.match(JSON.stringify(requestsA), /mcp-a/)

  writeFileSync(first.schemaPath, JSON.stringify({ toolName: 'second' }))
  process.kill(snapshot(first.snapshotPath).pid, 'SIGUSR1')
  await eventually(
    () =>
      snapshot(first.snapshotPath).methods.filter((method) => method === 'tools/list').length >= 2,
    'MCP schema change was not observed'
  )
  requestStart = fixture.provider.requests.length
  fixture.provider.enqueue(
    { tool: { name: 'mcp__alpha_second', args: { value: 'two' }, id: 'mcp-a-two' } },
    { text: 'schema refreshed' }
  )
  await prompt(fixture, sessionA, 'Use the refreshed alpha MCP tool.')
  assert.match(JSON.stringify(fixture.provider.requests[requestStart]), /mcp__alpha_second/)

  requestStart = fixture.provider.requests.length
  fixture.provider.enqueue(
    { tool: { name: 'bash', args: { command: 'printf %s "$SESSION_MARKER"' }, id: 'env-b' } },
    { text: 'beta complete' }
  )
  await prompt(fixture, sessionB, 'Read the session environment.')
  const requestsB = fixture.provider.requests.slice(requestStart)
  assert.match(JSON.stringify(requestsB[0]), /mcp__beta_inspect/)
  assert.doesNotMatch(JSON.stringify(requestsB[0]), /mcp__alpha_/)
  assert.match(JSON.stringify(requestsB), /env-b/)

  const pidA = snapshot(first.snapshotPath).pid
  const pidB = snapshot(second.snapshotPath).pid
  await fixture.client.request('session.close', {}, { sessionId: sessionA })
  await eventually(() => !isAlive(pidA), 'first MCP server did not stop with its session')
  assert.equal(isAlive(pidB), true)
  await fixture.client.request('session.close', {}, { sessionId: sessionB })
  await eventually(() => !isAlive(pidB), 'second MCP server did not stop with its session')
})

test('A13 environment rebind and cancellation release the run lease', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-a13-env-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = await createKernelFixture({
    hostCapabilities: [
      'settings.nextActionSuggestionsEnabled',
      'skills.scriptTools',
      'environments.bindSession',
      'environments.request'
    ]
  })
  t.after(() => fixture.close())
  registerOrdinaryHostServices(fixture)
  const bindings: string[] = []
  fixture.client.registerHostCapability('environments.bindSession', ({ ref }) => {
    bindings.push(ref)
    return { ref, envId: `id-${ref}`, variables: { SESSION_MARKER: ref } }
  })
  const held = Promise.withResolvers<void>()
  let released = 0
  fixture.client.registerHostCapability('environments.request', async (params, context) => {
    if (params.packages.includes('hold-package')) {
      held.resolve()
      return new Promise((resolveRequest) => {
        context.signal.addEventListener(
          'abort',
          () => {
            released += 1
            resolveRequest({ declined: true })
          },
          { once: true }
        )
      })
    }
    return { ref: 'env-upgraded', envId: 'id-env-upgraded', name: 'upgraded', added: ['numpy'] }
  })
  const sessionId = await createSession(fixture, {
    cwd: root,
    environment: { ref: 'env-base' }
  })
  fixture.provider.enqueue(
    {
      tool: {
        name: 'env_request',
        args: { packages: ['numpy'], reason: 'A13 rebind', environment: 'env-base' },
        id: 'env-rebind'
      }
    },
    { text: 'rebound' }
  )
  await prompt(fixture, sessionId, 'Upgrade the environment.')
  assert.deepEqual(bindings, ['env-base', 'env-upgraded'])

  fixture.provider.enqueue({
    tool: {
      name: 'env_request',
      args: {
        packages: ['hold-package'],
        reason: 'A13 cancellation',
        environment: 'env-upgraded'
      },
      id: 'env-cancel'
    }
  })
  const accepted = record(
    await fixture.client.request(
      'session.prompt',
      { text: 'Start a cancellable request.' },
      { sessionId }
    )
  )
  await held.promise
  await fixture.client.request('session.abort', {}, { sessionId })
  const completion = await fixture.waitForRun(accepted.runId as string)
  assert.equal(completion.status, 'cancelled')
  assert.equal(released, 1)
})

test('A13 resource reload exposes an installed skill and adds agents live', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-a13-resources-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = await createKernelFixture({
    hostCapabilities: ['settings.nextActionSuggestionsEnabled', 'skills.scriptTools']
  })
  t.after(() => fixture.close())
  registerOrdinaryHostServices(fixture)
  const sessionId = await createSession(fixture, { cwd: root })
  const skillFile = join(root, 'live-skill', 'SKILL.md')
  mkdirSync(resolve(skillFile, '..'), { recursive: true })
  writeFileSync(
    skillFile,
    [
      '---',
      'name: live-skill',
      'description: Live reload acceptance skill.',
      '---',
      '',
      'LIVE_SKILL_MARKER'
    ].join('\n')
  )
  const addedAgent = {
    name: 'Added',
    description: 'A live-added specialist.',
    tools: [],
    skills: [],
    visibility: 'entry',
    warnings: [],
    systemPrompt: 'Return a concise specialist result.',
    source: 'phi',
    filePath: join(root, 'Added.md')
  }
  const loaded = record(
    await fixture.client.request(
      'resources.reload',
      { cwd: root, additionalSkillFiles: [skillFile], phiAgents: [addedAgent] },
      { sessionId }
    )
  )
  assert.deepEqual(loaded.agents, { applied: true, added: ['Added'] })

  const requestStart = fixture.provider.requests.length
  fixture.provider.enqueue(
    {
      tool: {
        name: 'read',
        args: { path: 'skill://live-skill/SKILL.md' },
        id: 'read-live-skill'
      }
    },
    {
      tool: {
        name: 'Added',
        args: { task: 'Confirm the live-added agent is callable.' },
        id: 'call-live-agent'
      }
    },
    { text: 'live-added child result' },
    { text: 'resources visible' }
  )
  await prompt(fixture, sessionId, 'Read the newly installed skill, then delegate to Added.')
  const nextTurn = JSON.stringify(fixture.provider.requests.slice(requestStart))
  assert.match(nextTurn, /live-skill/)
  assert.match(nextTurn, /"Added"/)
  assert.match(nextTurn, /LIVE_SKILL_MARKER/)
  assert.match(nextTurn, /live-added child result/)

  const refreshed = record(
    await fixture.client.request(
      'resources.reload',
      {
        cwd: root,
        additionalSkillFiles: [skillFile],
        phiAgents: [{ ...addedAgent, description: 'Updated specialist definition.' }]
      },
      { sessionId }
    )
  )
  assert.deepEqual(refreshed.agents, {
    applied: false,
    reason: 'requires_session_refresh',
    changed: ['Added']
  })

  const blockedStart = fixture.provider.requests.length
  fixture.provider.enqueue(
    { tool: { name: 'Added', args: { task: 'Run after update.' }, id: 'added-stale' } },
    { text: 'refresh required' }
  )
  await prompt(fixture, sessionId, 'Delegate after the agent changed.')
  assert.match(
    JSON.stringify(fixture.provider.requests.slice(blockedStart)),
    /requires a session refresh/
  )
})

test('A13 real kernel calls desktop MCP through host progress and cancellation', async (t) => {
  const desktop = await desktopMcpFixture()
  t.after(() => desktop.close())
  const fixture = await createKernelFixture({
    hostCapabilities: [
      'settings.nextActionSuggestionsEnabled',
      'skills.scriptTools',
      ...DESKTOP_MCP_HOST_CAPABILITIES
    ]
  })
  t.after(() => fixture.close())
  registerOrdinaryHostServices(fixture)
  const broker = registerDesktopMcpHostBroker(fixture.client, {
    async resolve({ kernelSessionId, cwd }) {
      return {
        identity: {
          runtimeSessionId: kernelSessionId,
          sessionId: 'phi-desktop-a13',
          projectId: 'project-desktop-a13',
          cwd
        },
        agentDir: desktop.agentDir,
        resourceCwd: desktop.resourceCwd,
        serverNames: ['fixture'],
        approvalFor: () => 'write',
        bridge: desktop.bridge
      }
    }
  })
  t.after(() => broker.close())
  const events: JsonValue[] = []
  const stopEvents = fixture.client.onEvent((event) => {
    if (event.type === 'session.event') events.push(event.payload)
  })
  t.after(stopEvents)
  const created = record(
    await fixture.client.request('session.create', {
      cwd: fixture.cwd,
      model: { provider: fixture.model.provider, id: fixture.model.id },
      sessionManager: { kind: 'memory' },
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      autoCompaction: { enabled: false },
      desktopMcp: { bindingId: 'desktop-a13' }
    })
  )
  const sessionId = created.sessionId as string
  const requestStart = fixture.provider.requests.length
  fixture.provider.enqueue({
    tool: {
      name: 'mcp__fixture_inspect',
      args: { operation: 'hold' },
      id: 'desktop-hold'
    }
  })
  const accepted = record(
    await fixture.client.request(
      'session.prompt',
      { text: 'Start the desktop MCP hold call.' },
      { sessionId }
    )
  )
  await eventually(
    () => desktop.requests.some((request) => request.method === 'tools/call'),
    'desktop MCP call did not reach the adapter'
  )
  await eventually(
    () => events.some((event) => JSON.stringify(event).includes('desktop-hold')),
    'desktop MCP progress did not reach the kernel event stream'
  )
  await fixture.client.request('session.abort', {}, { sessionId })
  const completion = await fixture.waitForRun(accepted.runId as string)
  assert.equal(completion.status, 'cancelled')
  assert.equal(desktop.requests.filter((request) => request.method === 'tools/call').length, 1)
  assert.doesNotMatch(
    JSON.stringify(fixture.provider.requests.slice(requestStart)),
    new RegExp(MCP_FIXTURE_SECRET)
  )
  await fixture.client.request('session.close', {}, { sessionId })
})
