import type { ReactNode } from 'react'
import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { BrowserTabSnapshot } from '../../../../../shared/browserTypes'
import { PhiIcons } from '../../../icons'
import { workspacePanelActionSize, workspacePanelHeaderHeight } from '../../../layout'
import { browserTabDisplayTitle, isBrowserTabActivationKey } from '../lib/browserPanelState'

const AddIcon = PhiIcons.action.add
const CloseIcon = PhiIcons.action.close
const WebIcon = PhiIcons.tool.web

export interface BrowserTabsProps {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  disabled: boolean
  headerActions?: ReactNode
  onNewTab(): void
  onActivate(tabId: string): void
  onClose(tabId: string): void
}

export function BrowserTabs(props: BrowserTabsProps): React.JSX.Element {
  return (
    <Box
      data-phi-browser-tabs="true"
      sx={{
        flexShrink: 0,
        minWidth: 0,
        height: workspacePanelHeaderHeight,
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        px: 1,
        bgcolor: 'background.paper',
        WebkitAppRegion: 'drag'
      }}
    >
      <Box
        role="tablist"
        aria-label="浏览器标签页"
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          overflowX: 'auto',
          WebkitAppRegion: 'no-drag',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' }
        }}
      >
        {props.tabs.length === 0 ? (
          <Typography
            component="span"
            data-phi-browser-empty-tab-title="true"
            sx={{ px: 1, fontSize: 13, fontWeight: 600, color: 'text.secondary' }}
          >
            新标签页
          </Typography>
        ) : null}
        {props.tabs.map((tab, index) => {
          const selected = tab.id === props.activeTabId
          const fallbackTabStop = props.activeTabId === null && index === 0
          const label = browserTabDisplayTitle(tab)
          return (
            <Box
              key={tab.id}
              data-phi-browser-tab={selected ? 'active' : 'inactive'}
              sx={{
                flex: props.tabs.length === 1 ? '1 1 0' : '0 0 clamp(120px, 32vw, 180px)',
                minWidth: props.tabs.length === 1 ? 0 : 120,
                maxWidth: props.tabs.length === 1 ? 'none' : 180,
                height: workspacePanelHeaderHeight,
                minHeight: workspacePanelHeaderHeight,
                minInlineSize: 0,
                display: 'flex',
                alignItems: 'center',
                pr: 0.25,
                border: 0,
                boxShadow: selected
                  ? (theme) => `inset 0 -2px 0 ${theme.palette.primary.main}`
                  : 'none',
                borderRadius: 0.5,
                bgcolor: 'transparent',
                color: selected ? 'text.primary' : 'text.secondary',
                transition: 'background-color 120ms ease, color 120ms ease',
                '&:hover': {
                  bgcolor: 'action.hover',
                  color: 'text.primary'
                }
              }}
            >
              <Box
                component="div"
                role="tab"
                tabIndex={selected || fallbackTabStop ? 0 : -1}
                aria-selected={selected}
                aria-disabled={props.disabled || undefined}
                aria-controls="phi-browser-viewport"
                title={tab.url && tab.url !== 'about:blank' ? tab.url : label}
                onClick={() => {
                  if (!props.disabled && !selected) props.onActivate(tab.id)
                }}
                onKeyDown={(event) => {
                  if (isBrowserTabActivationKey(event.key)) {
                    event.preventDefault()
                    if (!props.disabled && !selected) props.onActivate(tab.id)
                    return
                  }
                  if (
                    event.key === 'ArrowLeft' ||
                    event.key === 'ArrowRight' ||
                    event.key === 'Home' ||
                    event.key === 'End'
                  ) {
                    event.preventDefault()
                    const tabs = Array.from(
                      event.currentTarget
                        .closest('[role="tablist"]')
                        ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
                    )
                    const currentIndex = tabs.indexOf(event.currentTarget)
                    const nextIndex =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : event.key === 'ArrowLeft'
                            ? (currentIndex - 1 + tabs.length) % tabs.length
                            : (currentIndex + 1) % tabs.length
                    tabs[nextIndex]?.focus()
                  }
                }}
                sx={{
                  flex: 1,
                  alignSelf: 'stretch',
                  minWidth: 0,
                  minHeight: workspacePanelHeaderHeight,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  pl: 1,
                  cursor: props.disabled || selected ? 'default' : 'pointer',
                  borderRadius: 1.1,
                  '&:focus-visible': {
                    outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                    outlineOffset: -2
                  }
                }}
              >
                <Box
                  component="span"
                  sx={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: selected ? 'primary.main' : 'text.disabled'
                  }}
                >
                  {tab.phase === 'loading' ? (
                    <CircularProgress
                      size={13}
                      thickness={5}
                      aria-label={`正在加载 ${label}`}
                      sx={{ color: 'primary.main' }}
                    />
                  ) : (
                    <WebIcon aria-hidden="true" sx={{ fontSize: 15 }} />
                  )}
                </Box>
                <Typography
                  component="span"
                  noWrap
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: selected ? 700 : 500,
                    lineHeight: 1.3
                  }}
                >
                  {label}
                </Typography>
              </Box>
              <Tooltip title={`关闭 ${label}`} arrow>
                <span style={{ display: 'inline-flex', flexShrink: 0 }}>
                  <IconButton
                    type="button"
                    aria-label={`关闭 ${label}`}
                    disabled={props.disabled}
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onClose(tab.id)
                    }}
                    onKeyDown={(event) => {
                      if (isBrowserTabActivationKey(event.key)) event.stopPropagation()
                    }}
                    sx={{
                      width: workspacePanelActionSize,
                      height: workspacePanelActionSize,
                      p: 0.5,
                      borderRadius: 1,
                      color: 'text.secondary',
                      opacity: selected ? 0.78 : 0.5,
                      '&:hover, &:focus-visible': {
                        opacity: 1,
                        color: 'text.primary',
                        bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08)
                      },
                      '&.Mui-focusVisible': {
                        outline: '2px solid',
                        outlineColor: 'primary.main',
                        outlineOffset: -2
                      }
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          )
        })}
      </Box>
      <Tooltip title="新建标签页" arrow>
        <span style={{ display: 'inline-flex', flexShrink: 0 }}>
          <IconButton
            type="button"
            aria-label="新建标签页"
            disabled={props.disabled}
            size="small"
            onClick={props.onNewTab}
            sx={{
              width: workspacePanelActionSize,
              height: workspacePanelActionSize,
              p: 0.5,
              borderRadius: 1,
              WebkitAppRegion: 'no-drag',
              '&.Mui-focusVisible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: -2
              }
            }}
          >
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </span>
      </Tooltip>
      {props.headerActions ? (
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {props.headerActions}
        </Box>
      ) : null}
    </Box>
  )
}
