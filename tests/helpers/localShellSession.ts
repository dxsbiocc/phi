import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type {
  RemoteExecResult,
  RemoteUploadFileOptions,
  RemoteSshSession,
  RemoteStdioProcess
} from '../../src/main/agent/wrappers/remote-ssh-session'

/**
 * A `RemoteSshSession` whose "remote host" is this machine: commands run through
 * a real `bash -c`, files are plain files. It exercises the same shell strings the
 * SSH session would send (unlike an in-memory fake), without needing an sshd.
 * `commands` records every exec for assertions.
 */
export interface LocalShellSession extends RemoteSshSession {
  commands: string[]
  uploads: Array<{
    localPath: string
    remotePath: string
    options: RemoteUploadFileOptions | undefined
  }>
  closed: boolean
  killLatestStdio(signal?: NodeJS.Signals): void
}

function signalStdioProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  child.kill(signal)
}

export function createLocalShellSession(remoteRoot?: string): LocalShellSession {
  const stdioProcesses = new Set<ChildProcessWithoutNullStreams>()
  const session: LocalShellSession = {
    commands: [],
    uploads: [],
    closed: false,
    killLatestStdio(signal = 'SIGKILL') {
      const child = [...stdioProcesses].at(-1)
      if (!child) throw new Error('No local stdio process is available')
      signalStdioProcess(child, signal)
    },
    exec(command: string): Promise<RemoteExecResult> {
      session.commands.push(command)
      // The macOS test sandbox denies `ps`. Simulate its run-script identity
      // result from the PID receipt; fake host tests separately cover reuse.
      const inspectedPid = command.match(/^ps -ww -o args= -p ([1-9][0-9]*)$/)?.[1]
      if (inspectedPid && remoteRoot) {
        const runsDir = join(remoteRoot, 'wrappers', 'runs')
        const runDir = existsSync(runsDir)
          ? readdirSync(runsDir)
              .map((name) => join(runsDir, name))
              .find(
                (path) =>
                  existsSync(join(path, 'pid')) &&
                  readFileSync(join(path, 'pid'), 'utf8').trim() === inspectedPid
              )
          : undefined
        return Promise.resolve({
          stdout: runDir ? `bash ${runDir}/launch.sh\n` : '',
          stderr: '',
          code: runDir ? 0 : 1,
          signal: null
        })
      }
      return new Promise((resolve) => {
        const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')))
        child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
      })
    },
    execWithInput(command, input, options) {
      session.commands.push(command)
      options?.signal?.throwIfAborted()
      return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const stop = (): void => child.kill('SIGTERM')
        const timer = options?.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined
        options?.signal?.addEventListener('abort', stop, { once: true })
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')))
        child.once('error', reject)
        child.once('close', (code, signal) => {
          if (timer) clearTimeout(timer)
          options?.signal?.removeEventListener('abort', stop)
          resolve({ stdout, stderr, code, signal })
        })
        child.stdin.on('error', () => undefined)
        child.stdin.end(input)
      })
    },
    async execBounded(command, options) {
      options.signal?.throwIfAborted()
      const result = await session.exec(command)
      options.signal?.throwIfAborted()
      const stdoutTruncated = Buffer.byteLength(result.stdout, 'utf8') > options.maxOutputBytes
      const stderrTruncated = Buffer.byteLength(result.stderr, 'utf8') > options.maxOutputBytes
      return {
        ...result,
        stdout: stdoutTruncated ? result.stdout.slice(0, options.maxOutputBytes) : result.stdout,
        stderr: stderrTruncated ? result.stderr.slice(0, options.maxOutputBytes) : result.stderr,
        stdoutTruncated,
        stderrTruncated
      }
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
    async uploadFile(localPath, remotePath, options) {
      session.uploads.push({ localPath, remotePath, options })
      copyFileSync(localPath, remotePath)
    },
    async openStdio(command): Promise<RemoteStdioProcess> {
      session.commands.push(command)
      const child = spawn('bash', ['-c', command], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      stdioProcesses.add(child)
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => {
            stdioProcesses.delete(child)
            resolve({ code, signal })
          })
        }
      )
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        closed,
        async close() {
          child.stdin.end()
          await Promise.race([closed, delay(250)])
          if (child.exitCode === null && child.signalCode === null)
            signalStdioProcess(child, 'SIGTERM')
          await Promise.race([closed, delay(2_000)])
          if (child.exitCode === null && child.signalCode === null)
            signalStdioProcess(child, 'SIGKILL')
          await closed.catch(() => undefined)
        }
      }
    },
    async close() {
      session.closed = true
      for (const child of stdioProcesses) {
        child.stdin.end()
        signalStdioProcess(child, 'SIGTERM')
      }
    }
  }
  return session
}

/** Adds test-only remote-shell startup latency without changing command contents or results. */
export function withRemoteCommandDelay(
  session: RemoteSshSession,
  delayMs: number
): RemoteSshSession {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Invalid remote command delay')
  if (delayMs === 0) return session
  const wait = (): Promise<void> => delay(delayMs).then(() => undefined)
  return {
    exec: async (command) => {
      await wait()
      return session.exec(command)
    },
    readTextFile: async (path) => {
      await wait()
      return session.readTextFile(path)
    },
    writeTextFile: async (path, content) => {
      await wait()
      return session.writeTextFile(path, content)
    },
    mkdirp: async (path) => {
      await wait()
      return session.mkdirp(path)
    },
    exists: async (path) => {
      await wait()
      return session.exists(path)
    },
    uploadFile: (localPath, remotePath, options) =>
      session.uploadFile(localPath, remotePath, options),
    close: () => session.close(),
    ...(session.readFileChunk
      ? {
          readFileChunk: async (path, options) => {
            await wait()
            return session.readFileChunk!(path, options)
          }
        }
      : {}),
    ...(session.execWithInput
      ? {
          execWithInput: async (command, input, options) => {
            await wait()
            return session.execWithInput!(command, input, options)
          }
        }
      : {}),
    ...(session.execBounded
      ? {
          execBounded: async (command, options) => {
            await wait()
            return session.execBounded!(command, options)
          }
        }
      : {}),
    ...(session.openStdio
      ? {
          openStdio: async (command) => {
            await wait()
            return session.openStdio!(command)
          }
        }
      : {}),
    ...(session.openReverseTunnel
      ? { openReverseTunnel: session.openReverseTunnel.bind(session) }
      : {})
  }
}

/**
 * macOS has no `setsid`, which the remote launch relies on (the cluster is Linux).
 * This puts a perl stand-in first on PATH so the same launch string runs locally;
 * it is a no-op where a real `setsid` exists. Returns a restore function.
 */
export function installSetsidShim(dir: string): () => void {
  const savedPath = process.env.PATH
  if (!process.env.FAKE_SETSID_GATE) {
    try {
      execFileSync('which', ['setsid'], { stdio: 'ignore' })
      return () => undefined
    } catch {
      // fall through to the shim
    }
  }
  const shim = join(dir, 'setsid')
  writeFileSync(
    shim,
    [
      '#!/usr/bin/perl',
      'use POSIX;',
      'my $gate = $ENV{"FAKE_SETSID_GATE"};',
      'while (defined($gate) && length($gate) && !-e $gate) { select undef, undef, undef, 0.02; }',
      'POSIX::setsid();',
      'exec @ARGV or die "exec: $!";',
      ''
    ].join('\n')
  )
  chmodSync(shim, 0o755)
  process.env.PATH = `${dir}:${savedPath ?? ''}`
  return () => {
    process.env.PATH = savedPath
  }
}
