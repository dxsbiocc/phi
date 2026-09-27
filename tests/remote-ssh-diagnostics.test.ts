import assert from 'node:assert/strict'
import test from 'node:test'

import {
  diagnoseSshConnectionFailure,
  RemoteSshConnectionError
} from '../src/main/agent/wrappers/remote-ssh-diagnostics'

test('OpenSSH identity, authentication, proxy, executable, and network failures have stable codes', () => {
  const cases = [
    [
      'host_key_changed',
      'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ED25519 key in /home/user/.ssh/known_hosts:5'
    ],
    [
      'host_key_unknown',
      'No ED25519 host key is known for lab and you have requested strict checking.\nHost key verification failed.'
    ],
    ['host_key_unverified', 'Host key verification failed.'],
    ['authentication_failed', 'Permission denied (publickey,password).'],
    ['proxy_unreachable', 'stdio forwarding failed\nConnection closed by UNKNOWN port 65535'],
    ['configuration_invalid', 'Bad configuration option: ProxyJumpp'],
    ['network_unreachable', 'ssh: connect to host lab port 22: No route to host'],
    ['timeout', 'ssh: connect to host lab port 22: Operation timed out']
  ] as const
  for (const [expected, output] of cases) {
    assert.equal(diagnoseSshConnectionFailure(output).code, expected)
  }
  const missing = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
  assert.equal(diagnoseSshConnectionFailure(missing).code, 'ssh_missing')
})

test('connection diagnosis never includes raw stderr, private key paths, or passwords', () => {
  const privatePath = '/Users/alice/.ssh/super-secret-key'
  const password = 'hunter2'
  const diagnosis = diagnoseSshConnectionFailure(
    `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Offending key in ${privatePath} ${password}`
  )
  const error = new RemoteSshConnectionError(diagnosis)
  assert.equal(error.code, 'host_key_changed')
  assert.equal(error.message.includes(privatePath), false)
  assert.equal(error.message.includes(password), false)
  assert.equal(error.message.includes('REMOTE HOST'), false)
})
