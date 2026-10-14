export type WebLinkClick = {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  preventDefault: () => void
}

export function isHttpWebUrl(href: string): boolean {
  try {
    const protocol = new URL(href).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const githubNonRepositoryRoutes = new Set([
  'about',
  'account',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'join',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'readme',
  'search',
  'security',
  'sessions',
  'settings',
  'site',
  'solutions',
  'sponsors',
  'topics',
  'users'
])

export function describeWebLink(
  href: string,
  text: string
): { site: 'github' | 'web'; label: string } | null {
  if (!isHttpWebUrl(href)) return null
  const url = new URL(href)
  const site = ['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())
    ? 'github'
    : 'web'
  const label = text.trim() ? text : href
  const rawLabels = [
    href,
    url.href,
    href.replace(/^https?:\/\//i, ''),
    url.href.replace(/^https?:\/\//i, '')
  ]
  if (site !== 'github' || !rawLabels.includes(text.trim())) return { site, label }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2 || githubNonRepositoryRoutes.has(segments[0].toLowerCase())) {
    return { site, label }
  }
  try {
    const owner = decodeURIComponent(segments[0])
    const repository = decodeURIComponent(segments[1]).replace(/\.git$/i, '')
    const invalidName = Array.from(owner + repository).some(
      (character) =>
        character === '/' ||
        character === '\\' ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127
    )
    if (!owner || !repository || invalidName) {
      return { site, label }
    }
    return { site, label: `${owner}/${repository}` }
  } catch {
    return { site, label }
  }
}

export function openWebUrlFromClick(
  href: string,
  event: WebLinkClick,
  onOpenWebUrl: (url: string) => void
): boolean {
  if (
    !isHttpWebUrl(href) ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return false
  }

  event.preventDefault()
  onOpenWebUrl(href)
  return true
}
