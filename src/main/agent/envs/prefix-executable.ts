import { existsSync } from 'node:fs'
import { join } from 'node:path'

function windowsFileName(name: string): string {
  return /\.[A-Za-z0-9]+$/u.test(name) ? name : `${name}.exe`
}

/**
 * Conda prefix layout for an executable. Unix prefixes keep everything in
 * `bin/`. Windows prefixes put `python.exe` at the root and console scripts
 * such as `jupyter.exe` in `Scripts/`.
 */
export function prefixExecutable(
  prefix: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return join(prefix, 'bin', name)
  const fileName = windowsFileName(name)
  const candidates = [
    join(prefix, fileName),
    join(prefix, 'Scripts', fileName),
    join(prefix, 'Library', 'bin', fileName)
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  if (name === 'python' || name === 'python3') return candidates[0]
  return candidates[1]
}
