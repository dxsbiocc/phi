import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ProjectPath = { ok: true; path: string } | { ok: false; error: string }

function nearestExisting(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/** Resolve `requested` against `root` and decide from real paths, so `..` and symlinks cannot escape. */
export function resolveInsideDirectory(root: string, requested: string, what: string): ProjectPath {
  const target = resolve(root, requested)
  const realRoot = realpathSync(root)
  const anchor = nearestExisting(target)
  const realTarget = join(realpathSync(anchor), relative(anchor, target))
  const inside = relative(realRoot, realTarget)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return { ok: false, error: `${what} must be inside ${root}; got ${requested}.` }
  }
  return { ok: true, path: target }
}

export function resolveInsideProject(cwd: string, requested: string, what: string): ProjectPath {
  const resolved = resolveInsideDirectory(cwd, requested, what)
  if (resolved.ok) return resolved
  return {
    ok: false,
    error: `${what} must be inside the project directory (${cwd}); got ${requested}.`
  }
}
