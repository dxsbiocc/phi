import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { deferred, remoteDownloadFixture } from './helpers/remoteDownloadFixture'

/**
 * Generous, loud deadline for a fixture boundary. Reaching the fake curl takes several shell round
 * trips on a fresh local "SSH" session, which can take seconds on a loaded host.
 */
const BOUNDARY_TIMEOUT_MS = 60_000

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + BOUNDARY_TIMEOUT_MS
  while (!predicate()) {
    assert.ok(Date.now() < until, 'fixture boundary was not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

for (const boundary of ['connection', 'authorization', 'DNS', 'space', 'retention'] as const) {
  for (const change of ['stop', 'rebind'] as const) {
    test(`download ${change} during ${boundary} never enqueues or submits a transfer`, async () => {
      const fixture = remoteDownloadFixture()
      fixture.allow()
      const entered = deferred()
      const release = deferred()
      const controller = new AbortController()
      let current = true
      const hold = async (): Promise<void> => {
        entered.resolve()
        await release.promise
      }
      if (boundary === 'connection') fixture.setBeforeConnect(hold)
      if (boundary === 'retention') {
        const cleanup = fixture.coordinator.cleanupRetained.bind(fixture.coordinator)
        fixture.coordinator.cleanupRetained = async (options) => {
          await hold()
          return cleanup(options)
        }
      }
      fixture.setBeforeCommand(async (command) => {
        if (
          (boundary === 'authorization' && command.includes('candidate=')) ||
          (boundary === 'DNS' && command.includes('getent ahosts')) ||
          (boundary === 'space' && command.includes('df -Pk'))
        )
          await hold()
      })
      const pending = fixture.manager.run(fixture.request(), {
        signal: controller.signal,
        beforeDispatch: () => {
          if (!current) throw new Error('retired binding')
        }
      })
      const rejected = assert.rejects(pending, /abort|retired binding/i)
      try {
        await entered.promise
        if (change === 'stop') controller.abort()
        else current = false
        release.resolve()
        await rejected
        assert.equal(fixture.events.length, 0)
        assert.ok(
          fixture.sessions.every(
            (session) => !session.commands.some((command) => command.includes('curl -q'))
          )
        )
        assert.equal(existsSync(join(fixture.remoteRoot, 'owner.bin')), false)
        assert.equal(
          readFileSync(join(fixture.anchor, 'owner.bin'), 'utf8'),
          'local anchor sentinel'
        )
      } finally {
        release.resolve()
        await fixture.dispose()
      }
    })
  }
}

test('cancel reaches original transfer after run retirement while same-project peer saves real bytes', async () => {
  const fixture = remoteDownloadFixture()
  let current = true
  const original = fixture.request()
  const owner = fixture.manager.run(original, {
    beforeDispatch: () => {
      if (!current) throw new Error('retired binding')
    }
  })
  const rejected = assert.rejects(owner, /cancel|retired binding/i)
  try {
    await waitFor(() => existsSync(fixture.startedPath()))
    const peer = fixture.manager.run(fixture.request('session-peer', 'peer.bin'))
    current = false
    fixture.manager.cancel({
      sessionId: original.sessionId,
      projectId: original.projectId,
      requestId: original.requestId
    })
    fixture.allow('peer.bin')
    await rejected
    const saved = await peer
    assert.equal(saved.bytes, fixture.bytes.length)
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'peer.bin')), fixture.bytes)
    assert.equal(existsSync(join(fixture.remoteRoot, 'owner.bin')), false)
    const retained = await fixture.coordinator.registry.list()
    assert.equal(retained.length, 1)
    assert.equal(retained[0]?.status, 'cancelled')
    assert.equal(retained[0]?.retainedBytes, 1024)
    const originalId = retained[0]!.transferId
    const queuedBefore = fixture.events.filter((event) => event.state === 'queued').length
    await assert.rejects(
      fixture.manager.run(fixture.request('session-owner', 'owner.bin', 'request-replay'), {
        beforeDispatch: () => {
          throw new Error('retired binding')
        }
      }),
      /retired binding/
    )
    assert.equal(fixture.events.filter((event) => event.state === 'queued').length, queuedBefore)
    fixture.allow()
    const resumed = await fixture.manager.run(
      fixture.request('session-owner', 'owner.bin', 'request-generation-two'),
      { beforeDispatch: () => undefined }
    )
    assert.equal(resumed.bytes, fixture.bytes.length)
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'owner.bin')), fixture.bytes)
    assert.equal(fixture.events.at(-1)?.transferId, originalId)
    assert.equal(fixture.events.at(-1)?.state, 'saved')
    assert.deepEqual(await fixture.coordinator.registry.list(), [])
  } finally {
    fixture.allow()
    fixture.allow('peer.bin')
    await fixture.dispose()
  }
})

for (const change of ['stop', 'rebind'] as const) {
  test(`download ${change} after verification prevents atomic publish`, async () => {
    const fixture = remoteDownloadFixture()
    const entered = deferred()
    const release = deferred()
    const controller = new AbortController()
    let current = true
    let heads = 0
    fixture.allow()
    fixture.setBeforeCommand(async (command) => {
      if (command.includes('curl -q --head') && ++heads === 3) {
        entered.resolve()
        await release.promise
      }
    })
    const pending = fixture.manager.run(fixture.request(), {
      signal: controller.signal,
      beforeDispatch: () => {
        if (!current) throw new Error('retired binding')
      }
    })
    const rejected = assert.rejects(pending, /cancel|abort|retired binding/i)
    try {
      await entered.promise
      if (change === 'stop') controller.abort()
      else current = false
      release.resolve()
      await rejected
      assert.equal(existsSync(join(fixture.remoteRoot, 'owner.bin')), false)
      assert.ok(
        fixture.sessions.every(
          (session) => !session.commands.some((command) => command.includes('ln --'))
        )
      )
      assert.ok(!fixture.events.some((event) => event.state === 'saved'))
    } finally {
      release.resolve()
      await fixture.dispose()
    }
  })
}

test('abort after atomic publish dispatch suppresses public success while keeping committed artifact accurate', async () => {
  const fixture = remoteDownloadFixture()
  const entered = deferred()
  const release = deferred()
  const controller = new AbortController()
  fixture.allow()
  fixture.setBeforeCommand(async (command) => {
    if (command.includes('ln -- "$phi_part" "$phi_dest"')) {
      entered.resolve()
      await release.promise
    }
  })
  const pending = fixture.manager.run(fixture.request(), { signal: controller.signal })
  const rejected = assert.rejects(pending, /abort|cancel/i)
  try {
    await entered.promise
    controller.abort()
    release.resolve()
    await rejected
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'owner.bin')), fixture.bytes)
    assert.equal(fixture.events.at(-1)?.state, 'saved')
    assert.deepEqual(await fixture.coordinator.registry.list(), [])
  } finally {
    release.resolve()
    await fixture.dispose()
  }
})

test('caller abort cancels the actual binary stream and retains its original checkpoint', async () => {
  const fixture = remoteDownloadFixture()
  const controller = new AbortController()
  const pending = fixture.manager.run(fixture.request(), { signal: controller.signal })
  const rejected = assert.rejects(pending, /cancel|abort/i)
  try {
    await waitFor(() => existsSync(fixture.startedPath()))
    controller.abort()
    await rejected
    assert.equal(existsSync(join(fixture.remoteRoot, 'owner.bin')), false)
    const retained = await fixture.coordinator.registry.list()
    assert.equal(retained[0]?.status, 'cancelled')
    assert.equal(retained[0]?.retainedBytes, 1024)
    assert.equal(fixture.events.at(-1)?.state, 'cancelled')
  } finally {
    fixture.allow()
    await fixture.dispose()
  }
})

test('a queued download rechecks generation immediately before its data plane opens', async () => {
  const fixture = remoteDownloadFixture()
  let current = true
  fixture.setOnEvent((event) => {
    if (event.state === 'preparing') current = false
  })
  try {
    await assert.rejects(
      fixture.manager.run(fixture.request(), {
        beforeDispatch: () => {
          if (!current) throw new Error('retired binding')
        }
      }),
      /retired binding/
    )
    assert.deepEqual(
      fixture.events.map((event) => event.state),
      ['queued', 'preparing', 'failed']
    )
    assert.ok(
      fixture.sessions.every(
        (session) => !session.commands.some((command) => command.includes('curl -q'))
      )
    )
    assert.equal(existsSync(join(fixture.remoteRoot, 'owner.bin')), false)
  } finally {
    await fixture.dispose()
  }
})

test('retention cleanup failure rejects without enqueuing the next download', async () => {
  const fixture = remoteDownloadFixture()
  const cleanup = fixture.coordinator.cleanupRetained.bind(fixture.coordinator)
  fixture.coordinator.cleanupRetained = async () => {
    throw new Error('fixture cleanup failed')
  }
  try {
    await assert.rejects(fixture.manager.run(fixture.request()), /cleanup failed/)
    assert.equal(fixture.events.length, 0)
    assert.equal(existsSync(join(fixture.remoteRoot, 'owner.bin')), false)
  } finally {
    fixture.coordinator.cleanupRetained = cleanup
    await fixture.dispose()
  }
})

test('post-commit metadata cleanup failure rejects while the committed artifact remains verifiable', async () => {
  const fixture = remoteDownloadFixture()
  fixture.allow()
  fixture.setBeforeCommand(async (command) => {
    if (command.includes('path=') && command.includes('rm -f -- "$path"'))
      throw new Error('fixture metadata cleanup failed')
  })
  try {
    await assert.rejects(fixture.manager.run(fixture.request()), /metadata cleanup failed/)
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'owner.bin')), fixture.bytes)
    assert.equal(fixture.events.at(-1)?.state, 'failed')
    assert.ok(!fixture.events.some((event) => event.state === 'saved'))
  } finally {
    await fixture.dispose()
  }
})

test('wire input cannot inject desktop control or replace a validated destination while DNS waits', async () => {
  const fixture = remoteDownloadFixture()
  const entered = deferred()
  const release = deferred()
  fixture.allow()
  fixture.setBeforeCommand(async (command) => {
    if (command.includes('getent ahosts')) {
      entered.resolve()
      await release.promise
    }
  })
  try {
    await assert.rejects(
      fixture.manager.run({ ...fixture.request(), control: { beforeDispatch: () => undefined } }),
      /请求无效/
    )
    const request = fixture.request()
    const pending = fixture.manager.run(request)
    await entered.promise
    request.outputPath = '../arbitrary-local-write.bin'
    release.resolve()
    const result = await pending
    assert.equal(result.displayPath, 'owner.bin')
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'owner.bin')), fixture.bytes)
    assert.equal(readFileSync(join(fixture.anchor, 'owner.bin'), 'utf8'), 'local anchor sentinel')
  } finally {
    release.resolve()
    await fixture.dispose()
  }
})

test('shared binary fixture preserves the application-selected project and server identity', async () => {
  const fixture = remoteDownloadFixture({
    projectId: 'selected-project',
    hostProfileId: 'selected-host',
    hostAlias: 'selected-server'
  })
  fixture.allow()
  try {
    const request = fixture.request('selected-session')
    assert.equal(request.projectId, 'selected-project')
    const result = await fixture.manager.run(request)
    assert.equal(result.path, `ssh://selected-server${fixture.remoteRoot}/owner.bin`)
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'owner.bin')), fixture.bytes)
    assert.equal(readFileSync(join(fixture.anchor, 'owner.bin'), 'utf8'), 'local anchor sentinel')
  } finally {
    await fixture.dispose()
  }
})

test('late cancel while old SSH close waits cannot cancel the new same-destination transfer', async () => {
  const fixture = remoteDownloadFixture()
  const oldController = new AbortController()
  const closing = deferred()
  const releaseClose = deferred()
  const oldRequest = fixture.request()
  const old = fixture.manager.run(oldRequest, { signal: oldController.signal })
  const oldRejected = assert.rejects(old, /cancel|abort/i)
  let fresh: ReturnType<typeof fixture.manager.run> | undefined
  try {
    await waitFor(() => existsSync(fixture.startedPath()))
    const oldSession = fixture.sessions[0]!
    const close = oldSession.close.bind(oldSession)
    oldSession.close = async () => {
      await close()
      closing.resolve()
      await releaseClose.promise
    }
    oldController.abort()
    await closing.promise
    const retained = await fixture.coordinator.registry.list()
    assert.equal(retained[0]?.status, 'cancelled')
    const transferId = retained[0]!.transferId
    rmSync(fixture.startedPath())
    fresh = fixture.manager.run(
      fixture.request('session-owner', 'owner.bin', 'request-new-generation')
    )
    void fresh.catch(() => undefined)
    // The new transfer really starts on another SSH session, under the same retained ID.
    await waitFor(() => existsSync(fixture.startedPath()))
    assert.equal(fixture.sessions.length, 2)
    fixture.manager.cancel({
      sessionId: oldRequest.sessionId,
      projectId: oldRequest.projectId,
      requestId: oldRequest.requestId
    })
    releaseClose.resolve()
    await oldRejected
    assert.equal(fixture.sessions[1]?.closed, false)
    fixture.allow()
    const saved = await fresh
    assert.equal(saved.bytes, fixture.bytes.length)
    assert.deepEqual(readFileSync(join(fixture.remoteRoot, 'owner.bin')), fixture.bytes)
    assert.equal(fixture.events.at(-1)?.transferId, transferId)
    assert.equal(fixture.events.at(-1)?.state, 'saved')
    assert.deepEqual(await fixture.coordinator.registry.list(), [])
  } finally {
    fixture.allow()
    releaseClose.resolve()
    await fresh?.catch(() => undefined)
    await oldRejected
    await fixture.dispose()
  }
})
