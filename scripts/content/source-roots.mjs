/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const phiSourceRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Canonical content checkout; an explicit source also supports isolated test repositories. */
export function packageSourceRoot(source, phiRoot = phiSourceRoot) {
  const configured = process.env.PHI_PACKAGES_ROOT?.trim() || undefined
  return resolve(source ?? configured ?? join(dirname(phiRoot), 'phi-packages'))
}

export function requireSourceDirectory(sourceRoot, relativePath) {
  const directory = join(sourceRoot, relativePath)
  try {
    if (statSync(directory).isDirectory()) return directory
  } catch {
    // Report the selected checkout rather than leaking an incidental ENOENT stack.
  }
  throw new Error(
    `Content directory not found: ${directory}. Clone phi-packages beside Phi or pass --source <checkout>.`
  )
}

export function requirePackageSourceRoot(source) {
  const root = packageSourceRoot(source)
  requireSourceDirectory(root, 'resources')
  return root
}

/** Core checks use Phi unless the caller explicitly selects package content. */
export function parseContentSourceArgs(argv, { defaultToPackages = false } = {}) {
  let source
  let packages = defaultToPackages
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--packages') packages = true
    else if (arg === '--source') {
      source = argv[++index]
      if (!source || source.startsWith('--')) throw new Error('--source requires a checkout')
      packages = true
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return packages ? requirePackageSourceRoot(source) : phiSourceRoot
}
