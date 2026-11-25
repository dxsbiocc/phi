import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Box, ButtonBase, IconButton, Menu, MenuItem, Typography } from '@mui/material'
import { alpha, type SxProps, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../icons'
import { useUiLanguage } from '../lib/i18n'
import { workspacePanelText } from '../layout'

const CheckIcon = PhiIcons.state.check
const CloseIcon = PhiIcons.action.close
const CollapseIcon = PhiIcons.action.collapse
const ExpandIcon = PhiIcons.action.expand

export interface PanelSwitcherItem {
  id: string
  label: string
  tooltip?: string
  icon?: ReactNode
  closeLabel?: string
}

export interface PanelItemSwitcherProps {
  ariaLabel: string
  menuLabel: string
  items: readonly PanelSwitcherItem[]
  activeId: string | null
  disabled?: boolean
  defaultOpen?: boolean
  itemAttribute?: string
  onSelect(id: string): void
  onCloseItem?(id: string): void
}

function triggerButtonSx(open: boolean): SxProps<Theme> {
  return {
    maxWidth: 210,
    minWidth: 0,
    height: 26,
    pl: 0.75,
    pr: 0.6,
    gap: 0.55,
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 1.25,
    border: '1px solid',
    borderColor: open ? (theme) => alpha(theme.palette.text.primary, 0.14) : 'transparent',
    bgcolor: open ? 'action.hover' : 'transparent',
    color: 'text.primary',
    WebkitAppRegion: 'no-drag',
    transition: 'background-color 120ms ease, border-color 120ms ease',
    '&:hover': {
      bgcolor: 'action.hover',
      borderColor: (theme) => alpha(theme.palette.text.primary, 0.1)
    },
    '&.Mui-focusVisible': {
      outline: (theme) => `2px solid ${theme.palette.primary.main}`,
      outlineOffset: -2
    },
    '&.Mui-disabled': { color: 'text.disabled' }
  }
}

const countBadgeSx: SxProps<Theme> = {
  height: 17,
  minWidth: 17,
  px: 0.5,
  borderRadius: '999px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12),
  color: 'primary.main',
  fontSize: '0.6875rem',
  fontWeight: 700,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums'
}

const menuPaperSx: SxProps<Theme> = {
  mt: 0.5,
  minWidth: 208,
  maxWidth: 300,
  borderRadius: 1.75,
  border: '1px solid',
  borderColor: (theme) =>
    alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.18 : 0.15),
  bgcolor: (theme) =>
    alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.96 : 0.99),
  boxShadow: (theme) =>
    theme.palette.mode === 'dark'
      ? '0 12px 28px -4px rgba(0, 0, 0, 0.58), 0 2px 6px rgba(0, 0, 0, 0.36)'
      : '0 10px 26px -4px rgba(15, 23, 42, 0.15), 0 2px 6px rgba(15, 23, 42, 0.06)'
}

function closeButtonSx(selected: boolean): SxProps<Theme> {
  return {
    width: 22,
    height: 22,
    p: 0.25,
    borderRadius: 0.75,
    color: 'text.secondary',
    opacity: selected ? 0.75 : 0.45,
    transition: 'opacity 120ms ease, background-color 120ms ease, color 120ms ease',
    '.MuiMenuItem-root:hover &': { opacity: 0.85 },
    '&:hover, &:focus-visible': {
      opacity: '1 !important',
      color: 'text.primary',
      bgcolor: (theme) => alpha(theme.palette.text.primary, 0.1)
    }
  }
}

function SwitcherMenuRow(props: {
  item: PanelSwitcherItem
  selected: boolean
  disabled: boolean
  itemAttribute?: string
  onSelect(): void
  onClose?(): void
}): React.JSX.Element {
  useUiLanguage()
  const { item, selected, disabled, itemAttribute, onSelect, onClose } = props
  return (
    <MenuItem
      selected={selected}
      disabled={disabled}
      onClick={onSelect}
      {...(itemAttribute ? { [itemAttribute]: selected ? 'active' : 'inactive' } : {})}
      sx={{
        minHeight: 32,
        gap: 0.875,
        pl: 1,
        pr: 0.625,
        py: 0.5,
        borderRadius: 1.25,
        color: selected ? 'text.primary' : 'text.secondary'
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
          color: selected ? 'primary.main' : 'text.secondary'
        }}
      >
        {item.icon ?? (selected ? <CheckIcon aria-hidden="true" size={14} /> : null)}
      </Box>
      <Typography
        component="span"
        noWrap
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: workspacePanelText.itemTitle.fontSize,
          fontWeight: selected ? 650 : 500,
          lineHeight: 1.35
        }}
      >
        {item.label}
      </Typography>
      {onClose && item.closeLabel ? (
        <IconButton
          type="button"
          size="small"
          aria-label={item.closeLabel}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
          }}
          sx={closeButtonSx(selected)}
        >
          <CloseIcon sx={{ fontSize: 13.5 }} />
        </IconButton>
      ) : null}
    </MenuItem>
  )
}

function SwitcherTrigger(props: {
  ariaLabel: string
  activeItem: PanelSwitcherItem | undefined
  count: number
  open: boolean
  disabled?: boolean
  onClick(event: MouseEvent<HTMLElement>): void
}): React.JSX.Element {
  useUiLanguage()
  const ChevronIcon = props.open ? CollapseIcon : ExpandIcon
  return (
    <ButtonBase
      type="button"
      aria-label={props.ariaLabel}
      aria-haspopup="menu"
      aria-expanded={props.open}
      disabled={props.disabled}
      title={props.open ? undefined : (props.activeItem?.tooltip ?? props.activeItem?.label)}
      onClick={props.onClick}
      data-phi-panel-item-switcher="true"
      sx={triggerButtonSx(props.open)}
    >
      {props.activeItem?.icon ? (
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
          {props.activeItem.icon}
        </Box>
      ) : null}
      <Typography
        component="span"
        noWrap
        sx={{ ...workspacePanelText.heading, minWidth: 0, flex: '0 1 auto' }}
      >
        {props.activeItem?.label ?? ''}
      </Typography>
      <Box component="span" data-phi-panel-item-count="true" sx={countBadgeSx}>
        {props.count}
      </Box>
      <ChevronIcon aria-hidden="true" size={14} sx={{ color: 'text.secondary', flexShrink: 0 }} />
    </ButtonBase>
  )
}

/**
 * Compact MUI dropdown switcher shared by narrow workbench panels (Browser and Terminal) so
 * multiple open tabs or shells never clip horizontally or fall back to OS-native `<select>` menus.
 */
export function PanelItemSwitcher(props: PanelItemSwitcherProps): React.JSX.Element {
  useUiLanguage()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(props.defaultOpen))
  const isServer = typeof document === 'undefined'
  const open = props.defaultOpen && isServer ? true : Boolean(anchorEl) && uncontrolledOpen
  const activeItem = props.items.find((item) => item.id === props.activeId) ?? props.items[0]

  const handleClose = useCallback((): void => {
    setUncontrolledOpen(false)
    setAnchorEl(null)
  }, [])
  const handleOpen = (event: MouseEvent<HTMLElement>): void => {
    if (props.disabled) return
    setAnchorEl(event.currentTarget)
    setUncontrolledOpen(true)
  }

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined
    window.addEventListener('blur', handleClose)
    return () => window.removeEventListener('blur', handleClose)
  }, [handleClose, open])

  return (
    <>
      <SwitcherTrigger
        ariaLabel={props.ariaLabel}
        activeItem={activeItem}
        count={props.items.length}
        open={open}
        disabled={props.disabled}
        onClick={handleOpen}
      />
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        disablePortal={isServer}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: menuPaperSx },
          list: {
            dense: true,
            disablePadding: true,
            'aria-label': props.menuLabel,
            sx: { p: 0.5, display: 'flex', flexDirection: 'column', gap: 0.25 }
          }
        }}
      >
        {props.items.map((item) => (
          <SwitcherMenuRow
            key={item.id}
            item={item}
            selected={item.id === activeItem?.id}
            disabled={Boolean(props.disabled)}
            itemAttribute={props.itemAttribute}
            onSelect={() => {
              handleClose()
              if (item.id !== props.activeId) props.onSelect(item.id)
            }}
            onClose={
              props.onCloseItem
                ? () => {
                    handleClose()
                    props.onCloseItem?.(item.id)
                  }
                : undefined
            }
          />
        ))}
      </Menu>
    </>
  )
}
