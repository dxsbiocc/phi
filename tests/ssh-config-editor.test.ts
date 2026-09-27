import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { saveOpenSshHost, updatedOpenSshConfig } from '../src/main/agent/ssh-config-editor'

function withConfig<T>(run: (directory: string, path: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'phi-ssh-config-editor-'))
  const path = join(directory, 'config')
  return run(directory, path).finally(() => rmSync(directory, { recursive: true, force: true }))
}

test('adding a server writes one OpenSSH Host block and preserves the existing config', async () => {
  await withConfig(async (directory, path) => {
    const original =
      '# user comment\nHost existing\n  HostName old.example.invalid\n  ProxyJump gateway\n'
    writeFileSync(path, original, { mode: 0o600 })
    const key = join(directory, 'key with space')
    const alias = await saveOpenSshHost(
      {
        alias: 'lab-hpc',
        hostname: 'compute.example.invalid',
        user: 'scientist',
        port: 22022,
        identityFile: key
      },
      path
    )
    assert.equal(alias, 'lab-hpc')
    const saved = readFileSync(path, 'utf8')
    assert.match(saved, /^# user comment\n\nHost lab-hpc\n/m)
    assert.match(saved, /IdentityFile "[^"]*key with space"/)
    assert.match(saved, /Host existing\n {2}HostName old\.example\.invalid\n {2}ProxyJump gateway/)
    assert.equal(lstatSync(path).mode & 0o777, 0o600)
    assert.equal(readdirSync(directory).filter((name) => name.includes('phi-backup')).length, 1)
    assert.equal(existsSync(join(directory, 'ssh-hosts.json')), false)
  })
})

test('editing a simple Host block keeps unrelated directives and refuses alias renaming', async () => {
  await withConfig(async (_, path) => {
    writeFileSync(
      path,
      'Host lab-hpc\n  HostName old.example.invalid\n  User old\n  ProxyJump gateway\n\nHost other\n  HostName other.example.invalid\n'
    )
    await saveOpenSshHost(
      {
        originalAlias: 'lab-hpc',
        alias: 'lab-hpc',
        hostname: 'new.example.invalid',
        user: 'scientist',
        port: 22022
      },
      path
    )
    const saved = readFileSync(path, 'utf8')
    assert.match(
      saved,
      /Host lab-hpc\n {2}HostName new\.example\.invalid\n {2}User scientist\n {2}Port 22022/
    )
    assert.match(saved, /ProxyJump gateway/)
    assert.match(saved, /Host other\n {2}HostName other\.example\.invalid/)
    await assert.rejects(
      saveOpenSshHost(
        { originalAlias: 'lab-hpc', alias: 'renamed', hostname: 'new.example.invalid' },
        path
      ),
      /不能直接改名/
    )
  })
})

test('duplicate and shared or included Host entries remain untouched', async () => {
  await withConfig(async (directory, path) => {
    const source = 'Include extras.conf\nHost lab-hpc sibling\n  HostName compute.example.invalid\n'
    writeFileSync(path, source)
    writeFileSync(
      join(directory, 'extras.conf'),
      'Host included\n  HostName included.example.invalid\n'
    )
    await assert.rejects(
      saveOpenSshHost({ alias: 'lab-hpc', hostname: 'new.example.invalid' }, path),
      /已存在/
    )
    await assert.rejects(
      saveOpenSshHost(
        { originalAlias: 'lab-hpc', alias: 'lab-hpc', hostname: 'new.example.invalid' },
        path
      ),
      /共享 Host 规则/
    )
    assert.equal(readFileSync(path, 'utf8'), source)
    assert.equal(readdirSync(directory).filter((name) => name.includes('phi-backup')).length, 0)
  })
})

test('global first-value settings cannot silently override a newly added server', async () => {
  await withConfig(async (_, path) => {
    const source = 'User global-user\nHost *\n  ServerAliveInterval 10\n'
    writeFileSync(path, source)
    await assert.rejects(
      saveOpenSshHost(
        { alias: 'lab-hpc', hostname: 'compute.example.invalid', user: 'scientist' },
        path
      ),
      /覆盖了用户名/
    )
    assert.equal(readFileSync(path, 'utf8'), source)
  })
})

test('invalid values and symlink config never become active SSH directives', async () => {
  await withConfig(async (directory, path) => {
    assert.throws(
      () => updatedOpenSshConfig('', { alias: 'lab', hostname: 'server\nProxyCommand bad' }, []),
      /服务器地址/
    )
    const real = join(directory, 'real-config')
    writeFileSync(real, 'Host lab\n  HostName original.example.invalid\n')
    symlinkSync(real, path)
    await assert.rejects(
      saveOpenSshHost({ alias: 'new-host', hostname: 'new.example.invalid' }, path),
      /不是普通文件/
    )
    assert.equal(readFileSync(real, 'utf8'), 'Host lab\n  HostName original.example.invalid\n')
  })
})
