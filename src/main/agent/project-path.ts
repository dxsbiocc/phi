import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ProjectPath = { ok: true; path: string } | { ok: false; error: string }

/** The deepest ancestor of `path` (or `path` itself) that exists. */
function nearestExisting(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Resolves `requested` (absolute, or relative to the project) and checks it is inside the
 * project directory. Symbolic links are followed for the part of the path that exists, so a
 * link that leads out of the project does not count as inside it.
 */
export function resolveInsideProject(cwd: string, requested: string, what: string): ProjectPath {
  const target = resolve(cwd, requested)
  const realCwd = realpathSync(cwd)
  const anchor = nearestExisting(target)
  const realTarget = join(realpathSync(anchor), relative(anchor, target))
  const inside = relative(realCwd, realTarget)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return {
      ok: false,
      error: `${what} must be inside the project directory (${cwd}); got ${requested}. Data files elsewhere can be read, but everything written goes in the project.`
    }
  }
  return { ok: true, path: target }
}
