import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { KernelClientError } from '../src/main/agent/engine/kernel-client'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { eventually, messageText } from './engine-contract/basic-suite'
import { createKernelFixture } from './engine-contract/kernel-factory'

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

test(
  'A01 kernel stdio reads a project file and emits ordered deltas and one completion',
  { timeout: 30_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    writeFileSync(join(f.cwd, 'notes.txt'), 'kernel A01 evidence')
    const frames: KernelEventFrame[] = []
    const stop = f.client.onEvent((event) => frames.push(event))
    t.after(stop)

    const created = await f.createSession('a01')
    const kernelSessionId = f.kernelSessionId('a01')
    assert.ok(kernelSessionId)
    f.provider.enqueue(
      { tool: { name: 'read', args: { path: 'notes.txt' } } },
      { text: 'A01 complete.' }
    )
    const state = await f.sessions.prompt({ sessionId: 'a01', text: 'Read notes.txt.' })
    assert.equal(messageText(state.messages?.at(-1)), 'A01 complete.')

    const sessionEvents = frames
      .filter((event) => event.type === 'session.event' && event.sessionId === kernelSessionId)
      .map((event) => record(event.payload).type)
    assert.ok(sessionEvents.indexOf('agent_start') >= 0)
    assert.ok(sessionEvents.indexOf('message_update') > sessionEvents.indexOf('agent_start'))
    assert.ok(sessionEvents.lastIndexOf('agent_end') > sessionEvents.indexOf('message_update'))
    const completions = frames.filter(
      (event) =>
        event.type === 'run.completed' &&
        event.sessionId === kernelSessionId &&
        record(event.payload).status === 'completed'
    )
    assert.equal(completions.length, 1)
    const snapshot = record(
      await f.client.request('session.snapshot', {}, { sessionId: kernelSessionId })
    )
    assert.equal(snapshot.sessionId, kernelSessionId)
    assert.equal(snapshot.cwd, f.cwd)
    assert.equal(created.state.cwd, f.cwd)
  }
)

test(
  'A03 kernel approvals approve once, deny, reject duplicates, and cancel safely',
  { timeout: 45_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    const approvals: KernelEventFrame[] = []
    const stop = f.client.onEvent((event) => {
      if (event.type === 'approval.requested') approvals.push(event)
    })
    t.after(stop)

    await f.createSession('approve', { enableToolApproval: true })
    const approvedPath = join(f.cwd, 'approved.txt')
    f.provider.enqueue(
      {
        tool: { name: 'write', id: 'approve-write', args: { path: approvedPath, content: 'once' } }
      },
      { text: 'Approved.' }
    )
    const approvedPrompt = f.sessions.prompt({ sessionId: 'approve', text: 'Write approved.txt.' })
    void approvedPrompt.catch(() => undefined)
    await eventually(() => approvals.length === 1, 'approved write request')
    assert.equal(existsSync(approvedPath), false)
    const approvedId = String(record(approvals[0].payload).approvalId)
    const approvedSessionId = f.kernelSessionId('approve')
    await f.client.request(
      'approval.respond',
      { approvalId: approvedId, decision: 'approved' },
      { sessionId: approvedSessionId }
    )
    await approvedPrompt
    assert.equal(readFileSync(approvedPath, 'utf8'), 'once')
    await assert.rejects(
      f.client.request(
        'approval.respond',
        { approvalId: approvedId, decision: 'approved' },
        { sessionId: approvedSessionId }
      ),
      (error: unknown) => {
        assert.ok(error instanceof KernelClientError)
        assert.equal(error.code, 'INVALID_PARAMS')
        return true
      }
    )

    await f.createSession('deny', { enableToolApproval: true })
    const deniedPath = join(f.cwd, 'denied.txt')
    f.provider.enqueue(
      { tool: { name: 'write', id: 'deny-write', args: { path: deniedPath, content: 'never' } } },
      { text: 'Denied.' }
    )
    const deniedPrompt = f.sessions.prompt({ sessionId: 'deny', text: 'Try denied.txt.' })
    void deniedPrompt.catch(() => undefined)
    await eventually(() => approvals.length === 2, 'denied write request')
    const deniedId = String(record(approvals[1].payload).approvalId)
    await f.client.request(
      'approval.respond',
      { approvalId: deniedId, decision: 'denied' },
      { sessionId: f.kernelSessionId('deny') }
    )
    await deniedPrompt
    assert.equal(existsSync(deniedPath), false)

    await f.createSession('cancel', { enableToolApproval: true })
    const cancelledPath = join(f.cwd, 'cancelled.txt')
    f.provider.enqueue({
      tool: { name: 'write', id: 'cancel-write', args: { path: cancelledPath, content: 'never' } }
    })
    const cancelledPrompt = f.sessions.prompt({ sessionId: 'cancel', text: 'Try cancelled.txt.' })
    void cancelledPrompt.catch(() => undefined)
    await eventually(() => approvals.length === 3, 'cancelled write request')
    await f.sessions.abort({ sessionId: 'cancel' })
    await cancelledPrompt
    assert.equal(existsSync(cancelledPath), false)
  }
)

test(
  'A04 abort stops a native bash process and the session remains reusable',
  { timeout: 45_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    await f.createSession('bash-abort')
    const pidPath = join(f.cwd, 'bash.pid')
    f.provider.enqueue({
      tool: {
        name: 'bash',
        id: 'long-bash',
        // Native bash runs inside the kernel process, so $$ is the kernel. Record the PID of
        // a foreground child instead, which exec keeps as the process that must be stopped.
        args: {
          command: `sh -c 'printf "%s" "$$" > "$1"; exec sleep 30' sh ${shellLiteral(pidPath)}`
        }
      }
    })
    const prompt = f.sessions.prompt({ sessionId: 'bash-abort', text: 'Run the long command.' })
    void prompt.catch(() => undefined)
    await eventually(
      () => existsSync(pidPath) && readFileSync(pidPath, 'utf8').length > 0,
      'native bash pid'
    )
    const pid = Number(readFileSync(pidPath, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0)
    await f.sessions.abort({ sessionId: 'bash-abort' })
    await prompt
    await eventually(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'native bash exit')

    f.provider.enqueue({ text: 'Session reused.' })
    const reused = await f.sessions.prompt({ sessionId: 'bash-abort', text: 'Continue.' })
    assert.equal(messageText(reused.messages?.at(-1)), 'Session reused.')
  }
)

test(
  'kernel keeps cwd, resources, environment, and native shell state isolated',
  { timeout: 45_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    const root = dirname(f.cwd)
    const cwdA = join(root, 'isolation-a')
    const cwdB = join(root, 'isolation-b')
    mkdirSync(cwdA)
    mkdirSync(cwdB)
    writeFileSync(join(cwdA, 'shared.txt'), 'ONLY_A')
    writeFileSync(join(cwdB, 'shared.txt'), 'ONLY_B')
    writeFileSync(join(cwdA, 'AGENTS.md'), 'A_RESOURCE_ONLY')
    writeFileSync(join(cwdB, 'AGENTS.md'), 'B_RESOURCE_ONLY')
    const resources = {
      noExtensions: true,
      noSkills: true,
      noContextFiles: false,
      noPromptTemplates: true,
      noThemes: true
    }
    await f.createSession('a', { cwd: cwdA, resourceOptions: resources })
    await f.createSession('b', { cwd: cwdB, resourceOptions: resources })

    f.provider.enqueue(
      { tool: { name: 'read', id: 'read-a', args: { path: 'shared.txt' } } },
      {
        tool: {
          name: 'bash',
          id: 'shell-a',
          args: { command: 'printf "cwd=%s env=%s" "$PWD" "${PHI_K12-unset}"; export PHI_K12=a' }
        }
      },
      { text: 'A done.' },
      { tool: { name: 'read', id: 'read-b', args: { path: 'shared.txt' } } },
      {
        tool: {
          name: 'bash',
          id: 'shell-b',
          args: { command: 'printf "cwd=%s env=%s" "$PWD" "${PHI_K12-unset}"' }
        }
      },
      { text: 'B done.' }
    )
    const a = await f.sessions.prompt({ sessionId: 'a', text: 'Inspect A.' })
    const b = await f.sessions.prompt({ sessionId: 'b', text: 'Inspect B.' })
    const aText = JSON.stringify(a.messages)
    const bText = JSON.stringify(b.messages)
    assert.match(aText, /ONLY_A/)
    assert.doesNotMatch(aText, /ONLY_B/)
    assert.match(aText, new RegExp(cwdA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(bText, /ONLY_B/)
    assert.doesNotMatch(bText, /ONLY_A/)
    assert.match(bText, /env=unset/)
    assert.equal(process.env.PHI_K12, undefined)

    const requests = f.provider.requests.map((request) => JSON.stringify(request.messages))
    assert.ok(
      requests.some(
        (request) => request.includes('A_RESOURCE_ONLY') && !request.includes('B_RESOURCE_ONLY')
      )
    )
    assert.ok(
      requests.some(
        (request) => request.includes('B_RESOURCE_ONLY') && !request.includes('A_RESOURCE_ONLY')
      )
    )
  }
)
