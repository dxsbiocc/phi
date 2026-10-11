import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import { runWorkspaceHostContract } from './workspace-host-contract'

let shimDirectory = ''
let restoreSetsid = (): void => undefined

before(async () => {
  shimDirectory = await mkdtemp(join(tmpdir(), 'phi-workspace-host-setsid-'))
  restoreSetsid = installSetsidShim(shimDirectory)
})

after(async () => {
  restoreSetsid()
  await rm(shimDirectory, { recursive: true, force: true })
})

function execWithInput(command: string, input: string): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal
      })
    })
    child.stdin.end(input)
  })
}

function createSession(root: string): RemoteSshSession {
  const session = createLocalShellSession(root)
  session.execWithInput = execWithInput
  return session
}

async function createPureSshHost(root: string): Promise<SshHost> {
  const canonicalRoot = await realpath(root)
  return new SshHost({
    remoteRoot: root,
    canonicalRoot,
    connect: async () => createSession(canonicalRoot)
  })
}

runWorkspaceHostContract(createPureSshHost)

test('pure SSH keeps the legacy 1 MiB text limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-ssh-text-limit-'))
  const host = await createPureSshHost(root)
  try {
    await assert.rejects(host.fs.writeAtomic('too-large.txt', 'x'.repeat(1024 * 1024 + 1)), {
      code: 'INVALID_ARGUMENT'
    })
    await assert.rejects(access(join(root, 'too-large.txt')))
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('pure SSH keeps rejecting NUL in the legacy text path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-workspace-host-ssh-text-nul-'))
  const host = await createPureSshHost(root)
  try {
    await assert.rejects(host.fs.writeAtomic('nul.txt', 'before\0after'), {
      code: 'INVALID_ARGUMENT'
    })
    await assert.rejects(access(join(root, 'nul.txt')))
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('pure SSH binary staging does not follow a swapped staging symlink', async () => {
  const base = await mkdtemp(join(tmpdir(), 'phi-workspace-host-ssh-stage-swap-'))
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(join(outside, 'payload'), 'outside')
  const canonicalRoot = await realpath(root)
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot,
    connect: async () => {
      const session = createSession(canonicalRoot)
      const openStdio = session.openStdio?.bind(session)
      assert.ok(openStdio)
      session.openStdio = async (command) => {
        const process = await openStdio(command)
        let stagePath: string | undefined
        for (let attempt = 0; attempt < 5_000; attempt += 1) {
          const stage = (await readdir(root)).find((name) => name.startsWith('.phi-write-'))
          if (stage) {
            const candidate = join(root, stage)
            if (
              await access(candidate).then(
                () => true,
                () => false
              )
            ) {
              stagePath = candidate
              break
            }
          }
          await delay(1)
        }
        assert.ok(stagePath, 'atomic write did not open its staging payload')
        await unlink(stagePath)
        await symlink(join(outside, 'payload'), stagePath)
        return process
      }
      return session
    }
  })
  try {
    await assert.rejects(
      host.fs.writeAtomic('result.bin', Buffer.from([0, 1, 2, 3])),
      /remote atomic write failed/
    )
    assert.equal(await readFile(join(outside, 'payload'), 'utf8'), 'outside')
    await assert.rejects(access(join(root, 'result.bin')))
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('.phi-write-')),
      false
    )
  } finally {
    await host.close()
    await rm(base, { recursive: true, force: true })
  }
})
