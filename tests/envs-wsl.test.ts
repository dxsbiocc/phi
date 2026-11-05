import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeWslOutput,
  parseWslList,
  probeWsl,
  resolveManagedLockPlatform,
  toLinuxPath,
  toWindowsPath,
  usesWslEnvironment,
  wslRequiredMessage,
  wslSpawnArgv
} from '../src/main/agent/envs'

const LIST = `
  NAME            STATE           VERSION
* Ubuntu          Running         2
  Debian          Stopped         1
`

test('WSL list parsing accepts UTF-16LE wsl.exe output', () => {
  const utf16 = Buffer.from(`\uFEFF${LIST}`, 'utf16le')
  const entries = parseWslList(utf16)
  assert.deepEqual(
    entries.map((entry) => ({
      distro: entry.distro,
      version: entry.version,
      default: entry.default
    })),
    [
      { distro: 'Ubuntu', version: 2, default: true },
      { distro: 'Debian', version: 1, default: false }
    ]
  )
  assert.match(decodeWslOutput(utf16), /Ubuntu/)
})

test('Windows paths map into /mnt drive letters and back', () => {
  assert.equal(toLinuxPath('C:\\Users\\phi\\project'), '/mnt/c/Users/phi/project')
  assert.equal(toLinuxPath('D:/data/run'), '/mnt/d/data/run')
  assert.equal(toLinuxPath('\\\\wsl$\\Ubuntu\\home\\phi\\.phi\\runtime'), '/home/phi/.phi/runtime')
  assert.equal(toWindowsPath('/mnt/c/Users/phi/project'), 'C:\\Users\\phi\\project')
})

test('Windows without a native lock falls back to the linux-x64 WSL lock', () => {
  const available = new Set(['linux-x64', 'darwin-arm64'])
  assert.deepEqual(
    resolveManagedLockPlatform('win32-x64', (platform) => available.has(platform)),
    { platform: 'linux-x64', runtime: 'wsl2' }
  )
  assert.deepEqual(
    resolveManagedLockPlatform('win32-x64', (platform) => platform === 'win32-x64'),
    { platform: 'win32-x64', runtime: 'native' }
  )
  assert.equal(
    resolveManagedLockPlatform('win32-x64', () => false),
    undefined
  )
  assert.equal(usesWslEnvironment('win32', 'linux-x64'), true)
  assert.equal(usesWslEnvironment('win32', 'win32-x64'), false)
})

test('probeWsl reports a ready default distro and a missing install', () => {
  const ready = probeWsl({
    platform: 'win32',
    executable: process.execPath,
    exec: () => LIST
  })
  assert.deepEqual(ready, {
    status: 'ready',
    executable: process.execPath,
    distro: 'Ubuntu'
  })
  assert.equal(probeWsl({ platform: 'win32', executable: '/missing/wsl.exe' }).status, 'missing')
  assert.equal(probeWsl({ platform: 'darwin' }).status, 'unsupported')
  assert.match(wslRequiredMessage({ status: 'missing' }), /wsl --install/)
})

test('wslSpawnArgv prefixes env and converts the Windows cwd', () => {
  const plan = wslSpawnArgv(
    { status: 'ready', executable: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu' },
    '/home/phi/.phi/runtime/bin/python',
    ['-c', 'print(1)'],
    {
      cwd: 'C:\\Users\\phi\\project',
      env: { PATH: 'C:\\Users\\phi\\.phi\\runtime\\envs\\id\\bin;C:\\Windows\\System32' }
    }
  )
  assert.equal(plan.executable, 'C:\\Windows\\System32\\wsl.exe')
  assert.equal(plan.args[0], '-d')
  assert.equal(plan.args[1], 'Ubuntu')
  assert.equal(plan.args[2], '--cd')
  assert.equal(plan.args[3], '/mnt/c/Users/phi/project')
  assert.ok(plan.args.includes('env'))
  assert.ok(
    plan.args.some(
      (arg) => arg.startsWith('PATH=') && arg.includes('/mnt/c/Users/phi/.phi/runtime')
    )
  )
  assert.ok(plan.args.includes('/home/phi/.phi/runtime/bin/python'))
})
