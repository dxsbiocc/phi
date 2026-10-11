import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRemoteMicromambaHostCommand,
  buildRemoteMicromambaShellCommand
} from '../src/main/agent/workspace-host/remote-micromamba-command'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations
} from './helpers/remoteRuntimeFixture'

const ROOT = '/srv/phi runtime'
const BINARY = '/srv/phi runtime/bin/micromamba-2.9.0-0/micromamba'

test('remote micromamba create starts from an empty environment and pins Phi package state', () => {
  const command = buildRemoteMicromambaHostCommand({
    binary: BINARY,
    runtimeRoot: ROOT,
    subcommand: 'create',
    args: ['-p', `${ROOT}/envs/demo`, '--yes', 'python=3.12']
  })

  assert.deepEqual(command.slice(0, 2), ['sh', '-c'])
  assert.match(command[2] ?? '', /exec env -i/u)
  assert.match(command[2] ?? '', /HOME="\$\{HOME:-\/\}"/u)
  assert.match(command[2] ?? '', /PATH='\/usr\/bin:\/bin'/u)
  assert.match(command[2] ?? '', /MAMBA_ROOT_PREFIX='\/srv\/phi runtime'/u)
  assert.match(command[2] ?? '', /MAMBA_PKGS_DIRS='\/srv\/phi runtime\/pkgs'/u)
  assert.match(command[2] ?? '', /'create' '--no-rc'/u)
  assert.doesNotMatch(command[2] ?? '', /CONDA_/u)
})

test('remote micromamba run preserves task HOME and PATH without trusting run --no-rc support', () => {
  const command = buildRemoteMicromambaShellCommand({
    binary: BINARY,
    runtimeRoot: ROOT,
    subcommand: 'run',
    args: ['-p', `${ROOT}/envs/demo`, 'python', 'script.py']
  })

  assert.match(command, /^env -i /u)
  assert.match(command, /HOME="\$\{HOME:-\/\}"/u)
  assert.match(command, /PATH="\$\{PATH:-\/usr\/bin:\/bin\}"/u)
  assert.match(command, /MAMBA_PKGS_DIRS='\/srv\/phi runtime\/pkgs'/u)
  assert.match(command, /'--rc-file' '\/dev\/null' 'run'/u)
  assert.doesNotMatch(command, /--no-rc/u)
  assert.doesNotMatch(command, /CONDA_/u)
})

test('the fake micromamba observes only Phi runtime state and isolated argv', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const binary = installFakeMicromamba(fixture)
    const prefix = `${fixture.runtimeRoot}/envs/demo`
    const dirtyEnv = {
      HOME: fixture.remoteHome,
      PATH: '/private/conda/bin:/usr/bin:/bin',
      CONDA_PREFIX: '/private/conda',
      MAMBA_ROOT_PREFIX: '/private/mamba',
      MAMBA_PKGS_DIRS: '/private/pkgs',
      CONDARC: `${fixture.remoteHome}/.condarc`,
      MAMBARC: `${fixture.remoteHome}/.mambarc`
    }
    const create = await fixture.workspace.projectHost.exec.run(
      buildRemoteMicromambaHostCommand({
        binary,
        runtimeRoot: fixture.runtimeRoot,
        subcommand: 'create',
        args: ['-p', prefix, '--yes', 'python=3.12']
      }),
      { cwd: fixture.projectRoot, env: dirtyEnv }
    )
    const run = await fixture.workspace.projectHost.exec.run(
      buildRemoteMicromambaHostCommand({
        binary,
        runtimeRoot: fixture.runtimeRoot,
        subcommand: 'run',
        args: ['-p', prefix, 'sh', '-c', ':']
      }),
      { cwd: fixture.projectRoot, env: dirtyEnv }
    )

    assert.equal(create.code, 0)
    assert.equal(run.code, 0)
    const calls = readFakeMicromambaInvocations(fixture)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0]?.argv.slice(0, 2), ['create', '--no-rc'])
    assert.deepEqual(calls[1]?.argv.slice(0, 3), ['--rc-file', '/dev/null', 'run'])
    for (const call of calls) {
      assert.equal(call.env.MAMBA_ROOT_PREFIX, fixture.runtimeRoot)
      assert.equal(call.env.MAMBA_PKGS_DIRS, `${fixture.runtimeRoot}/pkgs`)
      assert.equal(call.env.HOME, fixture.remoteHome)
      assert.equal(
        Object.keys(call.env).some((name) => name.startsWith('CONDA_')),
        false
      )
      assert.equal(call.env.CONDARC, undefined)
      assert.equal(call.env.MAMBARC, undefined)
    }
    assert.equal(calls[0]?.env.PATH, '/usr/bin:/bin')
    assert.equal(calls[1]?.env.PATH, dirtyEnv.PATH)
  } finally {
    fixture.cleanup()
  }
})
