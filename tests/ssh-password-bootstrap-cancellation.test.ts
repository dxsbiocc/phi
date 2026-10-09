import assert from 'node:assert/strict'
import test from 'node:test'

import { createSshBootstrapCoordinator } from '../src/main/agent/ssh-bootstrap/coordinator'

const TARGET = {
  alias: 'lab-hpc',
  hostname: 'compute.example.invalid',
  user: 'scientist',
  port: 22
}

test('cancelling an in-flight password verification closes the late session without reviving it', async () => {
  let releaseAuthentication!: () => void
  const authenticationGate = new Promise<void>((resolve) => {
    releaseAuthentication = resolve
  })
  let closes = 0
  const coordinator = createSshBootstrapCoordinator({
    createId: () => 'attempt-cancelled',
    preflight: async () => ({
      status: 'ready',
      platform: 'darwin',
      openSshVersion: '10.3',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({ status: 'ready', fingerprints: [] }),
      confirmHostKey: async () => assert.fail('not used')
    },
    authenticate: async () => {
      await authenticationGate
      return {
        status: 'ready',
        session: {
          installPublicKey: async () => assert.fail('cancelled session must not install a key'),
          close: async () => {
            closes += 1
          }
        }
      }
    },
    generateKey: async () => assert.fail('cancelled attempt must not generate a key'),
    installKey: async () => assert.fail('cancelled attempt must not install a key'),
    loadKey: async () => assert.fail('cancelled attempt must not load a key'),
    verifyKey: async () => assert.fail('cancelled attempt must not verify a key'),
    saveHost: async () => assert.fail('cancelled attempt must not write config')
  })
  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return

  const verifying = coordinator.verifyPassword(inspected.attemptId, {
    password: 'one-use-secret'
  })
  await new Promise((resolve) => setImmediate(resolve))
  await coordinator.cancel(inspected.attemptId)
  releaseAuthentication()

  assert.deepEqual(await verifying, {
    status: 'failed',
    errorCode: 'unexpected',
    retryable: false
  })
  assert.equal(closes, 1)
  assert.deepEqual(
    await coordinator.completeWithKeyProtection(inspected.attemptId, {
      keyProtection: 'passphrase',
      passphrase: 'key-secret'
    }),
    { status: 'failed', errorCode: 'unexpected', retryable: false }
  )
})

test('cancelling key setup cannot revive an attempt after asynchronous key generation', async () => {
  let releaseGeneration!: () => void
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve
  })
  let closed = false
  let verifyCalls = 0
  const coordinator = createSshBootstrapCoordinator({
    createId: () => 'attempt-key-cancelled',
    preflight: async () => ({
      status: 'ready',
      platform: 'darwin',
      openSshVersion: '10.3',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({ status: 'ready', fingerprints: [] }),
      confirmHostKey: async () => assert.fail('not used')
    },
    authenticate: async () => ({
      status: 'ready',
      session: {
        installPublicKey: async () => ({ status: 'ready' as const }),
        close: async () => {
          closed = true
        }
      }
    }),
    generateKey: async () => {
      await generationGate
      return {
        status: 'ready',
        privateKeyPath: '/Users/private/.ssh/phi_lab-hpc_ed25519',
        publicKey: 'ssh-ed25519 AAAA-new-key phi@test',
        fingerprint: 'SHA256:new-key'
      }
    },
    installKey: async () => assert.fail('verified session must be reused'),
    loadKey: async () => ({ status: 'ready' }),
    verifyKey: async () => {
      verifyCalls += 1
      return { status: 'ready' }
    },
    saveHost: async () => assert.fail('cancelled setup must not write config')
  })
  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return
  await coordinator.verifyPassword(inspected.attemptId, { password: 'one-use-secret' })

  const completing = coordinator.completeWithKeyProtection(inspected.attemptId, {
    keyProtection: 'passphrase',
    passphrase: 'key-secret'
  })
  await new Promise((resolve) => setImmediate(resolve))
  await coordinator.cancel(inspected.attemptId)
  releaseGeneration()

  assert.deepEqual(await completing, {
    status: 'failed',
    errorCode: 'unexpected',
    retryable: false
  })
  assert.equal(closed, true)
  assert.equal(verifyCalls, 0)
})
