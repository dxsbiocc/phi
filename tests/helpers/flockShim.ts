import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** macOS lacks the Linux utility; exercise the same native fd lock through stdlib fcntl. */
export function installFlockShim(directory: string): () => void {
  try {
    execFileSync('sh', ['-c', 'command -v flock'], { stdio: 'ignore' })
    return () => undefined
  } catch {
    /* A test-only adapter, never uploaded to a server. */
  }
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'flock')
  writeFileSync(
    path,
    `#!/usr/bin/env python3
import fcntl, sys
try:
    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)
`
  )
  chmodSync(path, 0o700)
  const previous = process.env.PATH
  process.env.PATH = `${directory}:${previous ?? '/usr/bin:/bin'}`
  return () => {
    process.env.PATH = previous
  }
}
