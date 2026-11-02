import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { checkReleaseKernels } from '../scripts/check-release-kernel'

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

function packagedKernel(t: TestContext): { resources: string; kernel: string } {
  const resources = mkdtempSync(join(tmpdir(), 'phi-release-kernel-'))
  t.after(() => rmSync(resources, { recursive: true, force: true }))
  const directory = join(resources, 'kernel', '0.1.0', 'darwin-arm64')
  mkdirSync(directory, { recursive: true })
  const contents = { 'phi-kernel': 'kernel bytes\n', 'pi_natives.darwin-arm64.node': 'native\n' }
  writeFileSync(join(directory, 'phi-kernel'), contents['phi-kernel'], { mode: 0o700 })
  writeFileSync(
    join(directory, 'pi_natives.darwin-arm64.node'),
    contents['pi_natives.darwin-arm64.node']
  )
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      phiVersion: '0.1.0',
      ompVersion: '18.10.3',
      nativeVersion: '18.10.3',
      bunVersion: '1.3.14',
      target: 'darwin-arm64',
      files: Object.entries(contents).map(([name, content]) => ({
        name,
        role: name === 'phi-kernel' ? 'kernel' : 'native',
        sha256: sha256(content),
        size: Buffer.byteLength(content)
      }))
    })
  )
  return { resources, kernel: join(directory, 'phi-kernel') }
}

test('a package whose kernels match their manifest passes', async (t) => {
  const { resources } = packagedKernel(t)
  await checkReleaseKernels({ resources, phiVersion: '0.1.0', targets: ['darwin-arm64'] })
})

test('a kernel rewritten after its manifest, as signing does, fails', async (t) => {
  const { resources, kernel } = packagedKernel(t)
  appendFileSync(kernel, 'signature\n')
  await assert.rejects(
    checkReleaseKernels({ resources, phiVersion: '0.1.0', targets: ['darwin-arm64'] }),
    /failed verification: phi-kernel/
  )
})

test('a package missing a required kernel fails', async (t) => {
  const { resources } = packagedKernel(t)
  await assert.rejects(
    checkReleaseKernels({ resources, phiVersion: '0.1.0', targets: ['darwin-arm64', 'linux-x64'] }),
    /no linux-x64 kernel/
  )
})
