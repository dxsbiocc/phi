import { findBunExecutable, type BunLookupOptions } from '../agent/omp/bun-executable'

export type BunExecutableFileExists = (path: string) => boolean

export class BunExecutableNotFoundError extends Error {
  constructor() {
    super('Bun executable was not found')
    this.name = 'BunExecutableNotFoundError'
  }
}

export type TerminalBunLookupOptions = Omit<BunLookupOptions, 'env' | 'isExecutableFile'>

/** Resolve Bun without relying on the sparse PATH inherited by Finder-launched apps. */
export function resolveBunExecutable(
  env: NodeJS.ProcessEnv,
  fileExists?: BunExecutableFileExists,
  options: TerminalBunLookupOptions = {}
): string {
  const found = findBunExecutable({
    ...options,
    env,
    ...(fileExists ? { isExecutableFile: fileExists } : {})
  })
  if (found) return found
  throw new BunExecutableNotFoundError()
}
