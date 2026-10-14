import { useId, useState, type KeyboardEvent, type MouseEvent } from 'react'

export const inlineLinkLabelSx = {
  alignSelf: 'baseline',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
} as const

export const inlineLinkTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.75rem',
      lineHeight: 1.45,
      maxWidth: 'min(420px, calc(100vw - 32px))',
      maxHeight: 'min(240px, calc(100vh - 32px))',
      overflowY: 'auto',
      overflowWrap: 'anywhere'
    }
  },
  arrow: {
    sx: {
      color: 'background.paper',
      '&::before': { border: '1px solid', borderColor: 'divider', boxSizing: 'border-box' }
    }
  }
} as const

type MenuPosition = { top: number; left: number; target: string }

export function useInlineLinkMenu(target: string): {
  menuId: string
  position: MenuPosition | null
  closeMenu: () => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  tooltip: { open: boolean; onOpen: () => void; onClose: () => void }
} {
  const menuId = useId()
  const [menu, setMenu] = useState<MenuPosition | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  // A streamed link can change its destination. Never leave its old menu open.
  const position = menu?.target === target ? menu : null
  const openAtElement = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    setTooltipOpen(false)
    setMenu({ top: rect.bottom, left: rect.left, target })
  }

  return {
    menuId,
    position,
    closeMenu: () => setMenu(null),
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.clientX === 0 && event.clientY === 0) {
        openAtElement(event.currentTarget)
        return
      }
      setTooltipOpen(false)
      setMenu({ top: event.clientY, left: event.clientX, target })
    },
    onKeyDown: (event) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      event.stopPropagation()
      openAtElement(event.currentTarget)
    },
    tooltip: {
      open: tooltipOpen && position === null,
      onOpen: () => setTooltipOpen(true),
      onClose: () => setTooltipOpen(false)
    }
  }
}
