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
      files.exists
    ),
    '/explicit/bun'
  )
  assert.deepEqual(files.checked, ['/explicit/bun'])
})

test('falls through invalid and unavailable Bun candidates to PATH', () => {
  const files = executableSet(['/custom/bin/bun'])
  assert.equal(
    resolveBunExecutable(
      {
        PHI_BUN_PATH: 'relative/bun',
        BUN_INSTALL: '/missing-install',
        HOME: '/missing-home',
        PATH: 'relative-bin:/custom/bin:/other/bin'
      },
      files.exists
    ),
    '/custom/bin/bun'
  )
  assert.deepEqual(files.checked, [
    '/missing-install/bin/bun',
    '/missing-home/.bun/bin/bun',
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/custom/bin/bun'
  ])
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

test('throws a typed error when no executable Bun exists', () => {
  assert.throws(
    () => resolveBunExecutable({ HOME: '/missing', PATH: '/usr/bin:/bin' }, () => false),
    BunExecutableNotFoundError
  )
})
