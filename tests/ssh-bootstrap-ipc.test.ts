import assert from 'node:assert/strict'
import test from 'node:test'

import { registerSshBootstrapIpc } from '../src/main/agent/ssh-bootstrap/ipc'
import type { SshBootstrapCoordinator } from '../src/main/agent/ssh-bootstrap/coordinator'
import type { SshBootstrapKeyProtectionRequest } from '../src/shared/sshBootstrapTypes'

type RegisteredHandler = (
  event: {
    sender: { mainFrame: unknown; isDestroyed(): boolean }
    senderFrame: unknown
  },
  ...args: unknown[]
) => Promise<unknown>

test('SSH bootstrap IPC rejects foreign frames before a password reaches the coordinator', async () => {
  const handlers = new Map<string, RegisteredHandler>()
  const trusted = { mainFrame: {}, isDestroyed: () => false }
  let credentialCalls = 0
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    verifyPassword: async () => {
      credentialCalls += 1
      return { status: 'failed', errorCode: 'unexpected', retryable: false } as const
    },
    completeWithKeyProtection: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    completeWithCredentials: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    saveConfig: async () => assert.fail('not used'),
    declineConfig: async () => assert.fail('not used'),
    cancel: async () => undefined
  } satisfies SshBootstrapCoordinator
  registerSshBootstrapIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => trusted,
    coordinator
  )

  const handler = handlers.get('sshBootstrap:verifyPassword')
  assert.ok(handler)
  await assert.rejects(
    handler({ sender: { mainFrame: {}, isDestroyed: () => false }, senderFrame: {} }, 'attempt-1', {
      password: 'must-not-cross-boundary'
    }),
    /not authorized/
  )
  assert.equal(credentialCalls, 0)
})

test('SSH bootstrap IPC replaces password verification errors with a fixed public result', async () => {
  const handlers = new Map<string, RegisteredHandler>()
  const mainFrame = {}
  const trusted = { mainFrame, isDestroyed: () => false }
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    verifyPassword: async () => {
      throw new Error('server-secret /private/home/.ssh/key')
    },
    completeWithKeyProtection: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    completeWithCredentials: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    saveConfig: async () => assert.fail('not used'),
    declineConfig: async () => assert.fail('not used'),
    cancel: async () => undefined
  } satisfies SshBootstrapCoordinator
  registerSshBootstrapIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => trusted,
    coordinator
  )

  const password = { password: 'server-secret' }
  const result = await handlers.get('sshBootstrap:verifyPassword')?.(
    { sender: trusted, senderFrame: mainFrame },
    'attempt-1',
    password
  )
  assert.deepEqual(result, { status: 'failed', errorCode: 'unexpected', retryable: false })
  assert.equal(password.password, '')
  assert.doesNotMatch(JSON.stringify(result), /server-secret|private\/home/)
})

test('SSH bootstrap IPC rejects malformed key-protection unions before orchestration', async () => {
  const handlers = new Map<string, RegisteredHandler>()
  const mainFrame = {}
  const trusted = { mainFrame, isDestroyed: () => false }
  let calls = 0
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    verifyPassword: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    completeWithKeyProtection: async () => {
      calls += 1
      return { status: 'failed', errorCode: 'unexpected', retryable: false } as const
    },
    completeWithCredentials: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
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
    keyProtection: 'passphrase-typo',
    passphrase: 'key-secret'
  }
  const result = await handlers.get('sshBootstrap:completeWithKeyProtection')?.(
    { sender: trusted, senderFrame: mainFrame },
    'attempt-1',
    malformed
  )

  assert.deepEqual(result, { status: 'failed', errorCode: 'unexpected', retryable: false })
  assert.equal(calls, 0)
  assert.equal(malformed.passphrase, '')
})

test('split SSH bootstrap IPC clears password and passphrase inputs at their separate boundaries', async () => {
  const handlers = new Map<string, RegisteredHandler>()
  const mainFrame = {}
  const trusted = { mainFrame, isDestroyed: () => false }
  const calls: string[] = []
  const coordinator = {
    inspectTarget: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    confirmHostKey: async () => ({ status: 'rejected', errorCode: 'unexpected' }) as const,
    verifyPassword: async (_attemptId: string, input: { password: string }) => {
      calls.push(`verify:${input.password}`)
      input.password = ''
      return { status: 'ready', attemptId: 'attempt-1', agentState: 'ready' } as const
    },
    completeWithKeyProtection: async (
      _attemptId: string,
      input: SshBootstrapKeyProtectionRequest
    ) => {
      if (input.keyProtection !== 'passphrase') assert.fail('expected passphrase protection')
      calls.push(`configure:${input.passphrase}`)
      input.passphrase = ''
      return { status: 'failed', errorCode: 'unexpected', retryable: false } as const
    },
    completeWithCredentials: async () =>
      ({ status: 'failed', errorCode: 'unexpected', retryable: false }) as const,
    saveConfig: async () => assert.fail('not used'),
    declineConfig: async () => assert.fail('not used'),
    cancel: async () => undefined
  } satisfies SshBootstrapCoordinator
  registerSshBootstrapIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => trusted,
    coordinator
  )
  const password = { password: 'one-use-secret' }
  const protection: { keyProtection: 'passphrase'; passphrase: string } = {
    keyProtection: 'passphrase',
    passphrase: 'key-secret'
  }

  const verified = await handlers.get('sshBootstrap:verifyPassword')?.(
    { sender: trusted, senderFrame: mainFrame },
    'attempt-1',
    password
  )
  const prepared = await handlers.get('sshBootstrap:completeWithKeyProtection')?.(
    { sender: trusted, senderFrame: mainFrame },
    'attempt-1',
    protection
  )

  assert.deepEqual(calls, ['verify:one-use-secret', 'configure:key-secret'])
  assert.equal(password.password, '')
  assert.equal(protection.passphrase, '')
  assert.doesNotMatch(JSON.stringify([verified, prepared]), /one-use-secret|key-secret/)
})
