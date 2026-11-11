import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSpecialistExtensions } from '../src/main/agent/engine/phi-extension'
import { createProjectToolBoundaryExtension } from '../src/main/agent/engine/phi-extension/extensions/project-boundary'
import { createBridgeToolApprovalExtension } from '../src/main/agent/engine/phi-extension/extensions/tool-approval'
import type {
  PhiExtensionConfig,
  PhiExtensionHost,
  PhiExtensionToolApprovalRequest
} from '../src/main/agent/engine/phi-extension/host'
import { projectToolBoundaryDecision } from '../src/main/agent/engine/phi-extension/lib/project-boundary'

type Handler = (event: { toolCallId: string; toolName: string; input: unknown }) => Promise<unknown>

async function invokeToolCall(
  factories: ReturnType<typeof createProjectToolBoundaryExtension>[],
  event: { toolCallId: string; toolName: string; input: unknown }
): Promise<unknown> {
  for (const factory of factories) {
    let handler: Handler | undefined
    await factory({
      on(name: string, candidate: Handler) {
        if (name === 'tool_call') handler = candidate
      }
    } as never)
    if (!handler) continue
    const result = await handler(event)
    if (result !== undefined) return result
  }
  return undefined
}

function approvalHost(
  onRequest: (request: PhiExtensionToolApprovalRequest) => Promise<unknown>
): PhiExtensionHost {
  return {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => false,
    planExecuteModeActive: () => false,
    proposePlanSteps: async () => ({ content: [] }),
    requestToolApproval: onRequest,
    browserApprovalInput: (_id, input) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({ allowed: true, failures: 0 }),
    environmentBinding: () => undefined,
    hostEnvironment: () => ({})
  }
}

async function toolCallHandler(
  factory: ReturnType<typeof createProjectToolBoundaryExtension>
): Promise<Handler> {
  let handler: Handler | undefined
  await factory({
    on(name: string, candidate: Handler) {
      if (name === 'tool_call') handler = candidate
    }
  } as never)
  assert.ok(handler)
  return handler
}

test('reads outside the project can be approved; writes there cannot', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'phi-boundary-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))

  assert.deepEqual(projectToolBoundaryDecision(project, 'read', { path: 'a.txt' }), {
    allowed: true
  })
  for (const [toolName, input] of [
    ['read', { path: '/data/shared/refs.txt' }],
    ['grep', { path: '/data/shared' }],
    ['glob', { path: '~/refs' }],
    ['bash', { command: 'ls /data/shared' }]
  ] as const) {
    const decision = projectToolBoundaryDecision(project, toolName, input)
    assert.equal(decision.allowed, false, toolName)
    assert.equal(!decision.allowed && decision.approvable, true, toolName)
  }
  for (const toolName of ['write', 'edit', 'ast_edit']) {
    const decision = projectToolBoundaryDecision(project, toolName, { path: '/data/shared/x' })
    assert.equal(!decision.allowed && decision.approvable, false, toolName)
  }
})

test('shell devices such as 2>/dev/null are not outside the project', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'phi-boundary-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))

  for (const command of [
    'ls data 2>/dev/null',
    'cat data.txt > /dev/stdout',
    'head -c 8 /dev/urandom | od',
    'echo done >&2 2>/dev/fd/2'
  ]) {
    assert.deepEqual(projectToolBoundaryDecision(project, 'bash', { command }), { allowed: true })
  }
  const other = projectToolBoundaryDecision(project, 'bash', { command: 'cat /dev/sda1' })
  assert.equal(other.allowed, false)
})

test('the boundary asks about outside reads, runs them when approved and never asks about writes', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'phi-boundary-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const asked: string[] = []
  let answer: unknown = null
  const handler = await toolCallHandler(
    createProjectToolBoundaryExtension(project, async (event, outsidePath) => {
      asked.push(`${event.toolName}:${outsidePath}`)
      return answer
    })
  )
  const read = { toolCallId: 'r1', toolName: 'read', input: { path: '/data/refs.txt' } }

  assert.equal(await handler(read), undefined)
  answer = { block: true, reason: 'User denied tool execution' }
  const denied = (await handler(read)) as { block: boolean; reason: string }
  assert.equal(denied.block, true)
  assert.match(denied.reason, /did not approve access outside the project/)
  const write = await handler({ toolCallId: 'w1', toolName: 'write', input: { path: '/data/x' } })
  assert.match((write as { reason: string }).reason, /writes only inside the project/)
  assert.deepEqual(asked, ['read:/data/refs.txt', 'read:/data/refs.txt'])

  const unattended = await toolCallHandler(createProjectToolBoundaryExtension(project))
  assert.equal(((await unattended(read)) as { block: boolean }).block, true)
})

test('project-bound specialists ask through the child run before reading outside the project', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'phi-boundary-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const requests: PhiExtensionToolApprovalRequest[] = []
  let answer: unknown = { block: true, reason: 'User denied tool execution' }
  const config: PhiExtensionConfig = {
    cwd: project,
    agentDir: join(project, 'agent'),
    projectBound: true,
    enableToolApproval: false,
    sessionId: 'parent-session',
    agentRunId: 'child-run',
    useBrowserTextVault: false,
    phiAgents: []
  }
  const factories = createSpecialistExtensions(
    config,
    approvalHost(async (request) => {
      requests.push(request)
      return answer
    })
  )
  const read = {
    toolCallId: 'child-read-1',
    toolName: 'read',
    input: { path: '/data/shared/refs.txt' }
  }

  const denied = (await invokeToolCall(factories, read)) as { block: boolean; reason: string }
  assert.equal(denied.block, true)
  assert.match(denied.reason, /did not approve access outside the project/)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.sessionId, 'parent-session')
  assert.equal(requests[0]?.agentRunId, 'child-run')
  assert.equal(requests[0]?.toolName, 'read')
  assert.equal(requests[0]?.outsideProject, '/data/shared/refs.txt')

  answer = null
  assert.equal(await invokeToolCall(factories, { ...read, toolCallId: 'child-read-2' }), undefined)

  const write = await invokeToolCall(factories, {
    toolCallId: 'child-write-1',
    toolName: 'write',
    input: { path: '/data/shared/x' }
  })
  assert.match((write as { reason: string }).reason, /writes only inside the project/)
  assert.equal(requests.length, 2)
})

test('installed package reads are allowed but package writes and escapes still ask', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'phi-boundary-'))
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-agent-'))
  t.after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  })
  const packagesRoot = join(agentDir, 'packages')
  const skillDir = join(packagesRoot, 'plugin', 'visualization', '1.0.0', 'skills', 'omics')
  mkdirSync(skillDir, { recursive: true })
  const skill = join(skillDir, 'SKILL.md')
  writeFileSync(skill, '# Omics\n')

  for (const [toolName, input] of [
    ['read', { path: skill }],
    ['glob', { path: skillDir }],
    ['grep', { path: skill }]
  ] as const) {
    assert.deepEqual(projectToolBoundaryDecision(project, toolName, input, agentDir), {
      allowed: true
    })
  }

  const write = projectToolBoundaryDecision(project, 'write', { path: skill }, agentDir)
  assert.equal(write.allowed, false)
  assert.equal(!write.allowed && write.approvable, false)

  const escaped = join(packagesRoot, '..', 'secret.txt')
  const escape = projectToolBoundaryDecision(project, 'read', { path: escaped }, agentDir)
  assert.equal(escape.allowed, false)
  assert.equal(!escape.allowed && escape.approvable, true)

  const shell = projectToolBoundaryDecision(project, 'bash', { command: `cat ${skill}` }, agentDir)
  assert.equal(shell.allowed, false)
  assert.equal(!shell.allowed && shell.approvable, true)
})

test('one approval covers a call that also needs the normal approval', async () => {
  const approved = new Set<string>(['call-1'])
  const requests: string[] = []
  const host = {
    requestToolApproval: async (request: { toolCallId: string }) => {
      requests.push(request.toolCallId)
      return null
    }
  } as unknown as PhiExtensionHost
  const handler = await toolCallHandler(
    createBridgeToolApprovalExtension({ sessionId: 's1' } as PhiExtensionConfig, host, approved)
  )

  assert.equal(await handler({ toolCallId: 'call-1', toolName: 'bash', input: {} }), undefined)
  assert.equal(await handler({ toolCallId: 'call-2', toolName: 'bash', input: {} }), undefined)
  assert.deepEqual(requests, ['call-2'])
  assert.equal(approved.size, 0)
})
