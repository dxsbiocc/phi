import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  RemoteExecResult,
  RemoteSshSession
} from '../../src/main/agent/wrappers/remote-ssh-session'

/**
 * A `RemoteSshSession` whose "remote host" is this machine: commands run through
 * a real `bash -c`, files are plain files. It exercises the same shell strings the
 * SSH session would send (unlike an in-memory fake), without needing an sshd.
 * `commands` records every exec for assertions.
 */
export interface LocalShellSession extends RemoteSshSession {
  commands: string[]
  uploads: Array<{ localPath: string; remotePath: string }>
  closed: boolean
}

export function createLocalShellSession(): LocalShellSession {
  const session: LocalShellSession = {
    commands: [],
    uploads: [],
    closed: false,
    exec(command: string): Promise<RemoteExecResult> {
      session.commands.push(command)
      return new Promise((resolve) => {
        const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')))
        child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
      })
    },
    async readTextFile(remotePath) {
      return readFileSync(remotePath, 'utf-8')
    },
    async writeTextFile(remotePath, content) {
      mkdirSync(dirname(remotePath), { recursive: true })
      writeFileSync(remotePath, content)
    },
    async mkdirp(remotePath) {
      mkdirSync(remotePath, { recursive: true })
    },
    async exists(remotePath) {
      return existsSync(remotePath)
    },
    async uploadFile(localPath, remotePath) {
      session.uploads.push({ localPath, remotePath })
      copyFileSync(localPath, remotePath)
    },
    async close() {
      session.closed = true
    }
  }
  return session
}

/**
 * macOS has no `setsid`, which the remote launch relies on (the cluster is Linux).
 * This puts a perl stand-in first on PATH so the same launch string runs locally;
 * it is a no-op where a real `setsid` exists. Returns a restore function.
 */
export function installSetsidShim(dir: string): () => void {
  const savedPath = process.env.PATH
  try {
    execFileSync('which', ['setsid'], { stdio: 'ignore' })
    return () => undefined
  } catch {
    // fall through to the shim
  }
  const shim = join(dir, 'setsid')
  writeFileSync(
    shim,
    '#!/usr/bin/perl\nuse POSIX;\nPOSIX::setsid();\nexec @ARGV or die "exec: $!";\n'
  )
  chmodSync(shim, 0o755)
  process.env.PATH = `${dir}:${savedPath ?? ''}`
  return () => {
    process.env.PATH = savedPath
  }
}
