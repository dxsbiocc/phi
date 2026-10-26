import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'

import { checkPackagedKernel } from '../scripts/check-kernel-package'
import { createHash } from 'node:crypto'

function buildFixture(root: string): string {
  const directory = join(root, 'build', '0.1.0', 'darwin-arm64')
  mkdirSync(directory, { recursive: true })
  const executable = '#!/bin/sh\nexit 0\n'
  const native = 'native bytes\n'
  writeFileSync(join(directory, 'phi-kernel'), executable, { mode: 0o700 })
  writeFileSync(join(directory, 'pi_natives.darwin-arm64.node'), native)
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      phiVersion: '0.1.0',
      ompVersion: '18.10.3',
      nativeVersion: '18.10.3',
      bunVersion: '1.3.3',
      target: 'darwin-arm64',
      files: [
        {
          name: 'phi-kernel',
          role: 'kernel',
          sha256: createHash('sha256').update(executable).digest('hex'),
          size: Buffer.byteLength(executable)
        },
        {
          name: 'pi_natives.darwin-arm64.node',
          role: 'native',
          sha256: createHash('sha256').update(native).digest('hex'),
          size: Buffer.byteLength(native)
        }
      ]
    })
  )
  return directory
}

test('package check matches the app kernel closure to the candidate build', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const buildDirectory = buildFixture(root)
  const appPath = join(root, 'Phi.app')
  const packaged = join(appPath, 'Contents', 'Resources', 'kernel', '0.1.0', 'darwin-arm64')
  mkdirSync(packaged, { recursive: true })
  cpSync(buildDirectory, packaged, { recursive: true })

  const report = await checkPackagedKernel({
    appPath,
    buildDirectory,
    phiVersion: '0.1.0',
    target: 'darwin-arm64'
  })
  assert.equal(report.ok, true)
  assert.equal(report.files.length, 3)

  writeFileSync(join(packaged, 'pi_natives.darwin-arm64.node'), 'corrupt')
  await assert.rejects(
    checkPackagedKernel({ appPath, buildDirectory, phiVersion: '0.1.0', target: 'darwin-arm64' }),
    /failed verification/i
  )
})

test('electron-builder ships local and remote kernel packages in the mac app', () => {
  const config = parse(readFileSync('electron-builder.yml', 'utf8'))
  const mappings = config.mac.extraResources.map(
    (entry: { from?: string; to?: string }) => `${entry.from} -> ${entry.to}`
  )
  assert.ok(
    mappings.includes(
      '.phi-build/kernel/${version}/darwin-${arch} -> kernel/${version}/darwin-${arch}'
    )
  )
  assert.ok(
    mappings.includes('.phi-build/kernel/${version}/linux-x64 -> kernel/${version}/linux-x64')
  )
})
