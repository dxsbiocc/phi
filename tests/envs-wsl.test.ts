import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  decodeWslOutput,
  parseWslList,
  prepareEnvironmentCommand,
  probeWsl,
  readWslRuntime,
  resolveManagedLockPlatform,
  toLinuxPath,
  toWindowsPath,
  usesWslEnvironment,
  wslRequiredMessage,
  wslEnvironmentPrefix,
  wslSpawnArgv,
  type EnvHandle
} from '../src/main/agent/envs'
import { spawnWslProcess } from '../src/main/agent/envs/wsl-process'

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
  assert.equal(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\phi'), '/home/phi')
  assert.throws(() => toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\phi', 'Debian'), /Ubuntu/)
  assert.throws(() => toLinuxPath('\\\\fileserver\\share\\data', 'Ubuntu'), /cannot access/)
  assert.equal(toWindowsPath('/mnt/c/Users/phi/project'), 'C:\\Users\\phi\\project')
  assert.equal(toWindowsPath('/mnt/c'), 'C:\\')
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

test('WSL selection preserves an explicit distribution and skips a default WSL1 instance', () => {
  const options = {
    platform: 'win32' as const,
    executable: process.execPath,
    exec: () => '* Debian     Stopped  1\n  Research Linux     Running  2\n  Ubuntu     Stopped  2'
  }
  assert.deepEqual(probeWsl(options), {
    status: 'ready',
    executable: process.execPath,
    distro: 'Research Linux'
  })
  assert.deepEqual(probeWsl({ ...options, distro: 'Ubuntu' }), {
    status: 'ready',
    executable: process.execPath,
    distro: 'Ubuntu'
  })
  assert.equal(probeWsl({ ...options, distro: 'Removed' }).status, 'distro-unavailable')
  assert.equal(probeWsl({ ...options, distro: 'Debian' }).status, 'not-version-2')
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
  assert.deepEqual(plan.args.slice(4, 8), ['--exec', '/usr/bin/env', '-i', '--'])
  assert.ok(
    plan.args.some(
      (arg) => arg.startsWith('PATH=') && arg.includes('/mnt/c/Users/phi/.phi/runtime')
    )
  )
  assert.ok(plan.args.includes('/home/phi/.phi/runtime/bin/python'))
})

test('WSL plans use the persisted Linux prefix, isolated PATH and argument conversion', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wsl-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'state'))
  writeFileSync(
    join(root, 'state', 'wsl-runtime.json'),
    JSON.stringify({ distro: 'Research Linux', home: '/home/phi' })
  )
  const wsl = readWslRuntime(root)!
  const envId = 'phi-python-0123456789ab'
  const prefix = wslEnvironmentPrefix(wsl, envId)
  const linuxPrefix = `${wsl.linuxRoot}/envs/${envId}`
  const env: EnvHandle = {
    envId,
    prefix,
    wsl,
    metadata: {
      envId,
      name: 'phi-python',
      kind: 'base',
      platform: 'linux-x64',
      lockSha256: '0'.repeat(64),
      createdAt: new Date(0).toISOString(),
      micromambaVersion: '2.9.0',
      sourcePackages: [],
      status: 'ready',
      contractVersion: '1.5.0',
      activation: {
        set: { CONDA_PREFIX: linuxPrefix },
        pathPrepend: [`${linuxPrefix}/bin`, '/outside/bin']
      },
      host: { docker: 'C:\\host\\docker.exe' }
    }
  }
  const plan = prepareEnvironmentCommand(
    env,
    ['python', '--data=\\\\wsl.localhost\\Research Linux\\home\\phi\\生物 数据\\in.csv', 'plain'],
    {
      hostPlatform: 'win32',
      baseEnv: { HOME: 'C:\\wrong', WSLENV: 'SECRET/u' }
    }
  )
  assert.match(wsl.linuxRoot, /^\/home\/phi\/\.phi\/runtime\/desktop\/[0-9a-f]{16}$/)
  assert.equal(plan.runtime, 'wsl2')
  assert.equal(plan.wsl?.distro, 'Research Linux')
  assert.equal(plan.linuxEnv?.HOME, '/home/phi')
  assert.equal(plan.linuxEnv?.PATH, `${linuxPrefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
  assert.equal(plan.linuxEnv?.PHI_ENV_PREFIX, linuxPrefix)
  assert.equal(plan.linuxEnv?.WSLENV, undefined)
  assert.deepEqual(plan.args.slice(-3), ['python', '--data=/home/phi/生物 数据/in.csv', 'plain'])
})

test(
  'WSL cancellation escalates against an owned Linux process group',
  {
    skip: process.platform !== 'linux',
    timeout: 15_000
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'phi-wsl-group-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'processes'))
    const executable = join(root, 'fake-wsl')
    writeFileSync(executable, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 })
    const ready = { status: 'ready', distro: 'Ubuntu', executable } as const
    const runtime = { ready, linuxRoot: root, linuxHome: root, linuxMicromamba: '' }
    const plan = wslSpawnArgv(
      ready,
      '/bin/sh',
      ['-c', 'trap "" TERM; /bin/sleep 60 & printf "%s\\n" "$!"; wait'],
      { env: { PATH: '/usr/bin:/bin' } }
    )
    const controlled = spawnWslProcess(runtime, plan, { stdio: 'pipe' })
    t.after(() => {
      controlled.signal('SIGKILL')
    })
    const close = once(controlled.child, 'close')
    const [output] = await once(controlled.child.stdout!, 'data')
    const workerPid = Number(String(output).trim())
    assert.ok(workerPid > 1)
    controlled.signal('SIGTERM')
    await delay(200)
    assert.equal(controlled.child.exitCode, null)
    controlled.signal('SIGKILL')
    const [code] = await close
    assert.notEqual(code, 0)
    try {
      assert.match(readFileSync(`/proc/${workerPid}/stat`, 'utf8'), /^\d+ \([^)]*\) Z /u)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
)
