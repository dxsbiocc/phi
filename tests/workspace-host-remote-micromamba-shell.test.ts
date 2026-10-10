import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildHashScript,
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
