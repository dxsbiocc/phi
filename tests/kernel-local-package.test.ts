import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { launchLocalKernel } from '../src/main/agent/engine/kernel-client'

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

function writePackage(root: string, marker: string, phiVersion = '0.1.0', runnable = false): void {
  const executable = runnable
    ? `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
writeFileSync(${JSON.stringify(marker)}, 'executed')
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({
    kind: 'response', id: request.id, ok: true,
    result: {
      protocol: { major: 1, minor: 0 },
      kernel: { version: '0.1.0', ompVersion: '18.10.3' },
      kernelInstanceId: 'offline-package', controllerGeneration: 1,
      capabilities: [], lastSeq: 0, runtime: { home: '/tmp/home', agentDir: '/tmp/agent' }
    }
  }) + '\\n')
}
`
    : `#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(
        marker
      )}, 'executed')\n`
  const native = 'fixture native bytes\n'
  writeFileSync(join(root, 'phi-kernel'), executable, { mode: 0o700 })
  writeFileSync(join(root, 'pi_natives.darwin-arm64.node'), native)
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      phiVersion,
      ompVersion: '18.10.3',
      nativeVersion: '18.10.3',
      bunVersion: '1.3.3',
      target: 'darwin-arm64',
      files: [
        {
          name: 'phi-kernel',
          role: 'kernel',
          sha256: sha256(executable),
          size: Buffer.byteLength(executable)
        },
        {
          name: 'pi_natives.darwin-arm64.node',
          role: 'native',
          sha256: sha256(native),
          size: Buffer.byteLength(native)
        }
      ]
    })
  )
}

test('packaged local launcher refuses corrupt, missing, or mismatched packages before execution', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-local-package-'))
  const marker = join(root, 'executed.txt')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePackage(root, marker)
  writeFileSync(join(root, 'phi-kernel'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  await assert.rejects(
    launchLocalKernel({
      package: { directory: root, target: 'darwin-arm64', phiVersion: '0.1.0' },
      agentDir: join(root, 'agent'),
      helloTimeoutMs: 100
    }),
    /failed verification/i
  )
  assert.equal(existsSync(marker), false)

  writePackage(root, marker)
  rmSync(join(root, 'pi_natives.darwin-arm64.node'))
  await assert.rejects(
    launchLocalKernel({
      package: { directory: root, target: 'darwin-arm64', phiVersion: '0.1.0' },
      agentDir: join(root, 'agent'),
      helloTimeoutMs: 100
    }),
    /failed verification/i
  )
  assert.equal(existsSync(marker), false)

  writePackage(root, marker, '9.9.9')
  await assert.rejects(
    launchLocalKernel({
      package: { directory: root, target: 'darwin-arm64', phiVersion: '0.1.0' },
      agentDir: join(root, 'agent'),
      helloTimeoutMs: 100
    }),
    /version mismatch/i
  )
  assert.equal(existsSync(marker), false)
})

test('an already-present verified package launches without network access', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-local-package-offline-'))
  const marker = join(root, 'executed.txt')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writePackage(root, marker, '0.1.0', true)

  const kernel = await launchLocalKernel({
    package: { directory: root, target: 'darwin-arm64', phiVersion: '0.1.0' },
    agentDir: join(root, 'agent'),
    env: { PATH: process.env.PATH, NO_PROXY: '*', no_proxy: '*' }
  })
  try {
    assert.equal(kernel.greeting.kernel.version, '0.1.0')
    assert.equal(existsSync(marker), true)
  } finally {
    const outcome = await kernel.close()
    assert.equal(outcome.action, 'stdin-eof')
  }
})
