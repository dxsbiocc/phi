import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = 'assistant-inbox-writer.sqlite'

function isBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === 5
  )
}

function lockPathFor(directory: string): string {
  const root = lstatSync(directory)
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error('Inbox root must be a real directory')
  }
  if (process.platform !== 'win32' && (root.mode & 0o077) !== 0) {
    throw new Error('Inbox root must be private')
  }
  const path = join(directory, DB_FILE)
  try {
    const file = lstatSync(path)
    if (file.isSymbolicLink() || !file.isFile() || file.nlink !== 1) {
      throw new Error('Inbox lock must be one regular file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return path
}

/** Retain the handle until the inbox has stopped accepting work and drained its writes. */
export function tryAcquireAssistantInboxWriter(directory: string): { release(): void } | null {
  const lockPath = lockPathFor(resolve(directory))
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(lockPath)
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
  } catch (error) {
    db?.close()
    if (isBusy(error)) return null
    throw error
  }
  const database = db
  let released = false
  return {
    release() {
      if (released) return
      database.close()
      released = true
    }
  }
}
