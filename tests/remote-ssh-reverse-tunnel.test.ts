import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { buildReverseTunnelArgs } from '../src/main/agent/wrappers/remote-ssh-session'
import {
  assertLoopbackTunnelBinding,
  openReverseTunnelLease,
  parseAllocatedTunnelPort,
  reverseTunnelSpecification
} from '../src/main/agent/wrappers/remote-ssh-reverse-tunnel'
import { createReverseSshFixture, socketTable } from './helpers/reverseSshSessionFixture'

test('forward and cancel use the original port-zero request and preserve existing SSH security', () => {
  for (const action of ['forward', 'cancel'] as const) {
    const args = buildReverseTunnelArgs('host', '/private/control', action, 33001, {
      host: 'host',
      user: 'user',
      port: 2222
    })
    assert.equal(args[args.indexOf('-O') + 1], action)
    assert.equal(args[args.indexOf('-F') + 1], '/dev/null')
    assert.equal(args.filter((value) => value === '-R').length, 1)
    assert.ok(!args.includes('-L') && !args.includes('-D'))
    assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:0:127.0.0.1:33001')
    for (const setting of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'ForwardAgent=no',
      'ClearAllForwardings=no',
      'ExitOnForwardFailure=yes'
    ])
      assert.ok(args.includes(setting))
    assert.ok(!args.includes('ClearAllForwardings=yes'))
    assert.ok(args.includes('2222'))
    assert.equal(args.at(-1), 'host')
  }
  for (const port of [0, -1, 65536, NaN, 1.5]) assert.throws(() => reverseTunnelSpecification(port))
})

test('allocated port parsing accepts only one exact legal port', () => {
  assert.equal(parseAllocatedTunnelPort('41000\n'), 41000)
  assert.equal(parseAllocatedTunnelPort('41000\r\n'), 41000)
  for (const output of [
    '',
    '0\n',
    '65536\n',
    '001\n',
    '41000\n42000\n',
    'port 41000',
    ' 41000\n',
    '41000\n\n'
  ])
    assert.throws(() => parseAllocatedTunnelPort(output))
})

test('Linux socket proof accepts only loopback listeners and rejects wildcard, missing or malformed evidence', () => {
  assert.doesNotThrow(() => assertLoopbackTunnelBinding(socketTable([41000]), 41000))
  const ipv6 = socketTable([]).replace(
    /PHI_TCP6\n([^\n]+)\n/,
    '$& 0: 00000000000000000000000001000000:A028 00000000000000000000000000000000:0000 0A 0 0 0\n'
  )
  assert.doesNotThrow(() => assertLoopbackTunnelBinding(ipv6, 41000))
  for (const evidence of [
    socketTable([41000], true),
    socketTable([]),
    socketTable([41000]).replace('0100007F', '0100000A'),
    socketTable([41000]).replace('PHI_TCP6', 'MISSING'),
    socketTable([41000]).replace('0A 00000000', 'XX 00000000'),
    ipv6.replace('00000000000000000000000001000000', '00000000000000000000000000000000')
  ])
    assert.throws(() => assertLoopbackTunnelBinding(evidence, 41000))
})

test('two tunnels reuse one master; closing one preserves the other and cancels its original zero spec', async (t) => {
  const fixture = await createReverseSshFixture()
  t.after(fixture.cleanup)
  const first = await fixture.session.openReverseTunnel!({ localPort: 33001 })
  const second = await fixture.session.openReverseTunnel!({ localPort: 33002 })
  assert.notEqual(first.remotePort, second.remotePort)
  await first.close()
  await first.closed
  assert.equal(fixture.forwards.has('127.0.0.1:0:127.0.0.1:33001'), false)
  assert.equal(fixture.forwards.has('127.0.0.1:0:127.0.0.1:33002'), true)
  assert.equal((await fixture.session.exec('printf connected')).stdout, 'connected')
  assert.equal(fixture.records.filter((record) => record.args.includes('-M')).length, 1)
  assert.equal(
    fixture.records.filter((record) => record.args.includes('-O') && record.args.includes('exit'))
      .length,
    0
  )
  await second.close()
  assert.equal(fixture.forwards.size, 0)
})

test('malformed allocation and wildcard or unavailable socket proof invalidate and cancel before launch', async (t) => {
  for (const options of [
    { portOutput: 'unknown\n' },
    { wildcard: true },
    { inspectOutput: 'unavailable' }
  ]) {
    const fixture = await createReverseSshFixture(options)
    t.after(fixture.cleanup)
    let revoked = 0
    await assert.rejects(
      fixture.session.openReverseTunnel!({
        localPort: 33001,
        onInvalidated: () => {
          revoked++
        }
      })
    )
    assert.equal(revoked, 1)
    assert.equal(fixture.forwards.size, 0)
    assert.ok(fixture.records.some((record) => record.args.includes('cancel')))
  }
})

test('cancellation before forward acknowledgement invalidates access and eventually cancels an uncertain request', async (t) => {
  const fixture = await createReverseSshFixture({ forwardDelayMs: 1000 })
  t.after(fixture.cleanup)
  const controller = new AbortController()
  let revoked = false
  const opening = fixture.session.openReverseTunnel!({
    localPort: 33001,
    signal: controller.signal,
    onInvalidated: () => {
      revoked = true
    }
  })
  const rejected = assert.rejects(opening, { name: 'AbortError' })
  await delay(30)
  controller.abort()
  assert.equal(revoked, true)
  await rejected
  for (let attempt = 0; fixture.forwards.size && attempt < 100; attempt++) await delay(10)
  assert.equal(fixture.forwards.size, 0)
})

test('late forward acquisition settles after cancellation and is separately cancelled without waiting for its gate', async () => {
  const controller = new AbortController()
  const connection = new AbortController()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let cancellations = 0
  let revoked = 0
  const opening = openReverseTunnelLease({
    localPort: 33001,
    signal: controller.signal,
    connectionSignal: connection.signal,
    onInvalidated: () => {
      revoked++
      throw new Error('observer failure')
    },
    forward: async () => {
      entered()
      await gate
      return { stdout: '41000\n', stderr: '', code: 0, signal: null }
    },
    cancel: async () => {
      cancellations++
      return { stdout: '', stderr: '', code: 0, signal: null }
    },
    inspect: async () => ({ stdout: socketTable([41000]), stderr: '', code: 0, signal: null })
  })
  await started
  const rejected = assert.rejects(opening, { name: 'AbortError' })
  controller.abort()
  await Promise.race([
    rejected,
    delay(500).then(() => {
      throw new Error('Cancellation waited for late allocation')
    })
  ])
  assert.equal(revoked, 1)
  assert.equal(cancellations, 0)
  release()
  for (let attempt = 0; !cancellations && attempt < 100; attempt++) await delay(5)
  assert.equal(cancellations, 1)
})

test('master disconnect immediately closes the lease and revokes its gateway', async (t) => {
  const fixture = await createReverseSshFixture()
  t.after(fixture.cleanup)
  let revoked = 0
  const tunnel = await fixture.session.openReverseTunnel!({
    localPort: 33001,
    onInvalidated: () => {
      revoked++
    }
  })
  fixture.master.kill('SIGTERM')
  await tunnel.closed
  assert.equal(revoked, 1)
  await assert.rejects(fixture.session.exec('printf forbidden'))
})

test('duplicate live local gateway ports are refused and cancel errors do not keep gateway access active', async (t) => {
  const fixture = await createReverseSshFixture({ cancelFails: true })
  t.after(fixture.cleanup)
  let revoked = 0
  const tunnel = await fixture.session.openReverseTunnel!({
    localPort: 33001,
    onInvalidated: () => {
      revoked++
    }
  })
  await assert.rejects(
    fixture.session.openReverseTunnel!({ localPort: 33001 }),
    /already has a reverse tunnel/
  )
  const closing = tunnel.close()
  await tunnel.closed
  assert.equal(revoked, 1)
  await assert.rejects(closing, /cancellation could not be confirmed/)
  await assert.rejects(
    fixture.session.openReverseTunnel!({ localPort: 33001 }),
    /already has a reverse tunnel/
  )
})

test('gateway invalidation precedes a delayed cancellation confirmation and async observer errors stay isolated', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let invalidated = false
  const connection = new AbortController()
  const tunnel = await openReverseTunnelLease({
    localPort: 33001,
    connectionSignal: connection.signal,
    forward: async () => ({ stdout: '41000\n', stderr: '', code: 0, signal: null }),
    inspect: async () => ({ stdout: socketTable([41000]), stderr: '', code: 0, signal: null }),
    cancel: async () => {
      await gate
      return { stdout: '', stderr: '', code: 0, signal: null }
    },
    onInvalidated: async () => {
      invalidated = true
      throw new Error('async observer error')
    }
  })
  const closing = tunnel.close()
  await tunnel.closed
  assert.equal(invalidated, true)
  release()
  await closing
})
