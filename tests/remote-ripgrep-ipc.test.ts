import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { registerRemoteRipgrepIpc } from '../src/main/agent/remote-ripgrep-ipc'

type Handler = (event: never, value: unknown) => Promise<unknown>

function setup(run: (...args: never[]) => Promise<unknown>): Handler {
  let handler: Handler | undefined
  registerRemoteRipgrepIpc(
    {
      handle: (channel, registered) => {
        assert.equal(channel, 'remote:ripgrep')
        handler = registered as Handler
      }
    },
    run as never
  )
  assert.ok(handler)
  return handler
}

describe('remote ripgrep IPC', () => {
  it('uses one operation channel and tags the reusable progress shape', async () => {
    const sent: unknown[] = []
    const calls: unknown[] = []
    const expected = { status: 'installed', durationMs: 2, warningCodes: [], message: '完成' }
    const handler = setup(async (...args: unknown[]) => {
      calls.push(args)
      const request = args[1] as { onProgress: (value: unknown) => void }
      request.onProgress({ stage: 'remote-downloading', message: '安装中', requestId: undefined })
      return expected
    })
    const event = {
      sender: {
        isDestroyed: () => false,
        send: (channel: string, data: unknown) => sent.push({ channel, data })
      }
    }
    const result = await handler(event as never, {
      action: 'install',
      requestId: 'request-1',
      hostProfileId: 'host-1',
      runtimeRoot: '/data/runtime',
      confirmedWarnings: ['noexec'],
      forceManaged: true
    })

    assert.deepEqual(result, expected)
    assert.equal(calls[0]?.[0], 'host-1')
    assert.deepEqual(sent, [
      {
        channel: 'remote:ripgrepProgress',
        data: { requestId: 'request-1', stage: 'remote-downloading', message: '安装中' }
      }
    ])
  })

  it('rejects malformed status and install requests before connecting', async () => {
    let calls = 0
    const handler = setup(async () => {
      calls += 1
      return {}
    })
    const event = { sender: { isDestroyed: () => false, send: () => undefined } }

    await assert.rejects(
      handler(event as never, {
        action: 'remove',
        requestId: 'request-1',
        hostProfileId: 'host-1',
        runtimeRoot: '/data/runtime'
      }),
      /请求无效/
    )
    await assert.rejects(
      handler(event as never, {
        action: 'install',
        requestId: 'request-1',
        hostProfileId: 'host-1',
        runtimeRoot: '/data/runtime',
        confirmedWarnings: ['invented-warning']
      }),
      /请求无效/
    )
    assert.equal(calls, 0)
  })
})
