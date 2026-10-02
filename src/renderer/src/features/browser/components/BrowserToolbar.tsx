import type { FormEvent, KeyboardEvent } from 'react'
import { Box, IconButton, LinearProgress, TextField, Tooltip } from '@mui/material'
import type { BrowserTabSnapshot } from '../../../../../shared/browserTypes'
import { PhiIcons } from '../../../icons'

const BackIcon = PhiIcons.action.back
const RefreshIcon = PhiIcons.action.refresh
const StopIcon = PhiIcons.action.stop

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
          sx={{ width: 36, height: 36, borderRadius: 1.25 }}
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
}

export function BrowserToolbar(props: BrowserToolbarProps): React.JSX.Element {
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
        bgcolor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider'
      }}
    >
      <Box
        component="form"
        onSubmit={submit}
        sx={{
          height: 48,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.75,
          overflow: 'hidden'
        }}
      >
        <ToolbarButton
          label="后退"
          disabled={controlsDisabled || !props.activeTab?.canGoBack}
          onClick={props.onBack}
        >
          <BackIcon sx={{ fontSize: 19, transform: 'rotate(180deg)' }} />
        </ToolbarButton>
        <ToolbarButton
          label="前进"
          disabled={controlsDisabled || !props.activeTab?.canGoForward}
          onClick={props.onForward}
        >
          <BackIcon sx={{ fontSize: 19 }} />
        </ToolbarButton>
        <ToolbarButton
          label={loading ? '停止加载' : '重新加载'}
          disabled={props.disabled || !props.activeTab || (props.busy && !loading)}
          pressed={loading}
          onClick={props.onReloadOrStop}
        >
          {loading ? <StopIcon sx={{ fontSize: 16 }} /> : <RefreshIcon sx={{ fontSize: 18 }} />}
        </ToolbarButton>
        <TextField
          value={props.address}
          onChange={(event) => props.onAddressChange(event.target.value)}
          onFocus={props.onAddressFocus}
          onBlur={props.onAddressBlur}
          onKeyDown={handleAddressKeyDown}
          disabled={props.disabled}
          placeholder="输入网址"
          autoComplete="url"
          size="small"
          fullWidth
          slotProps={{
            htmlInput: {
              'aria-label': '网址',
              spellCheck: false,
              inputMode: 'url',
              autoCapitalize: 'none'
            }
          }}
          sx={{
            minWidth: 0,
            ml: 0.25,
            '& .MuiInputBase-root': {
              height: 36,
              borderRadius: 1.25,
              bgcolor: 'action.hover',
              fontSize: 13.5
            },
            '& .MuiInputBase-input': { px: 1.25, py: 0 }
          }}
        />
      </Box>
      <Box data-phi-browser-progress-slot="true" sx={{ height: 2, overflow: 'hidden' }}>
        <LinearProgress
          aria-label="页面加载进度"
          aria-hidden={!loading}
          sx={{ height: 2, visibility: loading ? 'visible' : 'hidden' }}
        />
      </Box>
    </Box>
  )
}
