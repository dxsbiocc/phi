import assert from 'node:assert/strict'
import test from 'node:test'

import { createSshBootstrapCoordinator } from '../src/main/agent/ssh-bootstrap/coordinator'

const TARGET = {
  alias: 'lab-hpc',
  hostname: 'compute.example.invalid',
  user: 'scientist',
  port: 22
}

test('credentials cannot run before the user confirms an untrusted host fingerprint', async () => {
  let credentialCalls = 0
  const coordinator = createSshBootstrapCoordinator({
    createId: () => 'attempt-1',
    preflight: async () => ({
      status: 'ready',
      platform: 'darwin',
      openSshVersion: '10.3',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({
        status: 'confirmation-required',
        confirmationId: 'host-confirmation-1',
        fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:host-key' }]
      }),
      confirmHostKey: async () => ({
        status: 'ready',
        fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:host-key' }]
      })
    },
    authenticate: async () => {
      credentialCalls += 1
      return { status: 'ready' }
    },
    generateKey: async () => assert.fail('key generation must not run'),
    installKey: async () => assert.fail('key installation must not run'),
    loadKey: async () => assert.fail('key loading must not run'),
    verifyKey: async () => assert.fail('key verification must not run'),
    saveHost: async () => assert.fail('config must not be written')
  })

  assert.deepEqual(await coordinator.inspectTarget(TARGET), {
    status: 'confirmation-required',
    attemptId: 'attempt-1',
    fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:host-key' }]
  })
  const credentials = {
    password: 'server-secret',
    keyProtection: 'passphrase' as const,
    passphrase: 'key-secret'
  }
  assert.deepEqual(await coordinator.completeWithCredentials('attempt-1', credentials), {
    status: 'failed',
    errorCode: 'unexpected',
    retryable: false
  })
  assert.equal(credentialCalls, 0)
  assert.equal(credentials.password, '')
  assert.equal(credentials.passphrase, '')
})

test('cancelling host-key confirmation prevents a late confirmation from reviving the attempt', async () => {
  let releaseConfirmation!: () => void
  const confirmationGate = new Promise<void>((resolve) => {
    releaseConfirmation = resolve
  })
  const coordinator = createSshBootstrapCoordinator({
    createId: () => 'attempt-host-cancelled',
    preflight: async () => ({
      status: 'ready',
      platform: 'darwin',
      openSshVersion: '10.3',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({
        status: 'confirmation-required',
        confirmationId: 'host-confirmation-cancelled',
        fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:host-key' }]
      }),
      confirmHostKey: async () => {
        await confirmationGate
        return {
          status: 'ready',
          fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:host-key' }]
        }
      }
    },
    authenticate: async () => assert.fail('cancelled attempt must not authenticate'),
    generateKey: async () => assert.fail('cancelled attempt must not generate a key'),
    installKey: async () => assert.fail('cancelled attempt must not install a key'),
    loadKey: async () => assert.fail('cancelled attempt must not load a key'),
    verifyKey: async () => assert.fail('cancelled attempt must not verify a key'),
    saveHost: async () => assert.fail('cancelled attempt must not write config')
  })
  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'confirmation-required')
  if (inspected.status !== 'confirmation-required') return

  const confirming = coordinator.confirmHostKey(inspected.attemptId)
  await new Promise((resolve) => setImmediate(resolve))
  await coordinator.cancel(inspected.attemptId)
  releaseConfirmation()

  assert.deepEqual(await confirming, { status: 'rejected', errorCode: 'unexpected' })
  assert.deepEqual(
    await coordinator.verifyPassword(inspected.attemptId, { password: 'one-use-secret' }),
    { status: 'failed', errorCode: 'unexpected', retryable: false }
  )
})

test('a verified password session can be declined without generating a key or writing config', async () => {
  const calls: string[] = []
  const coordinator = createSshBootstrapCoordinator({
    createId: () => 'attempt-choice',
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
    authenticate: async (_target, password) => {
      calls.push(`authenticate:${password}`)
      return {
        status: 'ready',
        session: {
          installPublicKey: async () => assert.fail('declining must not install a public key'),
          close: async () => {
            calls.push('close-password-session')
          }
        }
      }
    },
    generateKey: async () => assert.fail('declining must not generate a key'),
    installKey: async () => assert.fail('declining must not install a key'),
    loadKey: async () => assert.fail('declining must not load a key'),
    verifyKey: async () => assert.fail('declining must not verify a key'),
    saveHost: async () => assert.fail('declining must not write SSH config')
  })

  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return
  const password = { password: 'one-use-secret' }
  const verified = await coordinator.verifyPassword(inspected.attemptId, password)

  assert.deepEqual(verified, {
    status: 'ready',
    attemptId: 'attempt-choice',
    agentState: 'ready'
  })
  assert.equal(password.password, '')
  assert.doesNotMatch(JSON.stringify(verified), /one-use-secret/)
  await coordinator.cancel(inspected.attemptId)
  assert.deepEqual(calls, ['authenticate:one-use-secret', 'close-password-session'])
})

test('protected-key setup reuses the verified session without receiving the password again', async () => {
  const calls: string[] = []
  const ids = ['attempt-split', 'operation-split']
  const coordinator = createSshBootstrapCoordinator({
    createId: () => ids.shift() ?? 'unexpected-id',
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
    authenticate: async (_target, password) => {
      calls.push(`authenticate:${password}`)
      return {
        status: 'ready',
        session: {
          installPublicKey: async () => {
            calls.push('install-public-key')
            return { status: 'ready' as const }
          },
          close: async () => {
            calls.push('close-password-session')
          }
        }
      }
    },
    generateKey: async (_alias, protection) => {
      assert.equal('password' in protection, false)
      calls.push(`generate:${protection.keyProtection}`)
      return {
        status: 'ready',
        privateKeyPath: '/Users/private/.ssh/phi_lab-hpc_ed25519',
        publicKey: 'ssh-ed25519 AAAA-new-key phi@test',
        fingerprint: 'SHA256:new-key'
      }
    },
    installKey: async () => assert.fail('the verified session must install the key'),
    loadKey: async (_platform, _path, passphrase) => {
      calls.push(`load:${passphrase}`)
      return { status: 'ready' }
    },
    verifyKey: async () => ({ status: 'ready' }),
    saveHost: async (input) => input.alias
  })

  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return
  await coordinator.verifyPassword(inspected.attemptId, { password: 'one-use-secret' })
  const protection = { keyProtection: 'passphrase' as const, passphrase: 'key-secret' }
  const prepared = await coordinator.completeWithKeyProtection(inspected.attemptId, protection)

  assert.equal(prepared.status, 'config-preview')
  assert.equal(protection.passphrase, '')
  assert.deepEqual(calls, [
    'authenticate:one-use-secret',
    'generate:passphrase',
    'install-public-key',
    'close-password-session',
    'load:key-secret'
  ])
})

test('verified bootstrap returns a private-path-safe preview and writes config only after consent', async () => {
  const ids = ['attempt-1', 'operation-1']
  const saved: unknown[] = []
  const calls: string[] = []
  const coordinator = createSshBootstrapCoordinator({
    createId: () => ids.shift() ?? 'unexpected-id',
    preflight: async () => ({
      status: 'ready',
      platform: 'darwin',
      openSshVersion: '10.3',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({
        status: 'ready',
        fingerprints: [{ algorithm: 'ssh-ed25519', sha256: 'SHA256:host-key' }]
      }),
      confirmHostKey: async () => assert.fail('known host must not require confirmation')
    },
    authenticate: async (_target, password) => {
      calls.push(`authenticate:${password}`)
      return {
        status: 'ready',
        session: {
          installPublicKey: async (publicKey: string) => {
            calls.push(`install-session:${publicKey}`)
            return { status: 'ready' as const }
          },
          close: async () => {
            calls.push('close-password-session')
          }
        }
      }
    },
    generateKey: async (_alias, credentials) => {
      calls.push(`generate:${credentials.keyProtection}`)
      return {
        status: 'ready',
        privateKeyPath: '/Users/private-user/.ssh/phi_lab-hpc_ed25519',
        publicKey: 'ssh-ed25519 AAAA-new-key phi@test',
        fingerprint: 'SHA256:new-key'
      }
    },
    installKey: async () => assert.fail('the authenticated password session must be reused'),
    loadKey: async (platform, _path, passphrase) => {
      calls.push(`load:${platform}:${passphrase}`)
      return { status: 'ready' }
    },
    verifyKey: async (_target, _path, fingerprint) => {
      calls.push(`verify:${fingerprint}`)
      return { status: 'ready' }
    },
    saveHost: async (input) => {
      saved.push(input)
      return input.alias
    }
  })

  assert.deepEqual(await coordinator.inspectTarget(TARGET), {
    status: 'ready',
    attemptId: 'attempt-1',
    agentState: 'ready'
  })
  const prepared = await coordinator.completeWithCredentials('attempt-1', {
    password: 'server-secret',
    keyProtection: 'passphrase',
    passphrase: 'key-secret'
  })
  assert.equal(prepared.status, 'config-preview')
  if (prepared.status !== 'config-preview') return
  assert.equal(prepared.operationId, 'operation-1')
  assert.equal(prepared.keyFingerprint, 'SHA256:new-key')
  assert.equal(prepared.keyDisplayPath, '~/.ssh/phi_lab-hpc_ed25519')
  assert.match(prepared.preview, /IdentityFile "~\/\.ssh\/phi_lab-hpc_ed25519"/)
  assert.match(prepared.preview, /IdentitiesOnly yes/)
  assert.match(prepared.preview, /AddKeysToAgent yes/)
  assert.match(prepared.preview, /IgnoreUnknown UseKeychain/)
  assert.match(prepared.preview, /UseKeychain yes/)
  assert.doesNotMatch(prepared.preview, /Users\/private-user/)
  assert.deepEqual(saved, [])

  assert.deepEqual(await coordinator.saveConfig('operation-1'), {
    configured: true,
    keyFingerprint: 'SHA256:new-key',
    keyDisplayPath: '~/.ssh/phi_lab-hpc_ed25519'
  })
  assert.deepEqual(saved, [
    {
      alias: 'lab-hpc',
      hostname: 'compute.example.invalid',
      user: 'scientist',
      port: 22,
      identityFile: '~/.ssh/phi_lab-hpc_ed25519',
      identitiesOnly: true,
      addKeysToAgent: true,
      useKeychain: true
    }
  ])
  assert.deepEqual(calls, [
    'authenticate:server-secret',
    'generate:passphrase',
    'install-session:ssh-ed25519 AAAA-new-key phi@test',
    'close-password-session',
    'load:darwin:key-secret',
    'verify:SHA256:new-key'
  ])
})

test('declining config leaves the config writer untouched and returns a manual snippet', async () => {
  const saved: unknown[] = []
  let id = 0
  const coordinator = createSshBootstrapCoordinator({
    createId: () => `id-${++id}`,
    preflight: async () => ({
      status: 'ready',
      platform: 'linux',
      openSshVersion: '9.9',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({ status: 'ready', fingerprints: [] }),
      confirmHostKey: async () => assert.fail('not used')
    },
    authenticate: async () => ({ status: 'ready' }),
    generateKey: async () => ({
      status: 'ready',
      privateKeyPath: '/home/private-user/.ssh/phi_lab-hpc_ed25519',
      publicKey: 'ssh-ed25519 AAAA-new-key phi@test',
      fingerprint: 'SHA256:new-key'
    }),
    installKey: async () => ({ status: 'ready' }),
    loadKey: async () => ({ status: 'ready' }),
    verifyKey: async () => ({ status: 'ready' }),
    saveHost: async (input) => {
      saved.push(input)
      return input.alias
    }
  })

  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return
  const prepared = await coordinator.completeWithCredentials(inspected.attemptId, {
    password: 'server-secret',
    keyProtection: 'passphrase',
    passphrase: 'key-secret'
  })
  assert.equal(prepared.status, 'config-preview')
  if (prepared.status !== 'config-preview') return

  const result = await coordinator.declineConfig(prepared.operationId)
  assert.equal(result.configured, false)
  assert.match(result.manualConfig ?? '', /Host lab-hpc/)
  assert.match(result.manualConfig ?? '', /IdentitiesOnly yes/)
  assert.doesNotMatch(result.manualConfig ?? '', /AddKeysToAgent|UseKeychain|home\/private-user/)
  assert.deepEqual(saved, [])
})

test('Linux without ssh-agent stops before password use unless passwordless is explicit', async () => {
  let authentications = 0
  const coordinator = createSshBootstrapCoordinator({
    createId: () => 'attempt-linux',
    preflight: async () => ({
      status: 'ready',
      platform: 'linux',
      openSshVersion: '9.9',
      agentState: 'missing-linux'
    }),
    hostKeys: {
      inspectTarget: async () => ({ status: 'ready', fingerprints: [] }),
      confirmHostKey: async () => assert.fail('not used')
    },
    authenticate: async () => {
      authentications += 1
      return { status: 'ready' }
    },
    generateKey: async () => assert.fail('not used'),
    installKey: async () => assert.fail('not used'),
    loadKey: async () => assert.fail('not used'),
    verifyKey: async () => assert.fail('not used'),
    saveHost: async () => assert.fail('not used')
  })

  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return
  const credentials = {
    password: 'server-secret',
    keyProtection: 'passphrase' as const,
    passphrase: 'key-secret'
  }
  assert.deepEqual(await coordinator.completeWithCredentials(inspected.attemptId, credentials), {
    status: 'failed',
    errorCode: 'linux_agent_missing',
    retryable: true
  })
  assert.equal(authentications, 0)
  assert.equal(credentials.password, '')
  assert.equal(credentials.passphrase, '')
})

test('one attempt permits only one credential operation in flight', async () => {
  let releaseAuthentication!: () => void
  const authenticationGate = new Promise<void>((resolve) => {
    releaseAuthentication = resolve
  })
  let authentications = 0
  let id = 0
  const coordinator = createSshBootstrapCoordinator({
    createId: () => `operation-${++id}`,
    preflight: async () => ({
      status: 'ready',
      platform: 'linux',
      openSshVersion: '9.9',
      agentState: 'ready'
    }),
    hostKeys: {
      inspectTarget: async () => ({ status: 'ready', fingerprints: [] }),
      confirmHostKey: async () => assert.fail('not used')
    },
    authenticate: async () => {
      authentications += 1
      await authenticationGate
      return { status: 'ready' }
    },
    generateKey: async () => ({
      status: 'ready',
      privateKeyPath: '/home/private/.ssh/phi_lab-hpc_ed25519',
      publicKey: 'ssh-ed25519 AAAA-new-key phi@test',
      fingerprint: 'SHA256:new-key'
    }),
    installKey: async () => ({ status: 'ready' }),
    loadKey: async () => ({ status: 'ready' }),
    verifyKey: async () => ({ status: 'ready' }),
    saveHost: async (input) => input.alias
  })
  const inspected = await coordinator.inspectTarget(TARGET)
  assert.equal(inspected.status, 'ready')
  if (inspected.status !== 'ready') return

  const first = coordinator.completeWithCredentials(inspected.attemptId, {
    password: 'first-password',
    keyProtection: 'passphrase',
    passphrase: 'first-passphrase'
  })
  await new Promise((resolve) => setImmediate(resolve))
  const duplicatePromise = coordinator.completeWithCredentials(inspected.attemptId, {
    password: 'duplicate-password',
    keyProtection: 'passphrase',
    passphrase: 'duplicate-passphrase'
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(authentications, 1)
  } finally {
    releaseAuthentication()
  }
  const duplicate = await duplicatePromise
  assert.deepEqual(duplicate, { status: 'failed', errorCode: 'unexpected', retryable: false })
  assert.equal((await first).status, 'config-preview')
})
