import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../../src/main/agent/wrappers/remote-ssh-session'
import type { RpcStartupTransactionWriter } from '../../src/main/agent/engine/rpc/startup-transaction'

export async function createModelProxyConfigFixture(): Promise<{
  root: string
  runtimeRoot: string
  projectRoot: string
  agentDir: string
  session: Required<Pick<RemoteSshSession, 'execWithInput' | 'execBounded'>>
  startup: RpcStartupTransactionWriter
  records: Array<{ command: string; input?: string }>
  generation(): Promise<string>
  setPath(path: string): void
  cleanup(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-model-config-')))
  const runtimeRoot = join(root, "runtime user's root")
  await mkdir(runtimeRoot, { mode: 0o700 })
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot, { mode: 0o700 })
  const generation = async (): Promise<string> => {
    const agentDir = join(runtimeRoot, 'rpc-sessions', randomUUID(), 'home/agent')
    await mkdir(agentDir, { recursive: true, mode: 0o700 })
    return agentDir
  }
  const records: Array<{ command: string; input?: string }> = []
  const children = new Set<ChildProcessWithoutNullStreams>()
  let path = '/usr/bin:/bin:/usr/sbin:/sbin'
  const run = (
    command: string,
    input?: string,
    signal?: AbortSignal
  ): Promise<RemoteExecResult> => {
    records.push({ command, input })
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], {
        detached: true,
        env: { PATH: path, HOME: root },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      children.add(child)
      let stdout = ''
      let stderr = ''
      const abort = (): void => {
        try {
          process.kill(-child.pid!, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout.on('data', (bytes: Buffer) => {
        stdout += bytes.toString()
      })
      child.stderr.on('data', (bytes: Buffer) => {
        stderr += bytes.toString()
      })
      child.once('error', reject)
      child.once('close', (code, exitSignal) => {
        children.delete(child)
        signal?.removeEventListener('abort', abort)
        resolve({ stdout, stderr, code, signal: exitSignal })
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    })
  }
  const session: Required<Pick<RemoteSshSession, 'execWithInput' | 'execBounded'>> = {
    execWithInput: (command, input, options) => run(command, input, options?.signal),
    execBounded: async (command, options) => ({
      ...(await run(command, undefined, options.signal)),
      stdoutTruncated: false,
      stderrTruncated: false
    })
  }
  const startup: RpcStartupTransactionWriter = {
    addDirectory(directory) {
      mkdirSync(directory.path, { recursive: false, mode: 0o700 })
    },
    addFile(file) {
      writeFileSync(file.path, file.bytes, {
        mode: file.mode,
        flag: file.ifAbsent ? 'wx' : 'w'
      })
    }
  }
  return {
    root,
    runtimeRoot,
    projectRoot,
    agentDir: await generation(),
    generation,
    session,
    startup,
    records,
    setPath(value) {
      path = value
    },
    async cleanup() {
      for (const child of children) {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }
}
