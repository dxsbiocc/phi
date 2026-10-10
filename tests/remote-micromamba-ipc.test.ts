import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerRemoteMicromambaIpc } from '../src/main/agent/remote-micromamba-ipc'

type Handler = (event: never, value: unknown) => Promise<unknown>

function setup(install: (...args: never[]) => Promise<unknown>): Handler {
  let handler: Handler | undefined
  registerRemoteMicromambaIpc(
    {
      handle: (_channel, registered) => {
        handler = registered as Handler
      }
    },
    install as never
  )
  assert.ok(handler)
  return handler
}

describe('remote micromamba IPC', () => {
  it('validates the request and tags progress with the renderer request id', async () => {
    const sent: unknown[] = []
    const calls: unknown[] = []
    const expected = {
      status: 'installed',
      version: '2.9.0-0',
      platform: 'linux-x64',
      durationMs: 1,
      warningCodes: [],
      message: '完成'
    }
    const handler = setup(async (...args: unknown[]) => {
      calls.push(args)
      const request = args[1] as { onProgress: (value: unknown) => void }
      request.onProgress({ stage: 'download', message: '下载中' })
      return expected
    })
    const event = {
      sender: {
        isDestroyed: () => false,
        send: (channel: string, data: unknown) => sent.push({ channel, data })
      }
    }
    const result = await handler(event as never, {
      requestId: 'request-1',
      hostProfileId: 'host-1',
      runtimeRoot: '/data/runtime',
      downloadMirrorPrefix: ' https://mirror.example/ ',
      confirmedWarnings: ['noexec']
    })

    assert.deepEqual(result, expected)
    assert.equal(calls[0]?.[0], 'host-1')
    assert.equal(
      (calls[0]?.[1] as { downloadMirrorPrefix?: string }).downloadMirrorPrefix,
      'https://mirror.example/'
    )
    assert.deepEqual(sent, [
      {
        channel: 'remote:micromambaProgress',
        data: { requestId: 'request-1', stage: 'download', message: '下载中' }
      }
    ])
  })

  it('rejects malformed requests before starting any operation', async () => {
    let calls = 0
    const handler = setup(async () => {
      calls += 1
      return {}
    })
    const event = { sender: { isDestroyed: () => false, send: () => undefined } }

    await assert.rejects(
      handler(event as never, {
        requestId: '',
        hostProfileId: 'host-1',
        runtimeRoot: '/data/runtime'
      }),
      /请求无效/
    )
    await assert.rejects(
      handler(event as never, {
        requestId: 'request-1',
        hostProfileId: 'host-1',
        runtimeRoot: '/data/runtime',
        confirmedWarnings: ['invented-warning']
      }),
      /确认值无效/
    )
    await assert.rejects(
      handler(event as never, {
        requestId: 'request-1',
        hostProfileId: 'host-1',
        runtimeRoot: '/data/runtime',
        downloadMirrorPrefix: 'https://user@example.com/'
      }),
      /不能包含用户名或密码/
    )
    assert.equal(calls, 0)
  })
})
