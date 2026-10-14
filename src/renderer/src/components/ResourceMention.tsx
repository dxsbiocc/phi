import { Fragment, useMemo, type ReactNode } from 'react'
import { Box } from '@mui/material'
import { PhiIcons } from '../icons'
import { createChatResourceMatcher, type ChatResourceMention } from '../lib/chatResourceMentions'
import {
  ChatResourceMentionsContext,
  useChatResourceMatcher
} from '../lib/chatResourceMentionContext'
import { ResourceIcon } from './ResourceIcon'
import { InlineLinkMenu, type InlineLinkMenuAction } from './markdown/InlineLinkMenu'
import { inlineLinkLabelSx, useInlineLinkMenu } from './markdown/useInlineLinkMenu'

export function ResourceMentionsProvider({
  resources,
  children
}: {
  resources: readonly ChatResourceMention[]
  children?: ReactNode
}): React.JSX.Element {
  const matcher = useMemo(() => createChatResourceMatcher(resources), [resources])
  return (
    <ChatResourceMentionsContext.Provider value={matcher}>
      {children}
    </ChatResourceMentionsContext.Provider>
  )
}

export function ResourceMention({
  resource,
  inheritColor = false
}: {
  resource: ChatResourceMention
  inheritColor?: boolean
}): React.JSX.Element {
  const interactions = useInlineLinkMenu(`${resource.kind}:${resource.id}`)
  const actions: InlineLinkMenuAction[] = [
    {
      id: 'copy',
      label: '复制',
      icon: <PhiIcons.action.copy sx={{ fontSize: 16 }} />,
      onSelect: () => navigator.clipboard.writeText(resource.name)
    },
    {
      id: 'details',
      label: '查看详情',
      icon: <PhiIcons.action.openDefault sx={{ fontSize: 16 }} />,
      disabled: !resource.onOpen,
      onSelect: () => resource.onOpen?.()
    }
  ]
  return (
    <>
      <Box
        component={resource.onOpen ? 'button' : 'span'}
        type={resource.onOpen ? 'button' : undefined}
        onClick={resource.onOpen}
        onContextMenu={interactions.onContextMenu}
        onKeyDown={interactions.onKeyDown}
        tabIndex={resource.onOpen ? undefined : 0}
        aria-haspopup="menu"
        aria-controls={interactions.position ? interactions.menuId : undefined}
        aria-expanded={interactions.position !== null}
        data-phi-resource-mention={resource.kind}
        data-phi-resource-id={resource.id}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.4,
          verticalAlign: 'baseline',
          maxWidth: '100%',
          mx: 0.1,
          p: 0,
          border: 0,
          borderRadius: 0.5,
          bgcolor: 'transparent',
          color: inheritColor ? 'inherit' : 'primary.main',
          font: 'inherit',
          fontWeight: 600,
          lineHeight: 'inherit',
          textAlign: 'left',
          whiteSpace: 'nowrap',
          cursor: resource.onOpen ? 'pointer' : 'inherit',
          '&:hover': resource.onOpen ? { textDecoration: 'underline' } : {},
          '&:focus-visible': { outline: '2px solid currentColor', outlineOffset: 2 }
        }}
      >
        <ResourceIcon
          component="span"
          kind={resource.kind}
          icon={resource.icon}
          size={18}
          fallbackSize={16}
        />
        <Box component="span" sx={inlineLinkLabelSx}>
          {resource.name}
        </Box>
      </Box>
      <InlineLinkMenu
        id={interactions.menuId}
        kind="resource"
        position={interactions.position}
        actions={actions}
        onClose={interactions.closeMenu}
      />
    </>
  )
}

export function ResourceMentionText({
  text,
  inheritColor = false,
  protectCode = false
}: {
  text: string
  inheritColor?: boolean
  protectCode?: boolean
}): React.JSX.Element {
  const matcher = useChatResourceMatcher()
  const render = (value: string, prefix: number): ReactNode =>
    matcher
      .tokenize(value)
      .map((token, index) =>
        token.kind === 'resource' ? (
          <ResourceMention
            key={`${prefix}-${index}`}
            resource={token.resource}
            inheritColor={inheritColor}
          />
        ) : (
          token.text
        )
      )
  if (!protectCode) return <>{render(text, 0)}</>
  const parts: ReactNode[] = []
  const code = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2/g
  let end = 0
  for (const match of text.matchAll(code)) {
    const start = match.index
    parts.push(<Fragment key={end}>{render(text.slice(end, start), end)}</Fragment>, match[0])
    end = start + match[0].length
  }
  parts.push(<Fragment key={end}>{render(text.slice(end), end)}</Fragment>)
  return <>{parts}</>
}
