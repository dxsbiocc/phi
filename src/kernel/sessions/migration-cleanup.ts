import { readdir, rm, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { kernelSessionMigrationPaths } from './paths'
import type { SessionWriterLock } from './types'

export async function discardIncompleteMigrationLocked(
  paths: ReturnType<typeof kernelSessionMigrationPaths>,
  lock: SessionWriterLock
): Promise<void> {
  const lockName = basename(paths.lock)
  const entries = await readdir(paths.directory).catch(() => [])
  for (const entry of entries) {
    if (entry === lockName) continue
    await rm(join(paths.directory, entry), { recursive: true, force: true })
  }
  await lock.release()
  await rmdir(paths.directory).catch((error: unknown) => {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      String(error.code) !== 'ENOENT'
    ) {
      throw error
    }
  })
}
