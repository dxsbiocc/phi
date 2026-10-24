import {
  alpha,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Tooltip,
  useTheme
} from '@mui/material'
import { useId, useState } from 'react'

import type { SessionMode } from '../../../../../shared/sessionMode'
import {
  COMPOSER_ICON_SIZE,
  compactComposerIconButtonSx
} from '../../../components/chat/composerControlStyles'
import { PhiIcons, type PhiIconComponent } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { planCopy } from '../lib/planCopy'
import { availableSessionModes } from '../lib/sessionModeView'

type SessionModeOption = {
  mode: SessionMode
  label: string
  description: string
  Icon: PhiIconComponent
  tone: 'success' | 'warning' | 'info' | 'primary' | 'error'
  danger?: boolean
}

type SessionModeTriggerProps = {
  option: SessionModeOption
  disabled: boolean
  popoverId: string
  onOpen: (event: React.MouseEvent<HTMLElement>) => void
}

function sessionModeOptions(remote: boolean): SessionModeOption[] {
  const options: Record<SessionMode, SessionModeOption> = {
    auto: {
      mode: 'auto',
      label: planCopy.sessionModeAuto,
      description: planCopy.sessionModeAutoDescription,
      Icon: PhiIcons.state.auto,
      tone: 'success'
    },
    ask: {
      mode: 'ask',
      label: planCopy.sessionModeAsk,
      description: planCopy.sessionModeAskDescription,
      Icon: PhiIcons.state.ask,
      tone: 'warning'
    },
    plan: {
      mode: 'plan',
      label: planCopy.sessionModePlan,
      description: planCopy.sessionModePlanDescription,
      Icon: PhiIcons.entity.todo,
      tone: 'info'
    },
    plan_execute: {
      mode: 'plan_execute',
      label: planCopy.sessionModePlanExecute,
      description: planCopy.sessionModePlanExecuteDescription,
      Icon: PhiIcons.action.run,
      tone: 'primary'
    },
    full: {
      mode: 'full',
      label: planCopy.sessionModeFull,
      description: planCopy.sessionModeFullDescription,
      Icon: PhiIcons.state.full,
      tone: 'error',
      danger: true
    }
  }
  return availableSessionModes(remote).map((mode) => options[mode])
}

function CompactSessionModeTrigger({
  option,
  disabled,
  popoverId,
  onOpen
}: SessionModeTriggerProps): React.JSX.Element {
  const { Icon } = option
  const label = planCopy.chooseSessionMode(option.label)
  const color = option.danger ? 'error.main' : 'text.secondary'
  return (
    <Tooltip title={label} enterDelay={400}>
      <IconButton
        size="small"
        aria-label={label}
        aria-describedby={popoverId}
        disabled={disabled}
        onClick={onOpen}
        sx={{ ...compactComposerIconButtonSx, color }}
      >
        <Icon size={COMPOSER_ICON_SIZE} />
      </IconButton>
    </Tooltip>
  )
}

function SessionModeTrigger({
  option,
  disabled,
  popoverId,
  onOpen
}: SessionModeTriggerProps): React.JSX.Element {
  const { Icon } = option
  const label = planCopy.chooseSessionMode(option.label)
  return (
    <Button
      size="small"
      aria-label={label}
      aria-describedby={popoverId}
      disabled={disabled}
      onClick={onOpen}
      startIcon={<Icon size={COMPOSER_ICON_SIZE} />}
      sx={{
        minWidth: 0,
        px: 1,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        textTransform: 'none',
        color: option.danger ? 'error.main' : 'text.secondary'
      }}
    >
      {option.label}
    </Button>
  )
}

function SessionModeTriggerForLayout({
  compact,
  ...props
}: SessionModeTriggerProps & { compact: boolean }): React.JSX.Element {
  return compact ? <CompactSessionModeTrigger {...props} /> : <SessionModeTrigger {...props} />
}

function SessionModeMenu({
  options,
  mode,
  onSelect
}: {
  options: SessionModeOption[]
  mode: SessionMode
  onSelect: (mode: SessionMode) => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <List dense disablePadding aria-label={planCopy.sessionModeMenuLabel}>
      {options.map((option) => {
        const { Icon } = option
        const tone = theme.palette[option.tone]
        const isPlanningMode = option.mode === 'plan' || option.mode === 'plan_execute'
        const color =
          theme.palette.mode === 'dark'
            ? tone.light
            : isPlanningMode
              ? tone.dark
              : (tone.darker ?? tone.dark)
        const iconColor = isPlanningMode && theme.palette.mode === 'light' ? tone.main : color
        return (
          <ListItemButton
            key={option.mode}
            selected={mode === option.mode}
            onClick={() => onSelect(option.mode)}
            sx={{
              minHeight: 52,
              alignItems: 'center',
              px: 1.5,
              py: 0.5,
              '&.Mui-selected': {
                bgcolor: alpha(tone.main, theme.palette.mode === 'dark' ? 0.22 : 0.12)
              },
              '&.Mui-selected:hover': {
                bgcolor: alpha(tone.main, theme.palette.mode === 'dark' ? 0.3 : 0.18)
              }
            }}
          >
            <ListItemIcon
              sx={{
                width: 32,
                minWidth: 32,
                height: 32,
                mr: 0.5,
                borderRadius: 1,
                bgcolor: alpha(tone.main, theme.palette.mode === 'dark' ? 0.2 : 0.12),
                alignItems: 'center',
                justifyContent: 'center',
                color: iconColor
              }}
            >
              <Icon color={iconColor} size={COMPOSER_ICON_SIZE} />
            </ListItemIcon>
            <ListItemText
              sx={{ my: 0 }}
              primary={option.label}
              secondary={option.description}
              slotProps={{
                primary: { sx: { color, fontWeight: 600 } },
                secondary: { sx: { color: option.danger ? color : 'text.secondary' } }
              }}
            />
          </ListItemButton>
        )
      })}
    </List>
  )
}

export function SessionModeSelector({
  mode,
  remote = false,
  disabled = false,
  compact = false,
  onSelectMode
}: {
  mode: SessionMode
  remote?: boolean
  disabled?: boolean
  compact?: boolean
  onSelectMode: (mode: SessionMode) => void
}): React.JSX.Element {
  useUiLanguage()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const popoverId = useId()
  const options = sessionModeOptions(remote)
  const selected = options.find((option) => option.mode === mode) ?? options[0]!
  const close = (): void => setAnchor(null)
  return (
    <>
      <SessionModeTriggerForLayout
        compact={compact}
        option={selected}
        disabled={disabled}
        popoverId={popoverId}
        onOpen={(event) => setAnchor(event.currentTarget)}
      />
      <Popover
        id={popoverId}
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 264, maxWidth: 'calc(100vw - 32px)' } } }}
      >
        <SessionModeMenu
          options={options}
          mode={selected.mode}
          onSelect={(nextMode) => {
            onSelectMode(nextMode)
            close()
          }}
        />
      </Popover>
    </>
  )
}
