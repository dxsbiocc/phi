import { isAbsolute, relative, resolve } from 'node:path'

export function isPathInsideRoot(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

/** Session cwd, Phi's own directory, and every saved local project the user already added. */
export function localFileAllowRoots(input: {
  agentDir: string
  sessionCwd: string
  sessionCwdRealPath?: string
  projectRoots?: readonly string[]
}): string[] {
  return [
    input.agentDir,
    input.sessionCwd,
    input.sessionCwdRealPath,
    ...(input.projectRoots ?? [])
  ].filter((root): root is string => typeof root === 'string' && root.length > 0)
}

export function isLocalFilePathAllowedByRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathInsideRoot(root, target))
}
