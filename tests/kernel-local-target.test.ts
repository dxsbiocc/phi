import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  localKernelBuildTarget,
  localKernelExecutableName,
  verifyLocalKernelPackage
} from '../src/main/agent/engine/kernel-client/local-package'

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

test('local kernel target includes Windows x64', () => {
  assert.equal(localKernelBuildTarget('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(localKernelBuildTarget('linux', 'x64'), 'linux-x64')
  assert.equal(localKernelBuildTarget('win32', 'x64'), 'win32-x64')
  assert.throws(() => localKernelBuildTarget('darwin', 'x64'), /no local build target/)
  assert.equal(localKernelExecutableName('win32-x64'), 'phi-kernel.exe')
  assert.equal(localKernelExecutableName('linux-x64'), 'phi-kernel')
})

test('Windows kernel package verifies one baseline native addon and an .exe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phi-win-kernel-'))
  try {
    const files = {
      'phi-kernel.exe': 'kernel\n',
      'pi_natives.win32-x64-baseline.node': 'native\n'
    }
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content, { mode: 0o700 })
    }
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify({
        phiVersion: '0.1.0',
        ompVersion: '18.10.3',
        nativeVersion: '18.10.3',
        bunVersion: '1.3.14',
        target: 'win32-x64',
        files: Object.entries(files).map(([name, content]) => ({
          name,
          role: name.endsWith('.exe') ? 'kernel' : 'native',
          ...(name.endsWith('.node') ? { variant: 'baseline' } : {}),
          sha256: sha256(content),
          size: Buffer.byteLength(content)
        }))
      })
    )
    const verified = await verifyLocalKernelPackage({
      directory,
      target: 'win32-x64',
      phiVersion: '0.1.0'
    })
    assert.equal(verified.executable, join(directory, 'phi-kernel.exe'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
