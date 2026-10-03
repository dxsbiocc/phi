import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { BrowserTabSnapshot } from '../../../../../shared/browserTypes'
import { PhiIcons } from '../../../icons'
import { browserTabDisplayTitle, isBrowserTabActivationKey } from '../lib/browserPanelState'

const AddIcon = PhiIcons.action.add
const CloseIcon = PhiIcons.action.close
const WebIcon = PhiIcons.tool.web

export interface BrowserTabsProps {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  disabled: boolean
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
        height: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: 0.75,
        bgcolor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider'
      }}
    >
      <Box
        role="tablist"
        aria-label="浏览器标签页"
        sx={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          overflowX: 'auto',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' }
        }}
      >
        {props.tabs.map((tab) => {
          const selected = tab.id === props.activeTabId
          const label = browserTabDisplayTitle(tab)
          return (
            <Box
              key={tab.id}
              data-phi-browser-tab={selected ? 'active' : 'inactive'}
              sx={{
                flex: '0 0 clamp(104px, 58%, 168px)',
                minWidth: 104,
                maxWidth: 168,
                height: 32,
                minHeight: 32,
                minInlineSize: 0,
                display: 'flex',
                alignItems: 'center',
                pr: 0.25,
                border: 1,
                borderColor: selected
                  ? (theme) => alpha(theme.palette.primary.main, 0.48)
                  : (theme) => alpha(theme.palette.text.primary, 0.12),
                borderRadius: 1.25,
                bgcolor: selected
                  ? (theme) =>
                      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)
                  : (theme) => alpha(theme.palette.background.default, 0.72),
                color: selected ? 'text.primary' : 'text.secondary',
                transition: 'background-color 120ms ease, border-color 120ms ease',
                '&:hover': {
                  bgcolor: selected
                    ? (theme) =>
                        alpha(
                          theme.palette.primary.main,
                          theme.palette.mode === 'dark' ? 0.23 : 0.14
                        )
                    : 'action.hover',
                  color: 'text.primary'
                }
              }}
            >
              <Box
                component="div"
                role="tab"
                tabIndex={0}
                aria-selected={selected}
                aria-disabled={props.disabled || undefined}
                title={tab.url && tab.url !== 'about:blank' ? tab.url : label}
                onClick={() => {
                  if (!props.disabled && !selected) props.onActivate(tab.id)
                }}
                onKeyDown={(event) => {
                  if (!isBrowserTabActivationKey(event.key)) return
                  event.preventDefault()
                  if (!props.disabled && !selected) props.onActivate(tab.id)
                }}
                sx={{
                  flex: 1,
                  alignSelf: 'stretch',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  pl: 0.85,
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
                    width: 14,
                    height: 14,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: selected ? 'primary.main' : 'text.disabled'
                  }}
                >
                  {tab.phase === 'loading' ? (
                    <CircularProgress
                      size={12}
                      thickness={5}
                      aria-label={`正在加载 ${label}`}
                      sx={{ color: 'primary.main' }}
                    />
                  ) : (
                    <WebIcon aria-hidden="true" sx={{ fontSize: 14 }} />
                  )}
                </Box>
                <Typography
                  component="span"
                  noWrap
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    fontWeight: selected ? 700 : 550,
                    lineHeight: 1.25
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
                      width: 26,
                      height: 26,
                      borderRadius: 1,
                      color: 'text.secondary',
                      opacity: selected ? 0.78 : 0.5,
                      '&:hover, &:focus-visible': {
                        opacity: 1,
                        color: 'text.primary',
                        bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08)
                      }
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
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
            sx={{ width: 32, height: 32, borderRadius: 1.25 }}
          >
            <AddIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  )
}
