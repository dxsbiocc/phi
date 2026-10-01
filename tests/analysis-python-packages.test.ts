import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearAnalysisPythonPackageCache,
  listAnalysisPythonPackages,
  type PythonPackageListRunner
} from '../src/main/agent/notebook/analysis-python-packages'

test('listAnalysisPythonPackages reads top-level packages from Python', () => {
  clearAnalysisPythonPackageCache()
  const commands: string[] = []
  const runner: PythonPackageListRunner = (command) => {
    commands.push(command)
    return {
      status: 0,
      stdout: JSON.stringify({
        packages: [
          { name: 'pandas', kind: 'package', source: 'third-party' },
          { name: 'json', kind: 'module', source: 'environment' },
          { name: '_private', kind: 'module', source: 'third-party' }
        ]
      }),
      stderr: ''
    }
  }

  const result = listAnalysisPythonPackages({ projectCwd: '/projects/research' }, { runner })

  assert.equal(commands[0], 'python')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.packages, [
    { name: 'pandas', kind: 'package', source: 'third-party' },
    { name: 'json', kind: 'module', source: 'environment' }
  ])
})

test('listAnalysisPythonPackages falls back to python3 when python is unavailable', () => {
  clearAnalysisPythonPackageCache()
  const commands: string[] = []
  const runner: PythonPackageListRunner = (command) => {
    commands.push(command)
    if (command === 'python') {
      return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }
    }
    return {
      status: 0,
      stdout: JSON.stringify({
        packages: [{ name: 'numpy', kind: 'package', source: 'third-party' }]
      }),
      stderr: ''
    }
  }

  const result = listAnalysisPythonPackages({ projectCwd: '/projects/research' }, { runner })

  assert.deepEqual(commands, ['python', 'python3'])
  assert.deepEqual(
    result.packages.map((entry) => entry.name),
    ['numpy']
  )
})

test('listAnalysisPythonPackages asks the managed phi-python interpreter first, with its variables', () => {
  const calls: { command: string; env?: Record<string, string> }[] = []
  const runner: PythonPackageListRunner = (command, _args, options) => {
    calls.push({ command, env: options.env })
    return {
      status: 0,
      stdout: JSON.stringify({
        packages: [{ name: 'numpy', kind: 'package', source: 'third-party' }]
      }),
      stderr: ''
    }
  }
  const result = listAnalysisPythonPackages(
    { projectCwd: process.cwd() },
    {
      runner,
      managedPython: () => ({
        command: '/runtime/envs/phi-python-x/bin/python',
        env: { PHI_ENV_ID: 'x' }
      })
    }
  )
  assert.equal(result.status, 'ok')
  assert.deepEqual(calls, [
    { command: '/runtime/envs/phi-python-x/bin/python', env: { PHI_ENV_ID: 'x' } }
  ])
})
