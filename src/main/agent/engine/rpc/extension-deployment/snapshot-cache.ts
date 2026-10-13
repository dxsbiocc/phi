import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const writes = new Map<string, Promise<void>>()

async function privateEntry(path: string, directory: boolean): Promise<void> {
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    (directory ? !metadata.isDirectory() : !metadata.isFile() || metadata.nlink !== 1) ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw new Error(`Unsafe Phi extension cache entry: ${path}`)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  )
  try {
    const current = await handle.stat()
    if (current.dev !== metadata.dev || current.ino !== metadata.ino)
      throw new Error(`Changed Phi extension cache entry: ${path}`)
    await handle.chmod(directory ? 0o700 : 0o600)
  } finally {
    await handle.close()
  }
}

async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await privateEntry(path, true)
}

/** Stable private snapshots retain the transfer manager's inode-based resume identity. */
export async function cacheExtensionSnapshot(
  cacheDir: string,
  bytes: Buffer,
  sha256: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  if (!isAbsolute(cacheDir)) throw new Error('Phi extension cache directory must be absolute')
  const selected = resolve(cacheDir)
  await privateDirectory(selected, true)
  const root = await realpath(selected)
  const directory = join(root, 'phi-extension-snapshots')
  await privateDirectory(directory)
  const path = join(directory, sha256)
  const previous = writes.get(path) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => done)
  writes.set(path, current)
  try {
    await previous
    signal?.throwIfAborted()
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing) {
      await privateEntry(path, false)
      if (existing.size === bytes.length) {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          if (
            createHash('sha256')
              .update(await handle.readFile())
              .digest('hex') === sha256
          )
            return path
        } finally {
          await handle.close()
        }
      }
    }
    const temporary = join(directory, `.snapshot-${randomUUID()}`)
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      signal?.throwIfAborted()
      await rename(temporary, path)
      return path
    } finally {
      await rm(temporary, { force: true })
    }
  } finally {
    release()
    if (writes.get(path) === current) writes.delete(path)
  }
}
