import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { childAuthorityCli, childUntil } from './helpers/rpcChildAuthorityCli'

test('actual native child writes only after production Node approval with separate Phi child run', async () => {
  let release!: (value: 'approved') => void
  const fixture = await childAuthorityCli({
    decision: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  try {
    const prompt = fixture.connection.prompt('Run the trusted native child')
    await childUntil(() => fixture.approvals.length === 1, 'real pending child approval')
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
    const request = fixture.approvals[0]
    assert.notEqual(request.runId, 'private-parent-run')
    assert.equal(request.agentRunId, request.runId)
    assert.equal(request.sessionId, 'private-phi-child-session')
    assert.equal(request.toolCallId, 'outer-authority-write')
    release('approved')
    await prompt
    assert.equal(
      await readFile(join(fixture.cwd, 'native-effect.txt'), 'utf8'),
      'REAL_PRODUCTION_CHILD_WRITE\n'
    )
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 2)
    assert.ok(
      fixture.events.some(
        (event) => event.type === 'approval_approved' && event.runId === request.runId
      )
    )
    assert.equal(JSON.stringify(fixture.requests).includes(fixture.capability), false)
  } finally {
    await fixture.close()
  }
})
test('actual native child denial causes zero filesystem effects', async () => {
  const fixture = await childAuthorityCli({ decision: () => 'denied' })
  try {
    await fixture.connection.prompt('Run a denied native child')
    assert.equal(fixture.approvals.length, 1)
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
    assert.ok(fixture.events.some((event) => event.type === 'approval_denied'))
  } finally {
    await fixture.close()
  }
})
test('actual native child stop cancels pending approval; late UI success cannot write', async () => {
  let release!: (value: 'approved') => void
  const fixture = await childAuthorityCli({
    decision: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  try {
    const prompt = fixture.connection.prompt('Run a stopped native child')
    await childUntil(() => fixture.approvals.length === 1, 'real pending approval before stop')
    await fixture.authority.cancelParent('private-parent-run')
    assert.ok(
      fixture.frames.some(
        (frame) =>
          frame.type === 'subagent_lifecycle' &&
          (frame.payload as { id?: string; status?: string }).id === 'authority-child' &&
          (frame.payload as { status?: string }).status === 'aborted'
      )
    )
    release('approved')
    await prompt
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
    assert.ok(fixture.events.some((event) => event.type === 'approval_cancelled'))
  } finally {
    await fixture.close()
  }
})
test('actual project shadow cannot pass Node user-source activation', async () => {
  const fixture = await childAuthorityCli({ shadow: true })
  try {
    await fixture.connection.prompt('Run a shadowed native child')
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
    assert.equal(fixture.approvals.length, 0)
    assert.ok(
      fixture.frames.some(
        (frame) =>
          frame.type === 'subagent_lifecycle' &&
          (frame.payload as { status?: string; agentSource?: string }).status === 'started' &&
          (frame.payload as { agentSource?: string }).agentSource === 'project'
      )
    )
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})
test('actual model reserved URI input cannot invoke the private child control protocol', async () => {
  const fixture = await childAuthorityCli({ reservedInput: true })
  try {
    await fixture.connection.prompt('Run a private URI attack')
    assert.equal(fixture.approvals.length, 0)
    assert.equal(
      fixture.frames.filter(
        (frame) =>
          frame.type === 'host_uri_request' &&
          String(frame.url).includes('00000000-0000-4000-8000-000000000000')
      ).length,
      0
    )
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})

test('actual server disposal permanently closes the real child provider gate', async () => {
  let release!: (value: 'approved') => void
  const fixture = await childAuthorityCli({
    decision: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  try {
    const commands = await fixture.connection.request<{
      commands: Array<{ name: string; source: string }>
    }>({ type: 'get_available_commands' })
    assert.equal(
      commands.commands.filter(
        (command) => command.name === 'phi-child-server-dispose' && command.source === 'extension'
      ).length,
      1
    )
    const parent = fixture.connection.prompt('Run a child then retire its server authority')
    await childUntil(() => fixture.approvals.length === 1, 'real write wait before server disposal')
    const control = await fixture.connection.prompt('/phi-child-server-dispose authority-child')
    assert.equal(control.agentInvoked, false)
    const probe = fixture.frames
      .filter((frame) => frame.type === 'extension_ui_request' && typeof frame.message === 'string')
      .map((frame) => {
        try {
          return JSON.parse(String(frame.message)) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .find((value) => value.type === 'phi_child_disposed_probe')
    assert.deepEqual(probe, {
      type: 'phi_child_disposed_probe',
      childId: 'authority-child',
      hadSession: true,
      observedArgs: true,
      gateRejected: true
    })
    release('approved')
    await parent
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})

test('actual read wrapper delegates only the trusted project file without a human dialog', async () => {
  const fixture = await childAuthorityCli({ tool: 'read' })
  try {
    await fixture.connection.prompt('Read the trusted private project file')
    assert.equal(fixture.approvals.length, 0)
    const childRequests = fixture.requests.filter((request) => request.actor === 'child')
    assert.equal(childRequests.length, 2)
    assert.ok(JSON.stringify(childRequests[1].body.messages).includes('REAL_PRODUCTION_CHILD_READ'))
  } finally {
    await fixture.close()
  }
})
test('actual bash wrapper waits for Node approval before delegating the native implementation', async () => {
  let release!: (value: 'approved') => void
  const fixture = await childAuthorityCli({
    tool: 'bash',
    decision: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  try {
    const parent = fixture.connection.prompt('Run the trusted private native shell command')
    await childUntil(() => fixture.approvals.length === 1, 'actual native bash approval')
    assert.equal(fixture.approvals[0].toolName, 'bash')
    await assert.rejects(readFile(join(fixture.cwd, 'bash-effect.txt')), { code: 'ENOENT' })
    release('approved')
    await parent
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 2)
    assert.equal(
      fixture.frames.filter((frame) => {
        if (
          frame.type !== 'host_uri_request' ||
          frame.operation !== 'write' ||
          typeof frame.content !== 'string'
        )
          return false
        try {
          return (JSON.parse(frame.content) as { operation?: string }).operation === 'activate'
        } catch {
          return false
        }
      }).length,
      1
    )
    assert.equal(
      await readFile(join(fixture.cwd, 'bash-effect.txt'), 'utf8'),
      'REAL_PRODUCTION_CHILD_BASH\n'
    )
  } finally {
    await fixture.close()
  }
})
