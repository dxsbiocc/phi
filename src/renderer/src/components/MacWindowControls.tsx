import { useState } from 'react'
import { Box } from '@mui/material'

type WindowControl = {
  label: string
  color: string
  borderColor: string
  symbol: string
  action: () => void
}

function buildControls(handlers: {
  onClose: () => void
  onMinimize: () => void
  onToggleFullscreen: () => void
}): WindowControl[] {
  return [
    {
      label: '关闭',
      color: '#FF5F57',
      borderColor: '#E24640',
      symbol: '×',
      action: handlers.onClose
    },
    {
      label: '最小化',
      color: '#FFBD2E',
      borderColor: '#DFA123',
      symbol: '−',
      action: handlers.onMinimize
    },
    {
      // Real macOS uses a diagonal double-arrow for "enter full screen", not
      // a plus sign -- this is the closest plain-glyph match, keeping the
      // same plain-text rendering as the × and − so all three stay visually
      // consistent instead of mixing in a stroke-based icon font.
      label: '全屏',
      color: '#28C840',
      borderColor: '#20A935',
      symbol: '⤢',
      action: handlers.onToggleFullscreen
    }
  ]
}

/**
 * Custom-drawn macOS traffic lights: the window is frameless with the real
 * ones hidden (setWindowButtonVisibility(false) in main/index.ts), so the
 * renderer owns every pixel here.
 *
 * Hover is tracked with React state (mouseenter/mouseleave), not a CSS
 * `:hover` selector -- elements marked `-webkit-app-region` for Electron's
 * frameless-window dragging can miss CSS :hover state changes in Chromium
 * (mouse-move hit-testing for drag regions happens on a different path than
 * normal style recalculation), which is what made the reveal feel
 * unresponsive. Real mouseenter/mouseleave DOM events don't have that
 * problem, and matches native macOS: hovering any one dot reveals the glyph
 * on all three.
 *
 * This component does NOT position itself or declare its own
 * `-webkit-app-region` boundary -- the caller (App.tsx) wraps this together
 * with WindowNavigationControls in one shared absolutely-positioned,
 * no-drag container. Two separate sibling no-drag rectangles side by side
 * is exactly the shape of a known Electron quirk (a later layout pass can
 * silently drop one region's no-drag carve-out, leaving its buttons
 * unclickable -- e.g. only the drag underneath responds), so there is
 * deliberately only one boundary for the whole button cluster now.
 */
export default function MacWindowControls({
  onClose,
  onMinimize,
  onToggleFullscreen
}: {
  onClose: () => void
  onMinimize: () => void
  onToggleFullscreen: () => void
}): React.JSX.Element {
  const [isHovered, setIsHovered] = useState(false)
  const controls = buildControls({ onClose, onMinimize, onToggleFullscreen })

  return (
    <Box
      data-phi-mac-window-controls="true"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        WebkitAppRegion: 'no-drag'
      }}
    >
      {controls.map((control) => (
        <Box
          key={control.label}
          component="button"
          type="button"
          aria-label={control.label}
          onClick={() => {
            control.action()
          }}
          sx={{
            width: 14,
            height: 14,
            p: 0,
            border: '1px solid',
            borderColor: control.borderColor,
            borderRadius: '50%',
            backgroundColor: control.color,
            cursor: 'default',
            WebkitAppRegion: 'no-drag',
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(45, 45, 45, 0.85)',
            fontSize: 13,
            lineHeight: 1,
            fontWeight: 900,
            // font-weight:900 is already the max a font offers -- these
            // glyphs still rendered thin because most fonts don't ship a
            // true "black" cut for ×/−/⤢ and just fake it. A text-stroke
            // paints an actual outline on top, which thickens them
            // regardless of the font's own weight support.
            WebkitTextStroke: '0.5px currentColor',
            '&:hover': {
              filter: 'brightness(0.96)'
            }
          }}
        >
          <Box
            component="span"
            data-phi-mac-window-control-symbol="true"
            aria-hidden
            sx={{
              opacity: isHovered ? 1 : 0,
              transform: 'translateY(-0.5px)',
              transition: 'opacity 120ms ease',
              pointerEvents: 'none'
            }}
          >
            {control.symbol}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
