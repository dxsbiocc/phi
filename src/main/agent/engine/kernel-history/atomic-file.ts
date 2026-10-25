import { randomUUID } from 'node:crypto'
import { chmod, lstat, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

function fsCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
    await chmod(path, mode)
    await syncDirectory(dirname(path))
    published = true
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected a regular file: ${path}`)
  }
}

export function isMissingFile(error: unknown): boolean {
  return fsCode(error) === 'ENOENT'
}
