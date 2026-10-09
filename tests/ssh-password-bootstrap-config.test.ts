import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { saveOpenSshHost, updatedOpenSshConfig } from '../src/main/agent/ssh-config-editor'

test('password bootstrap host config adds verified-key directives and preserves unrelated content', () => {
  const source = [
    '# keep this comment',
    'Host existing',
    '  HostName existing.example.invalid',
    '  ProxyJump gateway',
    ''
  ].join('\n')

  const updated = updatedOpenSshConfig(
    source,
    {
      alias: 'lab-hpc',
      hostname: 'compute.example.invalid',
      user: 'scientist',
      port: 22022,
      identityFile: '/home/scientist/.ssh/phi_lab-hpc_ed25519',
      identitiesOnly: true,
      addKeysToAgent: true,
      useKeychain: true
    },
    ['existing']
  )

  assert.match(
    updated,
    /Host lab-hpc\n {2}HostName compute\.example\.invalid\n {2}User scientist\n {2}Port 22022\n {2}IdentityFile "\/home\/scientist\/\.ssh\/phi_lab-hpc_ed25519"\n {2}IdentitiesOnly yes\n {2}AddKeysToAgent yes\n {2}IgnoreUnknown UseKeychain\n {2}UseKeychain yes/
  )
  assert.match(updated, /# keep this comment/)
  assert.match(
    updated,
    /Host existing\n {2}HostName existing\.example\.invalid\n {2}ProxyJump gateway/
  )
})

test('bootstrap config is not written when an earlier rule overrides IdentitiesOnly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phi-ssh-bootstrap-config-'))
  const configPath = join(directory, 'config')
  const original = 'IdentitiesOnly no\nHost *\n  ServerAliveInterval 15\n'
  writeFileSync(configPath, original, { mode: 0o600 })
  try {
    await assert.rejects(
      saveOpenSshHost(
        {
          alias: 'lab-hpc',
          hostname: 'compute.example.invalid',
          user: 'scientist',
          identityFile: join(directory, 'phi_lab-hpc_ed25519'),
          identitiesOnly: true
        },
        configPath
      ),
      /IdentitiesOnly/
    )
    assert.equal(readFileSync(configPath, 'utf8'), original)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a home-relative bootstrap identity stays private in the previewed Host block', () => {
  const updated = updatedOpenSshConfig(
    '',
    {
      alias: 'lab-hpc',
      hostname: 'compute.example.invalid',
      user: 'scientist',
      identityFile: '~/.ssh/phi_lab-hpc_ed25519',
      identitiesOnly: true
    },
    []
  )

  assert.match(updated, /IdentityFile "~\/\.ssh\/phi_lab-hpc_ed25519"/)
  assert.doesNotMatch(updated, /\/Users\/|\/home\//)
})
