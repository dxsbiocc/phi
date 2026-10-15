import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** All parts are Phi-owned names. Server locators must never reach this local store. */
export function recoveryFile(agentDir: string, parts: readonly string[], create: boolean): string {
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9_-]+(?:\.json)?$/.test(part)))
    throw new Error('Invalid recovery store path')
  if (create) mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  let directory = realpathSync(agentDir)
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part)
    if (create) {
      try {
        mkdirSync(directory, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('Invalid recovery store directory')
  }
  return join(directory, parts.at(-1)!)
}

export function readRecoveryFile(path: string, maxBytes = 16 * 1024): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid recovery store file')
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const received = readSync(fd, bytes, length, bytes.length - length, length)
      if (!received) break
      length += received
    }
    if (length > maxBytes) throw new Error('Recovery store byte limit')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  } finally {
    closeSync(fd)
  }
}

export function writeRecoveryFile(path: string, value: unknown, maxBytes = 16 * 1024): void {
  const text = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Recovery store byte limit')
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
