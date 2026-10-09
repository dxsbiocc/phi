import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SshAskpassSecretPipe {
  close(): Promise<void>
}

export interface SshAskpassFileSystem {
  createDirectory(prefix: string): Promise<string>
  writeFile(path: string, content: string, mode: number): Promise<void>
  createSecretPipe(path: string, content: Buffer, mode: number): Promise<SshAskpassSecretPipe>
  remove(path: string): Promise<void>
}

export interface SshAskpassContext {
  env: Readonly<Record<string, string>>
}

const ASKPASS_SCRIPT = `#!/bin/sh
dd if="$PHI_SSH_ASKPASS_PIPE" bs=1 count="$PHI_SSH_ASKPASS_BYTES" 2>/dev/null
printf '\\n'
`

export function createNodeSshAskpassFileSystem(tempRoot = tmpdir()): SshAskpassFileSystem {
  return {
    async createDirectory(prefix) {
      const directory = await mkdtemp(join(tempRoot, prefix))
      await chmod(directory, 0o700)
      return directory
    },
    async writeFile(path, content, mode) {
      await writeFile(path, content, { encoding: 'utf8', mode, flag: 'wx' })
      await chmod(path, mode)
    },
    async createSecretPipe(path, content, mode) {
      await execFileAsync('mkfifo', [path], { timeout: 3_000 })
      await chmod(path, mode)
      const handle = await open(path, constants.O_RDWR)
      try {
        await handle.writeFile(content)
      } catch (error) {
        await handle.close().catch(() => undefined)
        throw error
      }
      return { close: () => handle.close() }
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true })
    }
  }
}

/**
 * OpenSSH closes inherited non-stdio file descriptors before invoking askpass. A protected named
 * pipe keeps the secret out of argv, files, and the long-lived SSH process environment while still
 * letting separately spawned askpass helpers read it. The FIFO and helper are removed in finally.
 */
export async function withSshAskpass<T>(
  secret: string,
  files: SshAskpassFileSystem,
  action: (context: SshAskpassContext) => Promise<T>,
  options: { promptCount?: number } = {}
): Promise<T> {
  if (/\0|\r|\n/.test(secret) || Buffer.byteLength(secret) > 4_096) {
    throw new Error('SSH 凭据格式无效')
  }
  const promptCount = options.promptCount ?? 1
  if (!Number.isInteger(promptCount) || promptCount < 1 || promptCount > 3) {
    throw new Error('SSH askpass 次数无效')
  }
  const directory = await files.createDirectory('phi-ssh-askpass-')
  const helperPath = join(directory, 'askpass.sh')
  const pipePath = join(directory, 'secret.pipe')
  const secretBytes = Buffer.from(secret)
  let pipePayload: Buffer | undefined
  let pipe: SshAskpassSecretPipe | undefined
  try {
    await files.writeFile(helperPath, ASKPASS_SCRIPT, 0o700)
    pipePayload = Buffer.concat(Array.from({ length: promptCount }, () => secretBytes))
    pipe = await files.createSecretPipe(pipePath, pipePayload, 0o600)
    pipePayload.fill(0)
    return await action({
      env: {
        SSH_ASKPASS: helperPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: 'phi-ssh-askpass:0',
        PHI_SSH_ASKPASS_PIPE: pipePath,
        PHI_SSH_ASKPASS_BYTES: String(secretBytes.length)
      }
    })
  } finally {
    secretBytes.fill(0)
    pipePayload?.fill(0)
    await pipe?.close().catch(() => undefined)
    await files.remove(directory)
  }
}
