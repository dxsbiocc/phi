export function normalizeAbsoluteTreePath(value: string): string | null {
  if (!value.startsWith('/') || value.includes('\0')) return null
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export function fileTreeRevealPaths(rootPath: string, targetPath: string): string[] {
  const root = normalizeAbsoluteTreePath(rootPath)
  const target = normalizeAbsoluteTreePath(targetPath)
  if (!root || !target) return []
  if (root !== '/' && target !== root && !target.startsWith(`${root}/`)) return []

  const relative = root === '/' ? target.slice(1) : target.slice(root.length + 1)
  const paths = [root]
  let current = root
  for (const segment of relative.split('/').filter(Boolean)) {
    current = current === '/' ? `/${segment}` : `${current}/${segment}`
    paths.push(current)
  }
  return paths
}
