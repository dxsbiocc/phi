import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { parseRunGuardRefusal, runGuardRefusalError } from '../src/main/agent/engine/rpc/run-guard'
import { errorCodeOf } from '../src/shared/errorCodes'

test('a busy run lock caused by a missing flock binary points at the server tool', () => {
  const refusal = parseRunGuardRefusal(
    'phi-run: flock: command not found\nPHI_LAUNCH:RUN_LOCK_BUSY\n'
  )
  assert.equal(refusal?.code, 'DOMAIN_INVALID')
  assert.match(refusal?.message ?? '', /flock/u)
  assert.match(refusal?.message ?? '', /util-linux/u)
})

test('a busy run lock without tool evidence means another run still holds the session', () => {
  const refusal = parseRunGuardRefusal('PHI_LAUNCH:RUN_LOCK_BUSY\n')
  assert.equal(refusal?.code, 'DOMAIN_CONFLICT')
  assert.match(refusal?.message ?? '', /占用/u)
})

test('a group-leader refusal caused by a denied ps names the permission problem', () => {
  const refusal = parseRunGuardRefusal(
    'sh: /bin/ps: Operation not permitted\nPHI_LAUNCH:NOT_GROUP_LEADER\n'
  )
  assert.equal(refusal?.code, 'DOMAIN_INVALID')
  assert.match(refusal?.message ?? '', /ps/u)
})

test('a group-leader refusal without a ps problem keeps the launch-shape explanation', () => {
  const refusal = parseRunGuardRefusal('PHI_LAUNCH:NOT_GROUP_LEADER\n')
  assert.equal(refusal?.code, 'DOMAIN_INVALID')
  assert.match(refusal?.message ?? '', /进程组组长/u)
})

test('stderr without a launch marker keeps the generic transport failure', () => {
  assert.equal(parseRunGuardRefusal('just some noise\n'), undefined)
  assert.equal(runGuardRefusalError('just some noise\n'), undefined)
})

test('runGuardRefusalError carries the code so callers can branch on it', () => {
  const error = runGuardRefusalError('PHI_LAUNCH:RUN_LOCK_BUSY\n')
  assert.ok(error)
  assert.equal(errorCodeOf(error), 'DOMAIN_CONFLICT')
})

interface RefusalTransport {
  transport: {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    closed: Promise<{ code: number | null; signal: string | null }>
    close(): Promise<void>
  }
  write(): void
}

function refusalTransport(
  output: ReadonlyArray<{ stream: 'stderr' | 'stdout'; text: string }>
): RefusalTransport {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const transport = {
    stdin,
    stdout,
    stderr,
    // A refused launch exits non-zero right after writing its marker.
    closed: Promise.resolve({ code: 75, signal: null }),
    close: async (): Promise<void> => undefined
  }
  return {
    transport,
    write: (): void => {
      for (const line of output) {
        if (line.stream === 'stderr') stderr.write(line.text)
        else stdout.write(line.text)
      }
      stdout.end()
      stderr.end()
    }
  }
}

test('a launch refusal reaches the caller as its own error instead of a bare stream end', async () => {
  const fake = refusalTransport([
    { stream: 'stderr', text: 'phi-run: flock: command not found\nPHI_LAUNCH:RUN_LOCK_BUSY\n' }
  ])
  const connection = new RpcConnection(() => fake.transport, {
    startupTimeoutMs: 5000,
    describeTransportEnd: runGuardRefusalError
  })
  const starting = connection.start()
  fake.write()
  await assert.rejects(starting, (error: unknown) => {
    assert.equal(errorCodeOf(error), 'DOMAIN_INVALID')
    assert.match((error as Error).message, /flock/u)
    return true
  })
  await connection.close()
})

test('an end without any launch marker still reports the transport loss', async () => {
  const fake = refusalTransport([{ stream: 'stderr', text: 'some other diagnostic\n' }])
  const connection = new RpcConnection(() => fake.transport, {
    startupTimeoutMs: 5000,
    describeTransportEnd: runGuardRefusalError
  })
  const starting = connection.start()
  fake.write()
  await assert.rejects(starting, (error: unknown) => {
    assert.equal(errorCodeOf(error), 'TRANSPORT_LOST')
    assert.match((error as Error).message, /RPC output stream ended/u)
    return true
  })
  await connection.close()
})
