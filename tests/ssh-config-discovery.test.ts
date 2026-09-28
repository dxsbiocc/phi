import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverOpenSshAliases, listOpenSshHosts } from '../src/main/agent/ssh-config-discovery'

test('discovers explicit OpenSSH aliases and included files without listing wildcard rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-ssh-discovery-'))
  try {
    mkdirSync(join(dir, 'config.d'))
    const config = join(dir, 'config')
    const key = join(dir, 'test-key')
    writeFileSync(key, 'test fixture')
    writeFileSync(
      config,
      [
        'Include config.d/*.conf',
        'Host lab-hpc gpu',
        '  HostName compute.example.invalid',
        '  User scientist',
        '  Port 22022',
        `  IdentityFile ${key}`,
        'Host *',
        '  ServerAliveInterval 10',
        ''
      ].join('\n')
    )
    writeFileSync(
      join(dir, 'config.d', 'extra.conf'),
      'Host jump\n  HostName jump.example.invalid\n'
    )
    assert.deepEqual(discoverOpenSshAliases(config), ['jump', 'lab-hpc', 'gpu'])
    const hosts = await listOpenSshHosts(config)
    assert.deepEqual(
      hosts.map((host) => host.alias),
      ['jump', 'lab-hpc', 'gpu']
    )
    assert.equal(hosts[1].hostname, 'compute.example.invalid')
    assert.equal(hosts[1].user, 'scientist')
    assert.equal(hosts[1].port, 22022)
    assert.deepEqual(hosts[1].identityFiles, [key])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
