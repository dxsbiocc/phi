import {
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Tooltip
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
      Icon: PhiIcons.state.auto
    },
    ask: {
      mode: 'ask',
      label: planCopy.sessionModeAsk,
      description: planCopy.sessionModeAskDescription,
      Icon: PhiIcons.state.ask
    },
    plan: {
      mode: 'plan',
      label: planCopy.sessionModePlan,
      description: planCopy.sessionModePlanDescription,
      Icon: PhiIcons.entity.todo
    },
    plan_execute: {
      mode: 'plan_execute',
      label: planCopy.sessionModePlanExecute,
      description: planCopy.sessionModePlanExecuteDescription,
      Icon: PhiIcons.action.run
    },
    full: {
      mode: 'full',
      label: planCopy.sessionModeFull,
      description: planCopy.sessionModeFullDescription,
      Icon: PhiIcons.state.full,
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
  const CheckIcon = PhiIcons.state.check
  return (
    <List dense disablePadding aria-label={planCopy.sessionModeMenuLabel}>
      {options.map((option) => {
        const { Icon } = option
        const color = option.danger ? 'error.main' : 'text.primary'
        return (
          <ListItemButton
            key={option.mode}
            selected={mode === option.mode}
            onClick={() => onSelect(option.mode)}
            sx={{ minHeight: 64, alignItems: 'center', px: 2 }}
          >
            <ListItemIcon sx={{ minWidth: 36, color }}>
              <Icon size={COMPOSER_ICON_SIZE} />
            </ListItemIcon>
            <ListItemText
              primary={option.label}
              secondary={option.description}
              slotProps={{
                primary: { sx: { color, fontWeight: 600 } },
                secondary: { sx: { color: option.danger ? color : 'text.secondary' } }
              }}
            />
            {mode === option.mode ? <CheckIcon color={color} size={COMPOSER_ICON_SIZE} /> : null}
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
        slotProps={{ paper: { sx: { width: 420, maxWidth: 'calc(100vw - 32px)' } } }}
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
