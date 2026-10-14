import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { nativeTaskCli, nativeTaskUntil, type NativeTaskRecord } from './helpers/rpcNativeTaskCli'

function sub(record: NativeTaskRecord): boolean {
  return (record.agent as { kind?: string })?.kind === 'sub'
}
test('actual native task child uses a real manager/identity and private host URI before its first provider request', async () => {
  const fixture = await nativeTaskCli({ effect: true, proxy: true, clamp: true })
  try {
    const result = await fixture.connection.prompt('Run the private native task contract')
    assert.equal(result.status, 'completed')
    const trace = await fixture.trace()
    const child = trace.find((item) => item.type === 'session_start' && sub(item))
    assert.ok(child, fixture.stderr() + JSON.stringify(trace))
    assert.notEqual(child.sessionId, trace[0].sessionId)
    assert.equal((child.header as { parentSession?: string }).parentSession, trace[0].sessionFile)
    assert.equal(
      (child.agent as { parentId?: string }).parentId,
      (trace[0].agent as { id: string }).id
    )
    assert.equal(child.managerPresent, true)
    assert.equal(child.agentFrozen, true)
    assert.equal((child.allTools as string[]).includes('ChildHost'), false)
    const taskSchema = fixture.requests
      .find((item) => item.actor === 'root')!
      .body.tools.find((tool) => tool.function.name === 'task')!.function.parameters as {
      required: string[]
      properties: Record<string, unknown>
    }
    assert.ok(taskSchema.required.includes('solutionSpace'))
    assert.ok(taskSchema.required.includes('i'))
    for (const missing of ['tools', 'isolated', 'effort'])
      assert.equal(taskSchema.properties[missing], undefined)
    assert.ok(
      fixture.requests
        .find((item) => item.actor === 'root')!
        .body.tools.some((tool) => tool.function.name === 'ChildHost')
    )
    assert.ok(trace.some((item) => item.type === 'registered_ack' && sub(item)))
    assert.ok(trace.some((item) => item.type === 'stream_gate' && item.permitted === true))
    const registration = fixture.frames.findIndex(
      (frame) =>
        frame.type === 'host_uri_request' && String(frame.url).startsWith('phitask://register/')
    )
    const started = fixture.frames.findIndex(
      (frame) =>
        frame.type === 'subagent_lifecycle' &&
        (frame.payload as { status?: string }).status === 'started'
    )
    assert.equal(
      (fixture.frames[started].payload as { parentToolCallId: string }).parentToolCallId,
      'outer-native-task'
    )
    const activation = fixture.frames.findIndex(
      (frame) =>
        frame.type === 'host_uri_request' && String(frame.url).startsWith('phitask://activate/')
    )
    // SDK emit order is sourced separately; the security barrier must not rely on transport batching order.
    assert.ok(started >= 0 && registration >= 0 && activation >= 0)
    const registrationReply = fixture.replies.find(
      (item) => item.id === fixture.frames[registration].id
    )!
    assert.equal(registrationReply.childRequests, 0)
    const activationReply = fixture.replies.find(
      (item) => item.id === fixture.frames[activation].id
    )!
    assert.ok(activationReply.frameCount > started)
    assert.ok(fixture.replies.indexOf(registrationReply) < fixture.replies.indexOf(activationReply))
    assert.equal(activationReply.childRequests, 0)
    const registered = JSON.parse(String(fixture.frames[registration].content)) as NativeTaskRecord
    assert.equal(registered.sessionId, child.sessionId)
    assert.equal(registered.sessionFile, child.sessionFile)
    assert.equal(registered.parentSession, trace[0].sessionFile)
    assert.deepEqual(registered.agent, child.agent)
    assert.equal(await readFile(fixture.cwd + '/native-effect.txt', 'utf8'), 'REAL_NATIVE_WRITE\n')
    assert.ok(
      trace.some(
        (item) => item.type === 'wrapper_result' && item.outerToolCallId === 'outer-native-write'
      )
    )
    assert.ok(
      trace.some(
        (item) => item.type === 'host_result' && item.outerToolCallId === 'outer-child-host'
      )
    )
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 3)
    assert.equal(
      trace.filter(
        (item) => item.type === 'wrapper_invoke' && item.outerToolCallId === 'outer-native-write'
      ).length,
      1
    )
    assert.ok(
      fixture.frames.some(
        (frame) =>
          frame.type === 'subagent_lifecycle' &&
          (frame.payload as { status?: string }).status === 'completed'
      )
    )
  } finally {
    await fixture.close()
  }
})

test('throwing from actual child session_start does not block provider execution', async () => {
  const fixture = await nativeTaskCli({ mode: 'throw-only' })
  try {
    await fixture.connection.prompt('Probe a missing permit through a lifecycle throw')
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 1)
    assert.ok(
      (await fixture.trace()).some((item) => item.type === 'before_agent_start' && sub(item))
    )
    assert.ok((await fixture.trace()).some((item) => item.type === 'missing_permit_throw'))
  } finally {
    await fixture.close()
  }
})

test('public actual child stream gate denies the first provider request when the registration permit is missing', async () => {
  const fixture = await nativeTaskCli({ mode: 'deny-stream' })
  try {
    await fixture.connection.prompt('Probe a missing permit through the public stream boundary')
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
    assert.ok(
      (await fixture.trace()).some(
        (item) => item.type === 'stream_gate' && item.permitted === false
      )
    )
    assert.ok(
      fixture.frames.some(
        (frame) =>
          frame.type === 'subagent_lifecycle' &&
          (frame.payload as { status?: string }).status === 'failed'
      )
    )
  } finally {
    await fixture.close()
  }
})

test('private host registration failure remains fail closed despite swallowed child lifecycle errors', async () => {
  const fixture = await nativeTaskCli({
    clamp: true,
    onUri: async (frame) =>
      String(frame.url).startsWith('phitask://register/')
        ? { isError: true, error: 'Private registration denied' }
        : { content: '{"allowed":true}' }
  })
  try {
    await fixture.connection.prompt('Probe rejected tentative registration')
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
    assert.equal(
      (await fixture.trace()).some((item) => item.type === 'registered_ack'),
      false
    )
    assert.ok(
      (await fixture.trace()).some(
        (item) =>
          item.type === 'registration_failed' && String(item.error).includes('registration denied')
      )
    )
  } finally {
    await fixture.close()
  }
})

test('actual project definition shadow can be clamped through the real child public tools/model/system prompt boundaries', async () => {
  const fixture = await nativeTaskCli({ shadow: true, clamp: true, effect: true, proxy: true })
  try {
    await fixture.connection.prompt('Probe a project definition shadow')
    const trace = await fixture.trace()
    const initial = trace.find((item) => item.type === 'session_start' && sub(item))!
    assert.equal(initial.model, 'shadow')
    assert.ok((initial.tools as string[]).includes('bash'))
    assert.ok(JSON.stringify(initial.systemPrompt).includes('PRIVATE_UNTRUSTED_SHADOW'))
    const requests = fixture.requests.filter((item) => item.actor === 'child')
    assert.equal(requests.length, 3)
    for (const request of requests) {
      assert.equal(request.body.model, 'model')
      assert.deepEqual(request.body.tools.map((tool) => tool.function.name).sort(), [
        'ChildHost',
        'write'
      ])
      const system = JSON.stringify(
        request.body.messages.filter((message) => message.role === 'system')
      )
      assert.ok(system.includes('PRIVATE_CLAMPED_CHILD'))
      assert.equal(system.includes('PRIVATE_UNTRUSTED_SHADOW'), false)
    }
    const started = fixture.frames.find(
      (frame) =>
        frame.type === 'subagent_lifecycle' &&
        (frame.payload as { status?: string }).status === 'started'
    )!
    assert.equal((started.payload as { agentSource?: string }).agentSource, 'project')
    assert.equal(await readFile(fixture.cwd + '/native-effect.txt', 'utf8'), 'REAL_NATIVE_WRITE\n')
  } finally {
    await fixture.close()
  }
})

for (const suppressDelivery of [false, true])
  test(`native background task permits parent turn completion with unsettled async work; delivery suppression=${suppressDelivery}`, async () => {
    let approval: Parameters<Awaited<ReturnType<typeof nativeTaskCli>>['respond']>[0] | undefined
    const fixture = await nativeTaskCli({
      background: true,
      effect: true,
      clamp: true,
      suppressDelivery,
      onUri: async (frame) => {
        if (String(frame.url).startsWith('phitask://approval/')) {
          approval = frame
          return undefined
        }
        return { content: '{"allowed":true}' }
      }
    })
    try {
      const completion = await fixture.connection.prompt('Launch a background native task')
      assert.equal(completion.status, 'completed')
      assert.equal(completion.sessionSettled, suppressDelivery)
      await nativeTaskUntil(() => !!approval, 'background child approval gate')
      const status = await fixture.status()
      assert.equal(status.pendingAsync, !suppressDelivery)
      assert.equal((status.snapshot as { running: unknown[] }).running.length, 1)
      assert.equal(status.streaming, false)
      assert.equal(fixture.requests.filter((item) => item.actor === 'root').length, 2)
      const trace = await fixture.trace()
      assert.ok(
        trace.some(
          (item) =>
            item.type === 'agent_end' && !sub(item) && item.pendingAsync === !suppressDelivery
        )
      )
      if (suppressDelivery) {
        assert.ok(
          trace.some(
            (item) =>
              item.type === 'wrong_owner_cancel' &&
              item.wrongOwnerCancelled === false &&
              item.status === 'running'
          )
        )
        const ack = trace.find((item) => item.type === 'delivery_ack')!
        assert.equal(ack.ownerId, 'Main')
        assert.equal(ack.jobId, 'contract-child')
        assert.equal(ack.suppressed, true)
        assert.ok(
          Number(ack.ordinal) <
            Number(trace.find((item) => item.type === 'session_start' && sub(item))!.ordinal)
        )
      }
      await fixture.respond(approval!, { content: '{"allowed":true}' })
      await nativeTaskUntil(
        () =>
          fixture.frames.some(
            (frame) =>
              frame.type === 'subagent_lifecycle' &&
              (frame.payload as { status?: string }).status === 'completed'
          ),
        'native background completion'
      )
      await nativeTaskUntil(
        async () =>
          !(
            await fixture.connection.request<{ hasPendingAsyncWork: boolean }>({
              type: 'get_state'
            })
          ).hasPendingAsyncWork,
        'native async settle'
      )
      assert.equal(
        await readFile(fixture.cwd + '/native-effect.txt', 'utf8'),
        'REAL_NATIVE_WRITE\n'
      )
      assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 2)
      if (!suppressDelivery)
        await nativeTaskUntil(
          () => fixture.requests.filter((item) => item.actor === 'root').length === 3,
          'actual native async delivery wake'
        )
      assert.equal(
        fixture.requests.filter((item) => item.actor === 'root').length,
        suppressDelivery ? 2 : 3
      )
      await assert.rejects(
        fixture.connection.request({
          type: 'steer_subagent',
          subagentId: 'contract-child',
          message: 'Must not revive the accepted child'
        }),
        /Subagent not running/
      )
      assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 2)
      const actualResult = fixture.wireFrames.find(
        (frame) => frame.type === 'prompt_result' && frame.agentInvoked === true
      )
      assert.equal(actualResult?.sessionSettled, suppressDelivery)
    } finally {
      await fixture.close()
    }
  })

test('cancel a real background child after the main turn ends cancels its host URI gate and ignores late approval', async () => {
  let approval: Parameters<Awaited<ReturnType<typeof nativeTaskCli>>['respond']>[0] | undefined
  const fixture = await nativeTaskCli({
    background: true,
    effect: true,
    clamp: true,
    suppressDelivery: true,
    onUri: async (frame) => {
      if (String(frame.url).startsWith('phitask://approval/')) {
        approval = frame
        return undefined
      }
      return { content: '{"allowed":true}' }
    }
  })
  try {
    assert.equal(
      (await fixture.connection.prompt('Launch a cancellable native child')).sessionSettled,
      true
    )
    await nativeTaskUntil(() => !!approval, 'real child waiting on host URI')
    const stopped = await fixture.connection.request<{ cancelled: boolean }>({
      type: 'cancel_subagent',
      subagentId: 'contract-child'
    })
    assert.equal(stopped.cancelled, true)
    await nativeTaskUntil(
      () =>
        fixture.frames.some(
          (frame) => frame.type === 'host_uri_cancel' && frame.targetId === approval!.id
        ),
      'official host URI cancel target'
    )
    await fixture.respond(approval!, { content: '{"allowed":true}' })
    await nativeTaskUntil(
      async () =>
        !(await fixture.connection.request<{ hasPendingAsyncWork: boolean }>({ type: 'get_state' }))
          .hasPendingAsyncWork,
      'cancelled native job settle'
    )
    await assert.rejects(readFile(fixture.cwd + '/native-effect.txt'), { code: 'ENOENT' })
    assert.equal(
      (await fixture.trace()).some((item) => item.type === 'wrapper_invoke'),
      false
    )
    assert.equal(fixture.requests.filter((item) => item.actor === 'root').length, 2)
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 1)
  } finally {
    await fixture.close()
  }
})

test('actual discovered private command during a live parent turn invokes no model and cancels child native execution', async () => {
  let approval: Parameters<Awaited<ReturnType<typeof nativeTaskCli>>['respond']>[0] | undefined
  const fixture = await nativeTaskCli({
    effect: true,
    clamp: true,
    onUri: async (frame) => {
      if (String(frame.url).startsWith('phitask://approval/')) {
        approval = frame
        return undefined
      }
      return { content: '{"allowed":true}' }
    }
  })
  try {
    const prompt = fixture.connection.prompt('Launch a foreground child that waits for approval')
    void prompt.catch(() => undefined)
    await nativeTaskUntil(() => !!approval, 'foreground execution approval')
    const rootHits = fixture.requests.filter((item) => item.actor === 'root').length
    const status = await fixture.status()
    assert.equal(status.streaming, true)
    assert.equal(fixture.requests.filter((item) => item.actor === 'root').length, rootHits)
    const localResult = fixture.wireFrames.find(
      (frame) => frame.type === 'prompt_result' && frame.agentInvoked === false
    )
    assert.ok(localResult, 'Official prompt_result must prove agentInvoked=false')
    await fixture.connection.request({ type: 'cancel_subagent', subagentId: 'contract-child' })
    await nativeTaskUntil(
      () =>
        fixture.frames.some(
          (frame) => frame.type === 'host_uri_cancel' && frame.targetId === approval!.id
        ),
      'foreground gate cancel'
    )
    await fixture.respond(approval!, { content: '{"allowed":true}' })
    await prompt
    await assert.rejects(readFile(fixture.cwd + '/native-effect.txt'), { code: 'ENOENT' })
    assert.equal(
      (await fixture.trace()).some((item) => item.type === 'wrapper_invoke'),
      false
    )
  } finally {
    await fixture.close()
  }
})

test('actual root scoped manager cancellation after normal parent completion stops its live background child', async () => {
  let approval: Parameters<Awaited<ReturnType<typeof nativeTaskCli>>['respond']>[0] | undefined
  const fixture = await nativeTaskCli({
    background: true,
    effect: true,
    clamp: true,
    suppressDelivery: true,
    onUri: async (frame) => {
      if (String(frame.url).startsWith('phitask://approval/')) {
        approval = frame
        return undefined
      }
      return { content: '{"allowed":true}' }
    }
  })
  try {
    await fixture.connection.prompt('Launch a background child for owner cancellation')
    await nativeTaskUntil(() => !!approval, 'owner cancellation approval gate')
    const before = fixture.requests.filter((item) => item.actor === 'root').length
    await fixture.status(true)
    await nativeTaskUntil(
      () =>
        fixture.frames.some(
          (frame) => frame.type === 'host_uri_cancel' && frame.targetId === approval!.id
        ),
      'owner manager URI cancellation'
    )
    await fixture.respond(approval!, { content: '{"allowed":true}' })
    await nativeTaskUntil(
      () =>
        fixture.frames.some(
          (frame) =>
            frame.type === 'subagent_lifecycle' &&
            (frame.payload as { status?: string }).status === 'aborted'
        ),
      'native aborted lifecycle'
    )
    const status = await fixture.status()
    assert.equal(
      (status.snapshot as { recent: Array<{ status: string }> }).recent[0].status,
      'cancelled'
    )
    assert.equal(fixture.requests.filter((item) => item.actor === 'root').length, before)
    assert.equal(
      (await fixture.trace()).some((item) => item.type === 'wrapper_invoke'),
      false
    )
    await assert.rejects(readFile(fixture.cwd + '/native-effect.txt'), { code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})

test('actual before_subagent_spawn block denies a missing spawn permit before constructing any child', async () => {
  const fixture = await nativeTaskCli({ denySpawn: true })
  try {
    await fixture.connection.prompt('Probe a missing native spawn permit')
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
    assert.equal((await fixture.trace()).some(sub), false)
    assert.ok(
      fixture.frames.some(
        (frame) =>
          frame.type === 'tool_execution_end' &&
          JSON.stringify(frame.result).includes('Private spawn permit denied')
      )
    )
  } finally {
    await fixture.close()
  }
})

test('actual child activation refusal blocks all provider requests after successful tentative registration', async () => {
  const fixture = await nativeTaskCli({
    clamp: true,
    onUri: async (frame) => ({
      content: JSON.stringify({ allowed: !String(frame.url).startsWith('phitask://activate/') })
    })
  })
  try {
    await fixture.connection.prompt('Probe a rejected child activation')
    assert.ok((await fixture.trace()).some((item) => item.type === 'registered_ack'))
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
    assert.ok(
      (await fixture.trace()).some(
        (item) => item.type === 'stream_gate' && item.permitted === false
      )
    )
  } finally {
    await fixture.close()
  }
})

test('actual trusted child retains native read when the requested tool exists in its real registry', async () => {
  const fixture = await nativeTaskCli({ clamp: true, requireRead: true })
  try {
    await fixture.connection.prompt('Probe a native read grant present before clamp')
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 1)
    assert.ok(
      fixture.requests
        .find((item) => item.actor === 'child')!
        .body.tools.some((tool) => tool.function.name === 'read')
    )
    assert.equal(
      (await fixture.trace()).some((item) => item.type === 'clamp_rejected'),
      false
    )
  } finally {
    await fixture.close()
  }
})

test('actual shadow missing native read cannot be repaired by setActiveTools and must fail closed before a provider request', async () => {
  const fixture = await nativeTaskCli({ shadow: true, clamp: true, requireRead: true })
  try {
    await fixture.connection.prompt('Probe a shadow that removed a required native tool')
    const trace = await fixture.trace()
    const rejection = trace.find((item) => item.type === 'clamp_rejected')!
    assert.deepEqual(rejection.missingTools, ['read'])
    assert.equal(rejection.nativeReadPresent, false)
    assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
    assert.ok(trace.some((item) => item.type === 'stream_gate' && item.permitted === false))
  } finally {
    await fixture.close()
  }
})

for (const failure of ['uri-error', 'malformed-json'] as const)
  test(`actual child activation ${failure} cannot enable a registered child stream`, async () => {
    const fixture = await nativeTaskCli({
      clamp: true,
      onUri: async (frame) => {
        if (String(frame.url).startsWith('phitask://activate/'))
          return failure === 'uri-error'
            ? { isError: true, error: 'Private activation transport failed' }
            : { content: '{not valid JSON' }
        return { content: '{"allowed":true}' }
      }
    })
    try {
      await fixture.connection.prompt('Probe a failed child activation')
      const trace = await fixture.trace()
      assert.ok(trace.some((item) => item.type === 'registered_ack'))
      assert.equal(fixture.requests.filter((item) => item.actor === 'child').length, 0)
      assert.ok(trace.some((item) => item.type === 'stream_gate' && item.permitted === false))
    } finally {
      await fixture.close()
    }
  })
