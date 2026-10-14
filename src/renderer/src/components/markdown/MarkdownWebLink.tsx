import { Box, Link, Tooltip } from '@mui/material'
import { useRef, type MouseEvent, type ReactNode } from 'react'
import { FaGithub } from 'react-icons/fa'
import { FiGlobe } from 'react-icons/fi'
import { PhiIcons } from '../../icons'
import { describeWebLink, openWebUrlFromClick } from '../../lib/markdownWebLinks'
import { textFromNode } from '../../lib/markdownText'
import { InlineLinkMenu, type InlineLinkMenuAction } from './InlineLinkMenu'
import { inlineLinkLabelSx, useInlineLinkMenu } from './useInlineLinkMenu'
import { WebLinkHoverCard } from './WebLinkHoverCard'

export function MarkdownWebLink({
  href,
  children,
  onOpenWebUrl
}: {
  href?: string
  children: ReactNode
  onOpenWebUrl?: (url: string) => void
}): React.JSX.Element {
  const anchorRef = useRef<HTMLAnchorElement | null>(null)
  const text = textFromNode(children)
  const presentation = href ? describeWebLink(href, text) : null
  const interactions = useInlineLinkMenu(href ?? '')
  const opensInApp = Boolean(presentation && onOpenWebUrl)
  const openLink = (): void => {
    interactions.tooltip.onClose()
    if (!href) return
    if (onOpenWebUrl) onOpenWebUrl(href)
    else anchorRef.current?.click()
  }
  const actions: InlineLinkMenuAction[] =
    href && presentation
      ? [
          {
            id: 'open',
            label: opensInApp ? '在 Phi 中打开' : '打开链接',
            icon: <FiGlobe aria-hidden size={16} />,
            onSelect: openLink
          },
          {
            id: 'copy-url',
            label: '复制链接地址',
            icon: <PhiIcons.action.copy sx={{ fontSize: 16 }} />,
            onSelect: () => navigator.clipboard.writeText(href)
          },
          {
            id: 'copy-text',
            label: '复制显示文本',
            icon: <PhiIcons.action.copy sx={{ fontSize: 16 }} />,
            onSelect: () => navigator.clipboard.writeText(presentation.label)
          }
        ]
      : []

  return (
    <>
      <Tooltip
        describeChild
        title={
          presentation && href ? (
            <WebLinkHoverCard
              url={href}
              label={presentation.label}
              site={presentation.site}
              active={interactions.tooltip.open}
              onOpen={openLink}
            />
          ) : (
            ''
          )
        }
        placement="top-start"
        enterDelay={350}
        leaveDelay={150}
        slotProps={{
          tooltip: {
            sx: {
              p: 0,
              bgcolor: 'background.paper',
              borderRadius: 2,
              boxShadow: 3,
              maxWidth: 'none'
            }
          }
        }}
        {...interactions.tooltip}
      >
        <Link
          ref={anchorRef}
          href={href}
          target="_blank"
          rel="noreferrer"
          data-phi-open-web-url={opensInApp ? 'in-app' : undefined}
          data-phi-web-link-site={presentation?.site}
          aria-description={presentation ? href : undefined}
          aria-haspopup={presentation ? 'menu' : undefined}
          aria-controls={interactions.position ? interactions.menuId : undefined}
          aria-expanded={presentation ? interactions.position !== null : undefined}
          onContextMenu={presentation ? interactions.onContextMenu : undefined}
          onKeyDown={presentation ? interactions.onKeyDown : undefined}
          onClick={
            presentation
              ? (event: MouseEvent<HTMLAnchorElement>) => {
                  interactions.tooltip.onClose()
                  if (!href || !onOpenWebUrl) return
                  openWebUrlFromClick(href, event, onOpenWebUrl)
                }
              : undefined
          }
          sx={{
            color: 'primary.light',
            ...(presentation
              ? {
                  display: 'inline-flex',
                  alignItems: 'center',
                  verticalAlign: 'baseline',
                  maxWidth: '100%',
                  gap: 0.4,
                  font: 'inherit'
                }
              : {})
          }}
        >
          {presentation ? (
            <>
              {presentation.site === 'github' ? (
                <FaGithub aria-hidden size={16} style={{ flexShrink: 0 }} />
              ) : (
                <FiGlobe aria-hidden size={16} style={{ flexShrink: 0 }} />
              )}
              <Box component="span" sx={inlineLinkLabelSx}>
                {presentation.label === text ? children : presentation.label}
              </Box>
            </>
          ) : (
            children
          )}
        </Link>
      </Tooltip>
      <InlineLinkMenu
        id={interactions.menuId}
        kind="web"
        position={interactions.position}
        actions={actions}
        onClose={interactions.closeMenu}
      />
    </>
  )
}
