import { posix } from 'node:path'

/** Canonical POSIX containment; a sibling prefix is never a child directory. */
export function isRemotePathInside(root: string, target: string): boolean {
  const relative = posix.relative(root, target)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  )
}
