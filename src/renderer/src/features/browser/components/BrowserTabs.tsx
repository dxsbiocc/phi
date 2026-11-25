import { browserUi } from '../lib/browserUi'
import { useUiLanguage } from '../../../lib/i18n'
import type { ReactNode } from 'react'
import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material'
import { alpha, type SxProps, type Theme } from '@mui/material/styles'
import type { BrowserTabSnapshot } from '../../../../../shared/browserTypes'
import { PanelItemSwitcher } from '../../../components/PanelItemSwitcher'
import { PhiIcons } from '../../../icons'
import {
  workspacePanelActionSize,
  workspacePanelHeaderHeight,
  workspacePanelText
} from '../../../layout'
import {
  browserTabDisplayTitle,
  isBlankBrowserTab,
  isBrowserTabActivationKey
} from '../lib/browserPanelState'

const AddIcon = PhiIcons.action.add
const CloseIcon = PhiIcons.action.close
const WebIcon = PhiIcons.tool.web

const singleTabHeaderSx: SxProps<Theme> = {
  maxWidth: 210,
  minWidth: 0,
  height: 26,
  pl: 0.75,
  pr: 0.25,
  gap: 0.6,
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 1.25,
  color: 'text.primary',
  WebkitAppRegion: 'no-drag'
}

const singleTabCloseButtonSx: SxProps<Theme> = {
  width: 22,
  height: 22,
  p: 0.25,
  borderRadius: 0.75,
  color: 'text.secondary',
  opacity: 0.78,
  '&:hover, &:focus-visible': {
    opacity: 1,
    color: 'text.primary',
    bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08)
  }
}

const newTabButtonSx: SxProps<Theme> = {
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
}

function BrowserTabGlyph(props: { tab: BrowserTabSnapshot; label: string }): React.JSX.Element {
  useUiLanguage()
  if (props.tab.phase === 'loading') {
    return (
      <CircularProgress
        size={13}
        thickness={5}
        aria-label={browserUi.loadingValue(props.label)}
        sx={{ color: 'primary.main' }}
      />
    )
  }
  return <WebIcon aria-hidden="true" sx={{ fontSize: 15 }} />
}

function SingleBrowserTabHeader(props: {
  tab: BrowserTabSnapshot
  disabled: boolean
  onClose(tabId: string): void
}): React.JSX.Element {
  useUiLanguage()
  const label = browserTabDisplayTitle(props.tab)
  const tooltip = props.tab.url && props.tab.url !== 'about:blank' ? props.tab.url : label
  return (
    <Box data-phi-browser-tab="active" title={tooltip} sx={singleTabHeaderSx}>
      <Box
        component="span"
        sx={{
          width: 16,
          height: 16,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'primary.main'
        }}
      >
        <BrowserTabGlyph tab={props.tab} label={label} />
      </Box>
      <Typography
        component="span"
        noWrap
        sx={{ ...workspacePanelText.heading, minWidth: 0, flex: '0 1 auto' }}
      >
        {label}
      </Typography>
      <Tooltip title={browserUi.closeValue(label)} arrow>
        <span style={{ display: 'inline-flex', flexShrink: 0 }}>
          <IconButton
            type="button"
            aria-label={browserUi.closeValue(label)}
            disabled={props.disabled}
            size="small"
            onClick={(event) => {
              event.stopPropagation()
              props.onClose(props.tab.id)
            }}
            onKeyDown={(event) => {
              if (isBrowserTabActivationKey(event.key)) event.stopPropagation()
            }}
            sx={singleTabCloseButtonSx}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  )
}

export interface BrowserTabsProps {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  disabled: boolean
  headerActions?: ReactNode
  switcherDefaultOpen?: boolean
  onNewTab(): void
  onActivate(tabId: string): void
  onClose(tabId: string): void
}

function BrowserTabSelection(props: {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  disabled: boolean
  switcherDefaultOpen?: boolean
  onActivate(tabId: string): void
  onClose(tabId: string): void
}): React.JSX.Element {
  useUiLanguage()
  if (props.tabs.length === 0 || (props.tabs.length === 1 && isBlankBrowserTab(props.tabs[0]))) {
    return (
      <Typography
        component="span"
        data-phi-browser-empty-tab-title="true"
        sx={{ ...workspacePanelText.heading, px: 0.5, color: 'text.primary' }}
      >
        {browserUi.newTab}
      </Typography>
    )
  }
  if (props.tabs.length === 1) {
    return (
      <SingleBrowserTabHeader
        tab={props.tabs[0]!}
        disabled={props.disabled}
        onClose={props.onClose}
      />
    )
  }
  return (
    <PanelItemSwitcher
      ariaLabel={browserUi.selectTab}
      menuLabel={browserUi.browserTabs}
      activeId={props.activeTabId}
      disabled={props.disabled}
      defaultOpen={props.switcherDefaultOpen}
      itemAttribute="data-phi-browser-tab"
      items={props.tabs.map((tab) => {
        const label = browserTabDisplayTitle(tab)
        return {
          id: tab.id,
          label,
          tooltip: tab.url && tab.url !== 'about:blank' ? tab.url : label,
          icon: <BrowserTabGlyph tab={tab} label={label} />,
          closeLabel: browserUi.closeValue(label)
        }
      })}
      onSelect={props.onActivate}
      onCloseItem={props.onClose}
    />
  )
}

export function BrowserTabs(props: BrowserTabsProps): React.JSX.Element {
  useUiLanguage()
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
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
        <BrowserTabSelection
          tabs={props.tabs}
          activeTabId={props.activeTabId}
          disabled={props.disabled}
          switcherDefaultOpen={props.switcherDefaultOpen}
          onActivate={props.onActivate}
          onClose={props.onClose}
        />
      </Box>

      <Tooltip title={browserUi.newTab2} arrow>
        <span style={{ display: 'inline-flex', flexShrink: 0 }}>
          <IconButton
            type="button"
            aria-label={browserUi.newTab2}
            disabled={props.disabled}
            size="small"
            onClick={props.onNewTab}
            sx={newTabButtonSx}
          >
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </span>
      </Tooltip>

      <Box sx={{ flex: 1, minWidth: 8 }} />

      {props.headerActions ? (
        <Box
          sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag' }}
        >
          {props.headerActions}
        </Box>
      ) : null}
    </Box>
  )
}
