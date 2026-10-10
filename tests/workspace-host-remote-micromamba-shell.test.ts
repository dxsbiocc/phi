import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildDownloadScript,
  buildHashScript,
  buildNetworkProbeScript,
  buildVerificationScript,
  parseVerification,
  parseRemoteHash
} from '../src/main/agent/workspace-host/remote-micromamba-shell'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession } from './helpers/localShellSession'

function runWithInput(
  command: string,
  input: string,
  env: NodeJS.ProcessEnv
): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.end(input)
  })
}

test('falls back when sha256sum exists but cannot hash the uploaded file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-micromamba-hash-fallback-'))
  const shim = join(directory, 'sha256sum')
  const artifact = join(directory, 'artifact')
  const contents = 'verified bytes'
  await writeFile(shim, '#!/bin/sh\nexit 1\n')
  await chmod(shim, 0o755)
  await writeFile(artifact, contents)
  const session = createLocalShellSession()
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` }
  session.execWithInput = (command, input) => runWithInput(command, input, env)

  try {
    const result = await session.execWithInput('sh -s', buildHashScript(artifact))

    assert.deepEqual(parseRemoteHash(result.stdout), {
      hash: createHash('sha256').update(contents).digest('hex')
    })
  } finally {
    await session.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('builds bounded ranged speed probes for curl and wget', () => {
  const script = buildNetworkProbeScript('https://github.com/release')

  assert.match(script, /--range 0-262143/)
  assert.match(script, /--max-time 8 --speed-limit 51200 --speed-time 5/)
  assert.match(script, /Range: bytes=0-262143/)
  assert.match(script, /--read-timeout=8/)
  assert.match(script, /phi_remaining=\$\(\(8 - phi_elapsed\)\)/)
  assert.match(
    script,
    /sleep \$phi_remaining & phi_sleep=\$!; wait "\$phi_sleep"; kill "\$phi_pid"/
  )
})

test('builds low-speed and overall limits for direct downloads', () => {
  const curl = buildDownloadScript('https://github.com/release', '/tmp/staging', 'curl', 321)
  const wget = buildDownloadScript('https://github.com/release', '/tmp/staging', 'wget', 321)

  assert.match(curl, /--max-time 321 --speed-limit 51200 --speed-time 20/)
  assert.match(wget, /--read-timeout=20/)
  assert.match(wget, /sleep 321 & phi_sleep=\$!; wait "\$phi_sleep"; kill "\$phi_pid"/)
})

test('verification exercises micromamba run against an offline temporary prefix', () => {
  const script = buildVerificationScript('/runtime/bin/micromamba-2.9.0-0/micromamba', '/runtime')

  assert.match(script, /mktemp -d/)
  assert.match(script, /conda-meta\/history/)
  assert.match(script, /--rc-file \/dev\/null run -p "\$phi_prefix" \/bin\/sh -c/)
  assert.match(script, /env -i HOME=/)
  assert.match(script, /__PHI_MICROMAMBA_RUN__/)
})

test('verification parsing distinguishes an activation run failure', () => {
  const parsed = parseVerification(
    [
      '__PHI_MICROMAMBA_VERSION__=2.9.0',
      '__PHI_MICROMAMBA_PLATFORM__=linux-64',
      '__PHI_MICROMAMBA_RUN__=17'
    ].join('\n'),
    1
  )

  assert.deepEqual(parsed, {
    version: '2.9.0',
    platform: 'linux-64',
    runSuccessful: false,
    runnable: false
  })
})
