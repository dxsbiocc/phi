import { Link } from '@mui/material'
import type { MouseEvent, ReactNode } from 'react'
import { isHttpWebUrl, openWebUrlFromClick } from '../../lib/markdownWebLinks'

export function MarkdownWebLink({
  href,
  children,
  onOpenWebUrl
}: {
  href?: string
  children: ReactNode
  onOpenWebUrl?: (url: string) => void
}): React.JSX.Element {
  const opensInApp = typeof href === 'string' && Boolean(onOpenWebUrl) && isHttpWebUrl(href)

  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      data-phi-open-web-url={opensInApp ? 'in-app' : undefined}
      onClick={
        opensInApp
          ? (event: MouseEvent<HTMLAnchorElement>) => {
              if (!href || !onOpenWebUrl) return
              openWebUrlFromClick(href, event, onOpenWebUrl)
            }
          : undefined
      }
      sx={{ color: 'primary.light' }}
    >
      {children}
    </Link>
  )
}
