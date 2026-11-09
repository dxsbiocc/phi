import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'

const ORB_ANIMATION = 'phi-thinking-orb-look 4s ease-in-out infinite'

/**
 * Pure-CSS stand-in for the LiveOrb mascot. A conversation can hold dozens of
 * thinking blocks, so this stays DOM/CSS instead of allocating a WebGL context.
 */
export function ThinkingOrb({
  size = 16,
  active = false
}: {
  size?: number
  active?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const dark = theme.palette.mode === 'dark'
  const ballColor = dark ? '#F4F4F5' : '#18181B'
  const eyeColor = dark ? '#09090B' : '#F4F4F5'

  return (
    <Box
      component="span"
      aria-hidden
      data-phi-thinking-orb="true"
      data-phi-thinking-orb-active={active ? 'true' : 'false'}
      sx={{
        position: 'relative',
        display: 'inline-block',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: ballColor,
        opacity: active ? 1 : 0.55,
        ...(active
          ? {
              '@keyframes phi-thinking-orb-look': {
                // Center, glance left, glance right, settle, then blink for ~120ms.
                '0%, 12%': { transform: 'translateX(0) scaleY(1)' },
                '25%, 32%': { transform: 'translateX(-100%) scaleY(1)' },
                '45%, 52%': { transform: 'translateX(100%) scaleY(1)' },
                '65%, 84%': { transform: 'translateX(0) scaleY(1)' },
                '85.5%': { transform: 'translateX(0) scaleY(0.1)' },
                '87%, 100%': { transform: 'translateX(0) scaleY(1)' }
              }
            }
          : {})
      }}
    >
      {(['left', 'right'] as const).map((side) => (
        <Box
          key={side}
          component="span"
          data-phi-thinking-orb-eye={side}
          sx={{
            position: 'absolute',
            top: '34%',
            left: side === 'left' ? '31%' : '56%',
            width: '13%',
            height: '28%',
            borderRadius: '999px',
            bgcolor: eyeColor,
            transformOrigin: 'center',
            animation: active ? ORB_ANIMATION : 'none',
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
          }}
        />
      ))}
    </Box>
  )
}
