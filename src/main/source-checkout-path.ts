import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// A packaged bundle lives inside app.asar (or app.asar.unpacked). Its working directory is
// wherever the user launched the app, so a source tree found there must never replace it.
export function isPackagedBundleDir(bundleDir: string): boolean {
  return bundleDir.split(/[\\/]/u).some((segment) => /\.asar(?:\.unpacked)?$/u.test(segment))
}

/** Outside Electron, a worker must use its real unpacked file rather than an ASAR path. */
export function externalWorkerPath(path: string): string {
  const parts = path.split(/([\\/])/u)
  const archive = parts.lastIndexOf('app.asar')
  if (archive < 0 || archive === parts.length - 1) return path
  parts[archive] = 'app.asar.unpacked'
  return parts.join('')
}

export function findExternalWorkerScript(
  candidates: readonly string[],
  exists: (path: string) => boolean = existsSync
): string | undefined {
  return candidates.map(externalWorkerPath).find(exists)
}

export function sourceCheckoutPath(
  relativePath: string,
  bundleDir: string,
  options: { cwd?: string; exists?: (path: string) => boolean } = {}
): string | null {
  if (isPackagedBundleDir(bundleDir)) return null
  const path = resolve(options.cwd ?? process.cwd(), relativePath)
  return (options.exists ?? existsSync)(path) ? path : null
}
