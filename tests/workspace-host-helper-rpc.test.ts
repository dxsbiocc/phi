import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { mapHelperWorkspacePath } from '../src/main/agent/workspace-host/helper-host'
import { HelperRpcClient } from '../src/main/agent/workspace-host/helper-rpc'
import { WorkspaceHostError } from '../src/main/agent/workspace-host/types'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

function fakeProcess(): {
  process: RemoteStdioProcess
  requests: PassThrough
  responses: PassThrough
} {
  const requests = new PassThrough()
  const responses = new PassThrough()
  const stderr = new PassThrough()
  let resolveClosed: (result: { code: number | null; signal: string | null }) => void = () => {
    throw new Error('closed promise is not initialized')
  }
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  return {
    requests,
    responses,
    process: {
      stdin: requests,
      stdout: responses,
      stderr,
      closed,
      async close() {
        requests.end()
        responses.end()
        stderr.end()
        resolveClosed({ code: 0, signal: null })
      }
    }
  }
}

test('helper RPC uses big-endian length frames and accepts split responses', async () => {
  const fixture = fakeProcess()
  const client = new HelperRpcClient(fixture.process)
  const requestBytes = new Promise<Buffer>((resolve) => fixture.requests.once('data', resolve))
  const pending = client.request<{ kind: string; size: number }>('fs.stat', { path: 'a.txt' })
  const request = await requestBytes
  const length = request.readUInt32BE(0)
  const body = JSON.parse(request.subarray(4, 4 + length).toString('utf8')) as Record<
    string,
    unknown
  >

  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.method, 'fs.stat')
  assert.deepEqual(body.params, { path: 'a.txt' })
  const response = frame({ jsonrpc: '2.0', id: body.id, result: { kind: 'file', size: 3 } })
  for (const byte of response) fixture.responses.write(Buffer.from([byte]))
  assert.deepEqual(await pending, { kind: 'file', size: 3 })
  await client.close()
})

test('helper RPC maps structured path errors to WorkspaceHostError', async () => {
  const fixture = fakeProcess()
  const client = new HelperRpcClient(fixture.process)
  fixture.requests.once('data', (request: Buffer) => {
    const body = JSON.parse(request.subarray(4).toString('utf8')) as { id: number }
    fixture.responses.write(
      frame({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32602,
          message: 'outside root',
          data: { code: 'PATH_OUTSIDE_ROOT' }
        }
      })
    )
  })

  await assert.rejects(client.request('fs.stat', { path: '../outside' }), (error) => {
    assert.ok(error instanceof WorkspaceHostError)
    assert.equal(error.code, 'PATH_OUTSIDE_ROOT')
    return true
  })
  await client.close()
})

test('helper transport maps an absolute workspace alias into the canonical root', () => {
  assert.equal(
    mapHelperWorkspacePath('/workspace/link/nested/file.txt', '/workspace/link', '/srv/project'),
    '/srv/project/nested/file.txt'
  )
  assert.equal(
    mapHelperWorkspacePath('/srv/project/nested/file.txt', '/workspace/link', '/srv/project'),
    '/srv/project/nested/file.txt'
  )
  assert.throws(
    () => mapHelperWorkspacePath('/workspace/outside', '/workspace/link', '/srv/project'),
    { code: 'PATH_OUTSIDE_ROOT' }
  )
  for (const path of ['ssh://cluster/project', '~/project', '../project']) {
    assert.throws(() => mapHelperWorkspacePath(path, '/workspace/link', '/srv/project'), {
      code: 'PATH_OUTSIDE_ROOT'
    })
  }
})

test('helper RPC rejects a malicious response length before allocating its payload', async () => {
  const fixture = fakeProcess()
  const client = new HelperRpcClient(fixture.process, { maxFrameBytes: 128 })
  const requestWritten = new Promise<void>((resolve) =>
    fixture.requests.once('data', () => resolve())
  )
  const pending = client.request('fs.stat', { path: 'a.txt' })
  await requestWritten
  const header = Buffer.alloc(4)
  header.writeUInt32BE(129)
  fixture.responses.write(header)

  await assert.rejects(pending, /response frame is too large/)
  await client.close()
})
