import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { it } from 'node:test'

import { connectRemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

it('backs off between control checks while a slow login completes', async () => {
  let checks = 0
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    if (args.includes('check')) {
      checks += 1
      return spawn('sh', ['-c', 'exit 1'])
    }
    return spawn('sh', ['-c', 'sleep 30'])
  }) as never
  await assert.rejects(() =>
    connectRemoteSshSession({ host: 'phi-ready-polling', readyTimeoutMs: 3_000 }, { spawnImpl })
  )
  // A fixed 100 ms delay polls about 30 times here. Each poll is an ssh process.
  assert.ok(checks >= 3 && checks <= 10, `checks=${checks}`)
})
