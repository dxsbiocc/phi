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
