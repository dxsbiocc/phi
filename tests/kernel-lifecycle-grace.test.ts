import assert from 'node:assert/strict'
import test from 'node:test'

import { KernelGracePeriod } from '../src/kernel/lifecycle/grace-period'

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

test('a reconnect cancels grace expiry and the next detach starts a fresh period', async () => {
  let expiries = 0
  const grace = new KernelGracePeriod({
    graceMs: 30,
    async onExpire() {
      expiries += 1
    }
  })

  grace.startDisconnected()
  await delay(10)
  grace.controllerAttached()
  await delay(35)
  assert.equal(expiries, 0)

  grace.controllerDetached()
  await delay(45)
  assert.equal(expiries, 1)
  grace.close()
})
