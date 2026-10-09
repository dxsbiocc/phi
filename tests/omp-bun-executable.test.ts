import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import {
  BUN_PATH_ENV,
  findBunExecutable,
  readLoginShellPath,
  resolveBunExecutable,
  workerPathWithBun
} from '../src/main/agent/omp/bun-executable'

// Finder/Dock launches inherit launchd's PATH, which never contains bun.
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'phi-bun-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function fakeBun(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'bun')
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
  return file
}

const noLoginShell = (): undefined => undefined

test('finds bun in ~/.bun/bin when launched from Finder', () => {
  withTempDir((home) => {
    const bun = fakeBun(join(home, '.bun', 'bin'))
    assert.equal(
      findBunExecutable({
        env: { PATH: FINDER_PATH },
        homeDir: home,
        platform: 'darwin',
        readLoginShellPath: noLoginShell
      }),
      bun
    )
  })
})

test('prefers packaged bun over the inherited PATH', () => {
  withTempDir((root) => {
    const resourcesPath = join(root, 'Phi.app', 'Contents', 'Resources')
    const bundled = fakeBun(join(resourcesPath, 'runtime', 'bun', 'darwin-arm64'))
    fakeBun(join(root, 'path-bin'))

    assert.equal(
      findBunExecutable({
        env: { PATH: join(root, 'path-bin') },
        homeDir: join(root, 'home'),
        platform: 'darwin',
        arch: 'arm64',
        resourcesPath,
        readLoginShellPath: noLoginShell
      }),
      bundled
    )
  })
})

test('resolves the packaged Linux x64 Bun from the platform-specific resource path', () => {
  withTempDir((root) => {
    const resourcesPath = join(root, 'resources')
    const bundled = fakeBun(join(resourcesPath, 'runtime', 'bun', 'linux-x64'))

    assert.equal(
      findBunExecutable({
        env: { PATH: FINDER_PATH },
        homeDir: join(root, 'home'),
        platform: 'linux',
        arch: 'x64',
        resourcesPath,
        readLoginShellPath: noLoginShell
      }),
      bundled
    )
  })
})

test('falls back from a non-executable packaged bun to PATH', () => {
  withTempDir((root) => {
    const resourcesPath = join(root, 'Phi.app', 'Contents', 'Resources')
    const bundled = fakeBun(join(resourcesPath, 'runtime', 'bun', 'darwin-arm64'))
    chmodSync(bundled, 0o644)
    const onPath = fakeBun(join(root, 'path-bin'))

    assert.equal(
      findBunExecutable({
        env: { PATH: join(root, 'path-bin') },
        homeDir: join(root, 'home'),
        platform: 'darwin',
        arch: 'arm64',
        resourcesPath,
        readLoginShellPath: noLoginShell
      }),
      onPath
    )
  })
})

test('reports a packaged bun that exists but is not executable when no fallback exists', () => {
  withTempDir((root) => {
    const resourcesPath = join(root, 'Phi.app', 'Contents', 'Resources')
    const bundled = fakeBun(join(resourcesPath, 'runtime', 'bun', 'darwin-arm64'))
    chmodSync(bundled, 0o644)

    assert.throws(
      () =>
        resolveBunExecutable({
          env: { PATH: '' },
          homeDir: join(root, 'home'),
          platform: 'darwin',
          arch: 'arm64',
          resourcesPath,
          isExecutableFile: () => false,
          readLoginShellPath: noLoginShell
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /内置 bun 不可执行/u)
        assert.match(error.message, new RegExp(bundled.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
        return true
      }
    )
  })
})

test('honours BUN_INSTALL and prefers the inherited PATH', () => {
  withTempDir((root) => {
    const installed = fakeBun(join(root, 'custom', 'bin'))
    const onPath = fakeBun(join(root, 'path-bin'))
    const base = {
      homeDir: join(root, 'home'),
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      resourcesPath: join(root, 'missing-resources'),
      readLoginShellPath: noLoginShell
    }
    assert.equal(
      findBunExecutable({ ...base, env: { PATH: FINDER_PATH, BUN_INSTALL: join(root, 'custom') } }),
      installed
    )
    assert.equal(
      findBunExecutable({
        ...base,
        env: {
          PATH: [join(root, 'path-bin'), FINDER_PATH].join(delimiter),
          BUN_INSTALL: join(root, 'custom')
        }
      }),
      onPath
    )
  })
})

test('falls back to the login shell PATH for custom installs', () => {
  withTempDir((root) => {
    const bun = fakeBun(join(root, 'mise', 'bin'))
    let shellEnv: NodeJS.ProcessEnv | undefined
    assert.equal(
      findBunExecutable({
        env: { PATH: FINDER_PATH, SHELL: '/bin/zsh' },
        homeDir: join(root, 'home'),
        platform: 'darwin',
        arch: 'arm64',
        resourcesPath: join(root, 'missing-resources'),
        readLoginShellPath: (env) => {
          shellEnv = env
          return [join(root, 'mise', 'bin'), FINDER_PATH].join(delimiter)
        }
      }),
      bun
    )
    assert.equal(shellEnv?.SHELL, '/bin/zsh')
  })
})

test('explicit override wins and is not silently replaced when broken', () => {
  withTempDir((root) => {
    const explicit = fakeBun(join(root, 'explicit'))
    const resourcesPath = join(root, 'Phi.app', 'Contents', 'Resources')
    fakeBun(join(resourcesPath, 'runtime', 'bun', 'darwin-arm64'))
    fakeBun(join(root, 'home', '.bun', 'bin'))
    const base = {
      homeDir: join(root, 'home'),
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      resourcesPath,
      readLoginShellPath: noLoginShell
    }
    assert.equal(
      findBunExecutable({ ...base, env: { PATH: FINDER_PATH, [BUN_PATH_ENV]: explicit } }),
      explicit
    )
    assert.equal(
      findBunExecutable({
        ...base,
        env: { PATH: FINDER_PATH, [BUN_PATH_ENV]: join(root, 'missing') }
      }),
      undefined
    )
  })
})

test('development mode without a resources root keeps PATH resolution unchanged', () => {
  withTempDir((root) => {
    const onPath = fakeBun(join(root, 'path-bin'))
    assert.equal(
      findBunExecutable({
        env: { PATH: join(root, 'path-bin') },
        homeDir: join(root, 'home'),
        platform: 'darwin',
        arch: 'arm64',
        readLoginShellPath: noLoginShell
      }),
      onPath
    )
  })
})

test('returns undefined when bun is nowhere', () => {
  withTempDir((root) => {
    assert.equal(
      findBunExecutable({
        env: { PATH: FINDER_PATH },
        homeDir: root,
        platform: 'darwin',
        readLoginShellPath: noLoginShell
      }),
      undefined
    )
  })
})

test(
  'reads PATH from a login shell despite rc-file output',
  { skip: process.platform === 'win32' },
  () => {
    withTempDir((root) => {
      const shell = join(root, 'noisy-sh')
      // Mimics an rc file that prints a banner before the command runs.
      writeFileSync(
        shell,
        '#!/bin/sh\necho "welcome banner"\nPATH=/from/login/shell exec /bin/sh "$@"\n'
      )
      chmodSync(shell, 0o755)
      // /etc/profile (path_helper on macOS) may prepend system dirs; the banner must not leak in.
      const pathValue = readLoginShellPath({ SHELL: shell, PATH: FINDER_PATH }) ?? ''
      assert.ok(pathValue.split(delimiter).includes('/from/login/shell'), pathValue)
      assert.ok(!pathValue.includes('welcome banner'))
    })
  }
)

test('worker PATH puts bun first without duplicating it', () => {
  assert.equal(
    workerPathWithBun('/Users/me/.bun/bin/bun', `/usr/bin${delimiter}/Users/me/.bun/bin`),
    `/Users/me/.bun/bin${delimiter}/usr/bin`
  )
  assert.equal(workerPathWithBun('/opt/homebrew/bin/bun', undefined), '/opt/homebrew/bin')
})
