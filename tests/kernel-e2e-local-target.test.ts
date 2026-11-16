import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  localKernelBuildTarget,
  localKernelExecutableName
} from '../src/main/agent/engine/kernel-client/local-package'
import { parseKernelE2eArgs } from '../scripts/kernel-e2e/options'

const kernelE2eSource = readFileSync(join('scripts', 'kernel-e2e.ts'), 'utf8')

test('local kernel E2E target follows the running host instead of a hardcoded Darwin package', () => {
  const options = parseKernelE2eArgs(
    ['--target', 'local', '--runtime-root', '/tmp/kernel-e2e'],
    '0.1.0'
  )
  const expected = localKernelBuildTarget(process.platform, process.arch)
  assert.equal(options.localTarget, expected)
  assert.ok(
    options.buildDirectory.endsWith(join('kernel', '0.1.0', expected)),
    `unexpected local build directory: ${options.buildDirectory}`
  )
  assert.equal(
    localKernelExecutableName(expected),
    expected === 'win32-x64' ? 'phi-kernel.exe' : 'phi-kernel'
  )
})

test('SSH kernel E2E target still resolves the deployed linux-x64 package', () => {
  const options = parseKernelE2eArgs(
    ['--target', 'ssh', '--host', 'node3', '--runtime-root', '/tmp/kernel-e2e'],
    '0.1.0'
  )
  assert.equal(options.localTarget, 'linux-x64')
  assert.ok(
    options.buildDirectory.endsWith(join('kernel', '0.1.0', 'linux-x64')),
    `unexpected remote build directory: ${options.buildDirectory}`
  )
})

test('local kernel E2E launch uses the shared package target and executable helpers', () => {
  assert.doesNotMatch(kernelE2eSource, /target:\s*'darwin-arm64'/)
  assert.doesNotMatch(kernelE2eSource, /join\(options\.buildDirectory,\s*'phi-kernel'\)/)
  assert.match(kernelE2eSource, /target:\s*options\.localTarget/)
  assert.match(kernelE2eSource, /localKernelExecutableName\(options\.localTarget\)/)
})

test('an explicit --build-dir still overrides the host-derived default', () => {
  const options = parseKernelE2eArgs(
    [
      '--target',
      'local',
      '--runtime-root',
      '/tmp/kernel-e2e',
      '--build-dir',
      '/tmp/phi-kernel-build'
    ],
    '0.1.0'
  )
  assert.equal(options.buildDirectory, '/tmp/phi-kernel-build')
  assert.equal(options.localTarget, localKernelBuildTarget(process.platform, process.arch))
})
