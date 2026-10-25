import { createHash } from 'node:crypto'
import path from 'node:path'

export type KernelSocketPaths = {
  directory: string
  stem: string
  socketPath: string
  tokenFilePath: string
  lockFilePath: string
}

export function deriveKernelSocketPaths(
  runtimeRoot: string,
  kernelVersion: string,
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined
): KernelSocketPaths {
  if (!path.isAbsolute(runtimeRoot)) throw new Error('Kernel runtime root must be absolute')
  if (!kernelVersion) throw new Error('Kernel version must not be empty')
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Kernel socket paths require a valid OS user id')
  }
  const directory = `/tmp/phi-k-${uid}`
  const stem = createHash('sha256')
    .update(runtimeRoot)
    .update('\0')
    .update(kernelVersion)
    .digest('hex')
    .slice(0, 16)
  return {
    directory,
    stem,
    socketPath: path.join(directory, `${stem}.sock`),
    tokenFilePath: path.join(directory, `${stem}.token`),
    lockFilePath: path.join(directory, `${stem}.lock`)
  }
}
