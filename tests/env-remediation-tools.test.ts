import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  buildEnvBuildTool,
  handleEnvironmentBuildRequest
} from '../src/main/agent/content/env-build-tool'
import {
  buildEnvSetupWslTool,
  handleWslSetupRequest,
  wslArgsForAction
} from '../src/main/agent/content/env-setup-wsl-tool'
import { validateSkill } from '../src/main/agent/content/skill'
import { CORE_TOOLS } from '../src/main/agent/core-tools'

test('CORE_TOOLS includes env_build and env_setup_wsl, and bundled environment-setup skill validates', () => {
  assert.equal(CORE_TOOLS.has('env_build'), true)
  assert.equal(CORE_TOOLS.has('env_setup_wsl'), true)
  const validated = validateSkill(resolve('resources/skills/environment-setup'))
  assert.equal(validated.ok, true, JSON.stringify(validated.errors))
  assert.deepEqual(validated.errors, [])
  assert.deepEqual(validated.warnings, [])
})

test('env_build short-circuits with WSL2 guidance when Windows WSL2 is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-env-build-wsl-'))
  try {
    let confirmCalled = false
    const result = await handleEnvironmentBuildRequest(
      { runtimeSessionId: 'sess-1', ref: 'phi:nextflow@1' },
      {
        root,
        platform: 'win32-x64',
        confirmBuild: async () => {
          confirmCalled = true
          return true
        },
        probeWsl: async () => ({ status: 'missing' })
      }
    )
    assert.equal(confirmCalled, false)
    assert.equal(result.status, 'notReady')
    assert.equal(result.guidance?.code, 'wsl_missing')
    assert.match(result.message, /wsl --install/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildEnvBuildTool validates input and surfaces RPC results', async () => {
  let seenMethod = ''
  const tool = buildEnvBuildTool(
    async (method, params) => {
      seenMethod = method
      return {
        status: 'ready',
        ref: (params as { ref: string }).ref,
        envId: 'phi-r-1234567890ab',
        runtime: 'native',
        message: '环境 phi:r@1 已就绪。'
      }
    },
    { runtimeSessionId: 'sess-build' }
  )

  const bad = await tool.execute('c1', {}, undefined, { cwd: '/tmp' } as never, undefined)
  assert.equal(bad.isError, true)

  const ok = await tool.execute(
    'c2',
    { ref: 'phi:r@1', reason: '需要运行 R Notebook' },
    undefined,
    { cwd: '/tmp' } as never,
    undefined
  )
  assert.equal(ok.isError, undefined)
  assert.equal(seenMethod, 'environments.build')
  assert.match(ok.content[0]?.type === 'text' ? ok.content[0].text : '', /已就绪/u)
})

test('wslArgsForAction enforces strict allowlist and safe distro names', () => {
  assert.deepEqual(wslArgsForAction('install_wsl'), {
    args: ['--install'],
    display: 'wsl --install'
  })
  assert.deepEqual(wslArgsForAction('install_ubuntu'), {
    args: ['--install', '-d', 'Ubuntu'],
    display: 'wsl --install -d Ubuntu'
  })
  assert.deepEqual(wslArgsForAction('upgrade_to_wsl2', 'Ubuntu-24.04'), {
    args: ['--set-version', 'Ubuntu-24.04', '2'],
    display: 'wsl --set-version Ubuntu-24.04 2'
  })
  assert.throws(() => wslArgsForAction('upgrade_to_wsl2', 'Ubuntu; calc.exe'))
})

test('handleWslSetupRequest handles non-Windows, already-ready, declined, completed, and reboot-needed states', async () => {
  const mac = await handleWslSetupRequest(
    { runtimeSessionId: 's1', action: 'install_wsl' },
    { platform: 'darwin' }
  )
  assert.equal(mac.status, 'unsupported')

  const already = await handleWslSetupRequest(
    { runtimeSessionId: 's1', action: 'install_wsl' },
    {
      platform: 'win32',
      probeWsl: () => ({ status: 'ready', executable: 'wsl.exe', distro: 'Ubuntu' })
    }
  )
  assert.equal(already.status, 'already_ready')

  let elevatedCalled = false
  const declined = await handleWslSetupRequest(
    { runtimeSessionId: 's1', action: 'install_wsl' },
    {
      platform: 'win32',
      probeWsl: () => ({ status: 'missing' }),
      confirm: async () => false,
      runElevatedWsl: async () => {
        elevatedCalled = true
      }
    }
  )
  assert.equal(declined.status, 'declined')
  assert.equal(elevatedCalled, false)

  let probeCount = 0
  let capturedArgs: readonly string[] = []
  const completed = await handleWslSetupRequest(
    { runtimeSessionId: 's1', action: 'upgrade_to_wsl2' },
    {
      platform: 'win32',
      probeWsl: () => {
        probeCount += 1
        return probeCount === 1
          ? { status: 'not-version-2', executable: 'wsl.exe', distro: 'Ubuntu', version: 1 }
          : { status: 'ready', executable: 'wsl.exe', distro: 'Ubuntu' }
      },
      confirm: async () => true,
      runElevatedWsl: async (args) => {
        capturedArgs = args
      }
    }
  )
  assert.equal(completed.status, 'completed')
  assert.deepEqual(capturedArgs, ['--set-version', 'Ubuntu', '2'])

  const rebootNeeded = await handleWslSetupRequest(
    { runtimeSessionId: 's1', action: 'install_wsl' },
    {
      platform: 'win32',
      probeWsl: () => ({ status: 'missing' }),
      confirm: async () => true,
      runElevatedWsl: async () => undefined
    }
  )
  assert.equal(rebootNeeded.status, 'needs_reboot_or_init')
})

test('buildEnvSetupWslTool rejects invalid actions and unsafe distro names before calling host', async () => {
  let hostCalled = false
  const tool = buildEnvSetupWslTool(
    async () => {
      hostCalled = true
      return { status: 'completed', action: 'install_wsl', message: 'ok' }
    },
    { runtimeSessionId: 's1' }
  )

  const badAction = await tool.execute(
    'c1',
    { action: 'rm_rf' },
    undefined,
    { cwd: '/tmp' } as never,
    undefined
  )
  assert.equal(badAction.isError, true)
  assert.equal(hostCalled, false)

  const badDistro = await tool.execute(
    'c2',
    { action: 'upgrade_to_wsl2', distro: 'Ubuntu && whoami' },
    undefined,
    { cwd: '/tmp' } as never,
    undefined
  )
  assert.equal(badDistro.isError, true)
  assert.equal(hostCalled, false)

  const ok = await tool.execute(
    'c3',
    { action: 'install_wsl' },
    undefined,
    { cwd: '/tmp' } as never,
    undefined
  )
  assert.equal(ok.isError, undefined)
  assert.equal(hostCalled, true)
})
