import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SshAskpassFileSystem } from '../src/main/agent/ssh-bootstrap/askpass'
import {
  createNodeSshBootstrapKeyFileSystem,
  generateSshBootstrapKey
} from '../src/main/agent/ssh-bootstrap/key'

test('concurrent attempts for one alias cannot race or delete the winning key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-ssh-key-lock-'))
  const sshDirectory = join(root, '.ssh')
  let releaseGeneration!: () => void
  let markStarted!: () => void
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve
  })
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  let generationCalls = 0
  const askpassFiles: SshAskpassFileSystem = {
    createDirectory: async () => join(root, 'askpass'),
    writeFile: async () => undefined,
    createSecretPipe: async () => ({ close: async () => undefined }),
    remove: async () => undefined
  }
  const dependencies = {
    sshDirectory,
    machineName: 'lock-test',
    date: '2026-10-09',
    files: createNodeSshBootstrapKeyFileSystem(),
    askpassFiles,
    runCommand: async (request: { command: string; args: string[] }) => {
      if (request.args.includes('-t')) {
        generationCalls += 1
        markStarted()
        await generationGate
        const path = request.args[request.args.indexOf('-f') + 1]
        await writeFile(path, 'PRIVATE KEY', { mode: 0o600 })
        await writeFile(`${path}.pub`, 'ssh-ed25519 AAAA-winner phi@test\n')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '256 SHA256:winner key (ED25519)\n', stderr: '' }
    }
  }
  try {
    const first = generateSshBootstrapKey(
      { alias: 'lab-hpc', protection: { kind: 'passwordless-explicit' } },
      dependencies
    )
    await started
    const second = await generateSshBootstrapKey(
      { alias: 'lab-hpc', protection: { kind: 'passwordless-explicit' } },
      dependencies
    )
    assert.deepEqual(second, { status: 'rejected', errorCode: 'unexpected' })
    assert.equal(generationCalls, 1)

    releaseGeneration()
    assert.equal((await first).status, 'ready')
    assert.equal(await readFile(join(sshDirectory, 'phi_lab-hpc_ed25519'), 'utf8'), 'PRIVATE KEY')
    assert.match(
      await readFile(join(sshDirectory, 'phi_lab-hpc_ed25519.pub'), 'utf8'),
      /AAAA-winner/
    )
  } finally {
    releaseGeneration()
    await rm(root, { recursive: true, force: true })
  }
})
