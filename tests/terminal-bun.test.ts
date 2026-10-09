import assert from 'node:assert/strict'
import test from 'node:test'

import { BunExecutableNotFoundError, resolveBunExecutable } from '../src/main/terminal/terminal-bun'

function executableSet(paths: readonly string[]): {
  exists(path: string): boolean
  checked: string[]
} {
  const checked: string[] = []
  const available = new Set(paths)
  return {
    checked,
    exists: (path) => {
      checked.push(path)
      return available.has(path)
    }
  }
}

test('resolves executable Bun candidates in packaged-app priority order', () => {
  const files = executableSet([
    '/explicit/bun',
    '/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64/bun',
    '/bun-install/bin/bun',
    '/Users/tester/.bun/bin/bun',
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/custom/bin/bun'
  ])
  assert.equal(
    resolveBunExecutable(
      {
        PHI_BUN_PATH: '/explicit/bun',
        BUN_INSTALL: '/bun-install',
        HOME: '/Users/tester',
        PATH: '/custom/bin:/usr/bin'
      },
      files.exists,
      {
        resourcesPath: '/Applications/Phi.app/Contents/Resources',
        platform: 'darwin',
        arch: 'arm64',
        homeDir: '/Users/tester',
        readLoginShellPath: () => undefined
      }
    ),
    '/explicit/bun'
  )
  assert.deepEqual(files.checked, ['/explicit/bun'])
})

test('prefers packaged bun over PATH for terminal workers', () => {
  const files = executableSet([
    '/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64/bun',
    '/custom/bin/bun'
  ])

  assert.equal(
    resolveBunExecutable({ PATH: '/custom/bin' }, files.exists, {
      resourcesPath: '/Applications/Phi.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
      homeDir: '/Users/tester',
      readLoginShellPath: () => undefined
    }),
    '/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64/bun'
  )
})

test('falls through unavailable packaged and known Bun candidates to PATH', () => {
  const files = executableSet(['/custom/bin/bun'])
  assert.equal(
    resolveBunExecutable(
      {
        BUN_INSTALL: '/missing-install',
        HOME: '/missing-home',
        PATH: 'relative-bin:/custom/bin:/other/bin'
      },
      files.exists,
      {
        resourcesPath: '/Applications/Phi.app/Contents/Resources',
        platform: 'darwin',
        arch: 'arm64',
        homeDir: '/missing-home',
        readLoginShellPath: () => undefined
      }
    ),
    '/custom/bin/bun'
  )
  assert.deepEqual(files.checked, [
    '/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64/bun',
    'relative-bin/bun',
    '/custom/bin/bun'
  ])
})

test('does not silently replace an invalid explicit Bun override', () => {
  assert.throws(
    () =>
      resolveBunExecutable(
        { PHI_BUN_PATH: '/missing/explicit/bun', PATH: '/custom/bin' },
        (path) => path === '/custom/bin/bun'
      ),
    BunExecutableNotFoundError
  )
})

test('uses BUN_INSTALL and HOME before system locations', () => {
  assert.equal(
    resolveBunExecutable(
      { BUN_INSTALL: '/bun-install', HOME: '/Users/tester' },
      (path) => path === '/bun-install/bin/bun'
    ),
    '/bun-install/bin/bun'
  )
  assert.equal(
    resolveBunExecutable(
      { HOME: '/Users/tester' },
      (path) => path === '/Users/tester/.bun/bin/bun'
    ),
    '/Users/tester/.bun/bin/bun'
  )
})

test('falls back to the login shell when packaged, PATH, and known Bun locations are unavailable', () => {
  const files = executableSet(['/Users/tester/.mise/bin/bun'])
  assert.equal(
    resolveBunExecutable({ HOME: '/Users/tester', PATH: '/usr/bin:/bin' }, files.exists, {
      resourcesPath: '/Applications/Phi.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
      readLoginShellPath: () => '/Users/tester/.mise/bin:/usr/bin:/bin'
    }),
    '/Users/tester/.mise/bin/bun'
  )
})

test('throws a typed error when no executable Bun exists', () => {
  assert.throws(
    () => resolveBunExecutable({ HOME: '/missing', PATH: '/usr/bin:/bin' }, () => false),
    BunExecutableNotFoundError
  )
})
