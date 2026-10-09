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

export function shouldRestoreRememberedTreeScroll(
  revealTarget: string,
  alreadyRestored: boolean
): boolean {
  return !revealTarget && !alreadyRestored
}

export function shouldAutoRevealTreePath(
  revealTarget: string,
  previousTarget: string,
  layoutKey: string,
  previousLayoutKey: string
): boolean {
  return (
    Boolean(revealTarget) && (revealTarget !== previousTarget || layoutKey !== previousLayoutKey)
  )
}

export function fileTreeRevealScrollCorrection(options: {
  containerTop: number
  containerHeight: number
  targetTop: number
  targetHeight: number
}): number {
  const containerCenter = options.containerTop + options.containerHeight / 2
  const targetCenter = options.targetTop + options.targetHeight / 2
  return targetCenter - containerCenter
}

export type TreeDirectoryCandidate = { name: string; path: string }
export type ListTreeDirectories = (path: string) => Promise<readonly TreeDirectoryCandidate[]>

function isSubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return false
}

function fuzzyDirectoryMatch(
  segment: string,
  candidates: readonly TreeDirectoryCandidate[]
): TreeDirectoryCandidate | null {
  const query = segment.toLocaleLowerCase()
  const ranked = candidates
    .map((candidate, index) => {
      const name = candidate.name.toLocaleLowerCase()
      const tier =
        candidate.name === segment
          ? 0
          : name === query
            ? 1
            : name.startsWith(query)
              ? 2
              : name.includes(query)
                ? 3
                : isSubsequence(query, name)
                  ? 4
                  : null
      return tier === null ? null : { candidate, index, tier }
    })
    .filter(
      (item): item is { candidate: TreeDirectoryCandidate; index: number; tier: number } =>
        item !== null
    )
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
  return ranked[0]?.candidate ?? null
}

export async function resolveFuzzyTreePath(
  inputPath: string,
  listDirectories: ListTreeDirectories
): Promise<string> {
  const normalized = normalizeAbsoluteTreePath(inputPath)
  if (!normalized) return ''
  const segments = normalized.split('/').filter(Boolean)
  let current = '/'
  for (const segment of segments) {
    const match = fuzzyDirectoryMatch(segment, await listDirectories(current))
    if (!match) return current
    const resolved = normalizeAbsoluteTreePath(match.path)
    if (!resolved) return current
    current = resolved
  }
  return current
}
