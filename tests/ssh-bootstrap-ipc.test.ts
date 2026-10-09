import assert from 'node:assert/strict'
import test from 'node:test'

import { registerSshBootstrapIpc } from '../src/main/agent/ssh-bootstrap/ipc'
import type { SshBootstrapCoordinator } from '../src/main/agent/ssh-bootstrap/coordinator'

test('SSH bootstrap IPC rejects foreign frames before credentials reach the coordinator', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const trusted = { mainFrame: {}, isDestroyed: () => false }
  let credentialCalls = 0
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    completeWithCredentials: async () => {
      credentialCalls += 1
      return { status: 'failed', errorCode: 'unexpected', retryable: false } as const
    },
    saveConfig: async () => assert.fail('not used'),
    declineConfig: async () => assert.fail('not used'),
    cancel: async () => undefined
  } satisfies SshBootstrapCoordinator
  registerSshBootstrapIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => trusted,
    coordinator
  )

  const handler = handlers.get('sshBootstrap:completeWithCredentials')
  assert.ok(handler)
  await assert.rejects(
    handler({ sender: { mainFrame: {}, isDestroyed: () => false }, senderFrame: {} }, 'attempt-1', {
      password: 'must-not-cross-boundary',
      keyProtection: 'passphrase',
      passphrase: 'must-not-cross-boundary-either'
    }),
    /not authorized/
  )
  assert.equal(credentialCalls, 0)
})

test('SSH bootstrap IPC replaces internal credential errors with a fixed public result', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const mainFrame = {}
  const trusted = { mainFrame, isDestroyed: () => false }
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    completeWithCredentials: async () => {
      throw new Error('server-secret key-secret /private/home/.ssh/key')
    },
    saveConfig: async () => assert.fail('not used'),
    declineConfig: async () => assert.fail('not used'),
    cancel: async () => undefined
  } satisfies SshBootstrapCoordinator
  registerSshBootstrapIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => trusted,
    coordinator
  )

  const result = await handlers.get('sshBootstrap:completeWithCredentials')?.(
    { sender: trusted, senderFrame: mainFrame },
    'attempt-1',
    {
      password: 'server-secret',
      keyProtection: 'passphrase',
      passphrase: 'key-secret'
    }
  )
  assert.deepEqual(result, { status: 'failed', errorCode: 'unexpected', retryable: false })
  assert.doesNotMatch(JSON.stringify(result), /server-secret|key-secret|private\/home/)
})

test('SSH bootstrap IPC rejects malformed credential unions before orchestration', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const mainFrame = {}
  const trusted = { mainFrame, isDestroyed: () => false }
  let calls = 0
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    completeWithCredentials: async () => {
      calls += 1
      return { status: 'failed', errorCode: 'unexpected', retryable: false } as const
    },
    saveConfig: async () => assert.fail('not used'),
    declineConfig: async () => assert.fail('not used'),
    cancel: async () => undefined
  } satisfies SshBootstrapCoordinator
  registerSshBootstrapIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => trusted,
    coordinator
  )
  const malformed = {
    password: 'server-secret',
    keyProtection: 'passphrase-typo',
    passphrase: 'key-secret'
  }
  const result = await handlers.get('sshBootstrap:completeWithCredentials')?.(
    { sender: trusted, senderFrame: mainFrame },
    'attempt-1',
    malformed
  )

  assert.deepEqual(result, { status: 'failed', errorCode: 'unexpected', retryable: false })
  assert.equal(calls, 0)
  assert.equal(malformed.password, '')
  assert.equal(malformed.passphrase, '')
})
