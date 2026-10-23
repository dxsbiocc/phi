import {
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover
} from '@mui/material'
import { useId, useState } from 'react'

import {
  COMPOSER_ICON_SIZE,
  compactComposerIconButtonSx
} from '../../../components/chat/composerControlStyles'
import { PhiIcons, type PhiIconComponent } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import type { PlanMode } from '../hooks/usePlanModeToggle'
import { planCopy } from '../lib/planCopy'

type ModeOption = { mode: PlanMode; label: string; Icon: PhiIconComponent }
type ModeTriggerProps = {
  selected: ModeOption
  mode: PlanMode
  compact: boolean
  disabled: boolean
  open: boolean
  popoverId: string
  onOpen: (event: React.MouseEvent<HTMLElement>) => void
}

function modeOptions(): ModeOption[] {
  return [
    { mode: 'off', label: planCopy.modeOff, Icon: PhiIcons.state.pending },
    { mode: 'review', label: planCopy.modeReview, Icon: PhiIcons.entity.todo },
    { mode: 'execute', label: planCopy.modeExecute, Icon: PhiIcons.action.run }
  ]
}

function ModeTrigger({
  selected,
  mode,
  compact,
  disabled,
  open,
  popoverId,
  onOpen
}: ModeTriggerProps): React.JSX.Element {
  const SelectedIcon = selected.Icon
  if (compact) {
    return (
      <IconButton
        size="small"
        disabled={disabled}
        aria-label={`${planCopy.modeMenuLabel}: ${selected.label}`}
        aria-controls={popoverId}
        aria-haspopup="menu"
        aria-expanded={open}
        title={planCopy.modeMenuLabel}
        onClick={onOpen}
        sx={{
          ...compactComposerIconButtonSx,
          color: mode === 'execute' ? 'primary.main' : 'text.secondary'
        }}
      >
        <SelectedIcon size={COMPOSER_ICON_SIZE} />
      </IconButton>
    )
  }
  return (
    <Button
      size="small"
      disabled={disabled}
      aria-label={`${planCopy.modeMenuLabel}: ${selected.label}`}
      aria-controls={popoverId}
      aria-haspopup="menu"
      aria-expanded={open}
      title={planCopy.modeMenuLabel}
      onClick={onOpen}
      startIcon={<SelectedIcon size={COMPOSER_ICON_SIZE} />}
      sx={{ minWidth: 0, px: 1, flexShrink: 0, whiteSpace: 'nowrap', textTransform: 'none' }}
    >
      {selected.label}
    </Button>
  )
}

function ModeMenu({
  options,
  selectedMode,
  onSelect
}: {
  options: ModeOption[]
  selectedMode: PlanMode
  onSelect: (mode: PlanMode) => void
}): React.JSX.Element {
  return (
    <List dense disablePadding role="menu" aria-label={planCopy.modeMenuLabel}>
      {options.map(({ mode, label, Icon }) => (
        <ListItemButton
          key={mode}
          role="menuitemradio"
          aria-checked={selectedMode === mode}
          selected={selectedMode === mode}
          aria-label={label}
          onClick={() => onSelect(mode)}
        >
          <ListItemIcon sx={{ minWidth: 34 }}>
            <Icon size={COMPOSER_ICON_SIZE} />
          </ListItemIcon>
          <ListItemText primary={label} />
        </ListItemButton>
      ))}
    </List>
  )
}

export function PlanModeControl({
  mode,
  disabled = false,
  compact = false,
  onSelectMode
}: {
  mode: PlanMode
  disabled?: boolean
  compact?: boolean
  onSelectMode: (mode: PlanMode) => void
}): React.JSX.Element {
  useUiLanguage()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const popoverId = useId()
  const options = modeOptions()
  const selected = options.find((option) => option.mode === mode) ?? options[0]!
  const close = (): void => setAnchor(null)
  return (
    <>
      <ModeTrigger
        selected={selected}
        mode={mode}
        compact={compact}
        disabled={disabled}
        open={Boolean(anchor)}
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
      >
        <ModeMenu
          options={options}
          selectedMode={mode}
          onSelect={(next) => {
            onSelectMode(next)
            close()
          }}
        />
      </Popover>
    </>
  )
}
