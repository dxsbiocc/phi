import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * The Nextflow files a wrapper actually loads: its `wrapper/main.nf` and every
 * file reached through `include { ... } from '...'`, followed recursively.
 * Wrappers include vendored modules across the tree by relative path, so this
 * is the part of the bundle a run depends on.
 */

const INCLUDE = /include\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"]/g

function resolveInclude(fromFile: string, target: string): string | undefined {
  const base = resolve(dirname(fromFile), target)
  for (const candidate of [base, `${base}.nf`, join(base, 'main.nf')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/** Absolute paths of `mainNf` and every file it includes, each once, in visit order. */
export function collectIncludedFiles(mainNf: string): string[] {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(file, 'utf-8').matchAll(INCLUDE)) {
      const included = resolveInclude(file, match[1])
      if (included) visit(included)
    }
  }
  visit(resolve(mainNf))
  return [...seen]
}

/**
 * The bundle directories (POSIX, relative to `wrappersRoot`) a run of this
 * component reads: the component itself plus the directory of every included
 * file. Used to limit remote bundle verification to what the run uses.
 */
export function componentBundleScope(componentDir: string, wrappersRoot: string): string[] {
  const root = resolve(wrappersRoot)
  const toRelative = (dir: string): string | undefined => {
    const path = relative(root, dir)
    return path && !path.startsWith('..') ? path.split(sep).join('/') : undefined
  }
  const dirs = new Set<string>()
  const component = toRelative(resolve(componentDir))
  if (component) dirs.add(component)
  for (const file of collectIncludedFiles(join(componentDir, 'wrapper', 'main.nf'))) {
    const dir = toRelative(dirname(file))
    if (dir) dirs.add(dir)
  }
  // A directory inside another one in the set is already covered by it.
  return [...dirs]
    .filter((dir) => ![...dirs].some((other) => other !== dir && dir.startsWith(`${other}/`)))
    .sort()
}
