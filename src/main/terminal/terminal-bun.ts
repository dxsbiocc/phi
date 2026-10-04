import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type BunExecutableFileExists = (path: string) => boolean

export class BunExecutableNotFoundError extends Error {
  constructor() {
    super('Bun executable was not found')
    this.name = 'BunExecutableNotFoundError'
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve Bun without relying on the sparse PATH inherited by Finder-launched apps. */
export function resolveBunExecutable(
  env: NodeJS.ProcessEnv,
  fileExists: BunExecutableFileExists = isExecutable
): string {
  const candidates: string[] = []
  const add = (candidate: string | undefined): void => {
    if (candidate && isAbsolute(candidate) && !candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }

  add(env.PHI_BUN_PATH)
  if (env.BUN_INSTALL) add(join(env.BUN_INSTALL, 'bin', 'bun'))
  if (env.HOME) add(join(env.HOME, '.bun', 'bin', 'bun'))
  add('/opt/homebrew/bin/bun')
  add('/usr/local/bin/bun')
  for (const entry of env.PATH?.split(delimiter) ?? []) {
    if (entry) add(join(entry, 'bun'))
  }

  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate
  }
  throw new BunExecutableNotFoundError()
}
