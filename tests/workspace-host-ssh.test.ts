import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'

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

runWorkspaceHostContract(async (root) => {
  const canonicalRoot = await realpath(root)
  return new SshHost({
    remoteRoot: root,
    canonicalRoot,
    connect: async () => createSession(canonicalRoot)
  })
})
