import { useState, type ReactNode } from 'react'
import { Box, ListItemButton } from '@mui/material'
import { CatalogEnableSwitch } from './CatalogEnableSwitch'
import { catalogSidebarRowSx } from '../lib/catalogSidebarStyles'

export type CatalogResourceRowProps = {
  id: string
  resource: 'skills' | 'plugins' | 'wrappers' | 'connectors'
  label: string
  icon: ReactNode
  children: ReactNode
  enabled: boolean
  selected?: boolean
  busy?: boolean
  disabledReason?: string
  onSelect: () => void
  onEnabledChange?: (enabled: boolean) => void | Promise<void | boolean>
}

/** Selection and enablement are sibling controls so a switch never opens the detail page. */
export function CatalogResourceRow({
  id,
  resource,
  label,
  icon,
  children,
  enabled,
  selected,
  busy = false,
  disabledReason,
  onSelect,
  onEnabledChange
}: CatalogResourceRowProps): React.JSX.Element {
  const [pending, setPending] = useState<boolean | null>(null)
  const active = pending ?? enabled
  const updating = pending !== null || busy

  async function toggle(checked: boolean): Promise<void> {
    if (updating || disabledReason || !onEnabledChange) return
    setPending(checked)
    try {
      await onEnabledChange(checked)
    } catch {
      // Feature mutation handlers report errors; clearing the optimistic value restores the badge.
    } finally {
      setPending(null)
    }
  }

  return (
    <Box
      data-phi-catalog-row={id}
      data-phi-catalog-resource={resource}
      data-phi-catalog-pending={updating || undefined}
      className={selected ? 'Mui-selected' : undefined}
      sx={[
        catalogSidebarRowSx,
        {
          display: 'flex',
          position: 'relative',
          p: 0.25,
          pr: 0.5,
          '& .catalog-enable-control': {
            position: 'absolute',
            right: 4,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: 0,
            pointerEvents: 'none',
            transition: 'opacity 120ms ease'
          },
          '&:hover .catalog-enable-control, &:has(:focus-visible) .catalog-enable-control, &[data-phi-catalog-pending="true"] .catalog-enable-control':
            { opacity: 1, pointerEvents: 'auto' },
          '&:hover .catalog-row-content, &:has(:focus-visible) .catalog-row-content, &[data-phi-catalog-pending="true"] .catalog-row-content':
            { pr: '44px' },
          '@media (hover: none)': {
            '& .catalog-enable-control': { opacity: 1, pointerEvents: 'auto' },
            '& .catalog-row-content': { pr: '44px' }
          },
          '@media (prefers-reduced-motion: reduce)': {
            '& .catalog-enable-control': { transition: 'none' }
          }
        }
      ]}
    >
      <ListItemButton
        aria-label={`打开 ${label}，${active ? '已启用' : '已关闭'}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 44,
          pl: 1,
          pr: 0.5,
          py: 0.5,
          gap: 1,
          borderRadius: 1,
          '&:hover': { bgcolor: 'transparent' },
          '&.Mui-focusVisible': {
            bgcolor: 'transparent',
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: -2
          }
        }}
      >
        <Box sx={{ position: 'relative', flexShrink: 0 }}>
          {icon}
          <Box
            component="span"
            aria-hidden="true"
            data-phi-catalog-status={active ? 'enabled' : 'disabled'}
            sx={{
              position: 'absolute',
              right: -2,
              bottom: -2,
              width: 12,
              height: 12,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              bgcolor: active ? 'success.dark' : 'background.default',
              color: active ? 'common.white' : 'text.secondary',
              border: active ? 0 : '1.5px solid',
              borderColor: 'text.secondary',
              boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.default}`,
              pointerEvents: 'none'
            }}
          >
            {active ? (
              <Box component="svg" viewBox="0 0 12 12" sx={{ width: 8, height: 8 }}>
                <path
                  d="M2 6.2 4.7 9 10 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Box>
            ) : (
              <Box sx={{ width: 4, height: 1.5, bgcolor: 'currentColor' }} />
            )}
          </Box>
        </Box>
        <Box className="catalog-row-content" sx={{ flex: 1, minWidth: 0 }}>
          {children}
        </Box>
      </ListItemButton>
      <Box className="catalog-enable-control">
        <CatalogEnableSwitch
          checked={active}
          busy={updating}
          disabled={updating || Boolean(disabledReason) || !onEnabledChange}
          label={disabledReason ?? (active ? `关闭 ${label}` : `启用 ${label}`)}
          onChange={(checked) => void toggle(checked)}
        />
      </Box>
    </Box>
  )
}
