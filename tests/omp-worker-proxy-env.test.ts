import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { clearLoginShellEnvCache, readLoginShellEnv } from '../src/main/agent/omp/login-shell-env'
import {
  proxyEnvFromScutil,
  resolveWorkerProxyEnv,
  type WorkerProxyOptions
} from '../src/main/agent/omp/worker-proxy-env'

const SCUTIL_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : intranet.example.org
  }
  HTTPEnable : 1
  HTTPPort : 9981
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 9981
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 9981
  SOCKSProxy : 127.0.0.1
}
`
const SCUTIL_OFF = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}
`
// A Finder/Dock launch: no proxy variables at all.
const FINDER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' }

function options(overrides: Partial<WorkerProxyOptions>): WorkerProxyOptions {
  return {
    platform: 'darwin',
    readSystemProxy: () => SCUTIL_OFF,
    readLoginShell: () => ({}),
    ...overrides
  }
}

test('Finder launch takes the macOS system proxy and never proxies loopback', () => {
  const env = resolveWorkerProxyEnv(FINDER_ENV, options({ readSystemProxy: () => SCUTIL_ON }))
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9981')
  assert.equal(env.https_proxy, 'http://127.0.0.1:9981')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9981')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1,.local,intranet.example.org')
  assert.equal(env.no_proxy, env.NO_PROXY)
})

test('terminal launch keeps the inherited proxy untouched', () => {
  let systemRead = false
  const env = resolveWorkerProxyEnv(
    { ...FINDER_ENV, HTTPS_PROXY: 'http://corp:8080' },
    options({
      readSystemProxy: () => {
        systemRead = true
        return SCUTIL_ON
      }
    })
  )
  assert.deepEqual(env, {})
  assert.equal(systemRead, false)
})

test('falls back to the login shell when no system proxy is on', () => {
  const env = resolveWorkerProxyEnv(
    FINDER_ENV,
    options({
      readLoginShell: () => ({ HTTPS_PROXY: 'http://shell:7890', NO_PROXY: 'corp.lan, .internal' })
    })
  )
  assert.deepEqual(env, {
    HTTPS_PROXY: 'http://shell:7890',
    NO_PROXY: 'localhost,127.0.0.1,::1,corp.lan,.internal',
    no_proxy: 'localhost,127.0.0.1,::1,corp.lan,.internal'
  })
})

test('keeps hosts from an inherited NO_PROXY', () => {
  const env = resolveWorkerProxyEnv(
    { ...FINDER_ENV, NO_PROXY: 'build.example.com' },
    options({ readSystemProxy: () => SCUTIL_ON })
  )
  assert.equal(
    env.NO_PROXY,
    'localhost,127.0.0.1,::1,.local,intranet.example.org,build.example.com'
  )
})

test('adds nothing when no proxy is configured anywhere, or on Windows', () => {
  assert.deepEqual(resolveWorkerProxyEnv(FINDER_ENV, options({})), {})
  assert.deepEqual(
    resolveWorkerProxyEnv(
      FINDER_ENV,
      options({ platform: 'win32', readSystemProxy: () => SCUTIL_ON })
    ),
    {}
  )
})

test('scutil parsing ignores SOCKS-only setups and handles a missing port', () => {
  assert.equal(
    proxyEnvFromScutil('<dictionary> {\n  SOCKSEnable : 1\n  SOCKSProxy : 127.0.0.1\n}\n'),
    undefined
  )
  const env = proxyEnvFromScutil('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : proxy.lan\n}\n')
  assert.equal(env?.HTTPS_PROXY, 'http://proxy.lan')
  assert.equal(env?.HTTP_PROXY, undefined)
})

test(
  'login shell env is read in one launch and fenced from rc-file output',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'phi-shell-'))
    try {
      const shell = join(dir, 'noisy-sh')
      writeFileSync(
        shell,
        '#!/bin/sh\necho "welcome banner"\nHTTPS_PROXY=http://from-rc:1 exec /bin/sh "$@"\n'
      )
      chmodSync(shell, 0o755)
      clearLoginShellEnvCache()
      const values = readLoginShellEnv({ SHELL: shell })
      assert.equal(values.HTTPS_PROXY, 'http://from-rc:1')
      assert.equal(values.http_proxy, undefined)
      assert.ok(values.PATH && !values.PATH.includes('welcome banner'))
    } finally {
      clearLoginShellEnvCache()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
