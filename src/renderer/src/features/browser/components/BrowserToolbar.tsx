import { browserUi } from '../lib/browserUi'
import { useUiLanguage } from '../../../lib/i18n'
import type { FormEvent, KeyboardEvent } from 'react'
import { Box, IconButton, LinearProgress, TextField, Tooltip } from '@mui/material'
import type { BrowserTabSnapshot } from '../../../../../shared/browserTypes'
import { PhiIcons } from '../../../icons'
import { workspacePanelText } from '../../../layout'

const BackIcon = PhiIcons.action.back
const RefreshIcon = PhiIcons.action.refresh
const StopIcon = PhiIcons.action.stop
const OpenExternalIcon = PhiIcons.action.openExternal

function ToolbarButton({
  label,
  disabled,
  pressed,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  pressed?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Tooltip title={label} arrow>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <IconButton
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          size="small"
          sx={{
            width: 28,
            height: 28,
            p: 0.5,
            borderRadius: 1,
            '&.Mui-focusVisible': {
              bgcolor: 'action.hover',
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: -2
            }
          }}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  )
}

export interface BrowserToolbarProps {
  address: string
  activeTab: BrowserTabSnapshot | null
  busy: boolean
  disabled: boolean
  onAddressChange(value: string): void
  onAddressFocus(): void
  onAddressBlur(): void
  onRestoreAddress(): void
  onSubmit(): void
  onBack(): void
  onForward(): void
  onReloadOrStop(): void
  onOpenExternal(): void
}

export function BrowserToolbar(props: BrowserToolbarProps): React.JSX.Element {
  useUiLanguage()
  const loading = props.activeTab?.phase === 'loading'
  const controlsDisabled = props.disabled || props.busy
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!controlsDisabled && props.address.trim()) props.onSubmit()
  }
  const handleAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    props.onRestoreAddress()
    event.currentTarget.select()
  }

  return (
    <Box
      data-phi-browser-toolbar="true"
      sx={{
        flexShrink: 0,
        minWidth: 0,
        bgcolor: 'background.paper'
      }}
    >
      <Box
        component="form"
        onSubmit={submit}
        sx={{
          height: 40,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          overflow: 'hidden'
        }}
      >
        <ToolbarButton
          label={browserUi.back}
          disabled={controlsDisabled || !props.activeTab?.canGoBack}
          onClick={props.onBack}
        >
          <BackIcon sx={{ fontSize: 16, transform: 'rotate(180deg)' }} />
        </ToolbarButton>
        <ToolbarButton
          label={browserUi.forward}
          disabled={controlsDisabled || !props.activeTab?.canGoForward}
          onClick={props.onForward}
        >
          <BackIcon sx={{ fontSize: 16 }} />
        </ToolbarButton>
        <ToolbarButton
          label={loading ? browserUi.stopLoading : browserUi.reload}
          disabled={props.disabled || !props.activeTab || (props.busy && !loading)}
          pressed={loading}
          onClick={props.onReloadOrStop}
        >
          {loading ? <StopIcon sx={{ fontSize: 16 }} /> : <RefreshIcon sx={{ fontSize: 16 }} />}
        </ToolbarButton>
        <TextField
          value={props.address}
          onChange={(event) => props.onAddressChange(event.target.value)}
          onFocus={props.onAddressFocus}
          onBlur={props.onAddressBlur}
          onKeyDown={handleAddressKeyDown}
          disabled={props.disabled}
          placeholder={browserUi.enterAURL}
          autoComplete="url"
          size="small"
          fullWidth
          slotProps={{
            htmlInput: {
              'aria-label': browserUi.uRL,
              spellCheck: false,
              inputMode: 'url',
              autoCapitalize: 'none'
            }
          }}
          sx={{
            minWidth: 0,
            '& .MuiInputBase-root': {
              height: 30,
              borderRadius: 1,
              bgcolor: 'action.hover',
              fontSize: workspacePanelText.body.fontSize
            },
            '& .MuiInputBase-input': { px: 1, py: 0 }
          }}
        />
        <ToolbarButton
          label={browserUi.openInDefaultBrowser}
          disabled={
            controlsDisabled ||
            !props.activeTab ||
            !props.activeTab.url ||
            props.activeTab.url === 'about:blank' ||
            Boolean(props.activeTab.restorable)
          }
          onClick={props.onOpenExternal}
        >
          <OpenExternalIcon sx={{ fontSize: 16 }} />
        </ToolbarButton>
      </Box>
      <Box data-phi-browser-progress-slot="true" sx={{ height: 2, overflow: 'hidden' }}>
        <LinearProgress
          aria-label={browserUi.pageLoadingProgress}
          aria-hidden={!loading}
          sx={{ height: 2, visibility: loading ? 'visible' : 'hidden' }}
        />
      </Box>
    </Box>
  )
}
