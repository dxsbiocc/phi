import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

/** Async traversal keeps prefix sizing out of the renderer-facing synchronous IPC path. */
export async function directorySize(path: string): Promise<number> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0
    throw error
  }
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size

  let total = stat.size
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) total += await directorySize(join(path, entry.name))
  return total
}
