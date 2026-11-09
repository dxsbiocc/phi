import { Box } from '@mui/material'

const PETAL_COUNT = 6
const DEFAULT_SPEED = 1680
const PETAL_DELAY_MS = 140

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Six-petal bloom used as the plan-level running indicator. The petals share one
 * keyframe cycle and are phase-shifted with negative delays, so the bloom opens
 * outward in sequence instead of spinning like the step icon.
 */
export function FacetBloomLoader({
  size = 24,
  accent = 'currentColor',
  speed = DEFAULT_SPEED,
  label
}: {
  size?: number
  accent?: string
  speed?: number
  label: string
}): React.JSX.Element {
  const pixelSize = clamp(size, 16, 72)
  const duration = clamp(speed, 1000, 3000)

  return (
    <Box
      role="status"
      aria-label={label}
      data-phi-facet-bloom="true"
      sx={{
        position: 'relative',
        display: 'inline-block',
        flexShrink: 0,
        width: pixelSize,
        height: pixelSize,
        color: accent,
        lineHeight: 0,
        boxSizing: 'border-box',
        '@keyframes phi-facet-bloom': {
          '0%, 100%': { transform: 'translateY(35%) scaleY(0.45)', opacity: 0.2 },
          '30%': { transform: 'translateY(0) scaleY(1)', opacity: 1 },
          '55%': { transform: 'translateY(-6%) scaleY(1)', opacity: 0.85 }
        }
      }}
    >
      {Array.from({ length: PETAL_COUNT }, (_, index) => (
        <Box
          key={index}
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            transform: `rotate(${index * 60}deg)`
          }}
        >
          <Box
            component="span"
            aria-hidden
            data-phi-facet-bloom-petal="true"
            sx={{
              position: 'absolute',
              left: '50%',
              top: '6%',
              width: '13%',
              height: '32%',
              marginLeft: '-6.5%',
              borderRadius: '999px',
              bgcolor: accent,
              opacity: 0.9,
              // Petals grow outward from their inner end, leaving an open centre.
              transformOrigin: '50% 100%',
              animation: `phi-facet-bloom ${duration}ms ease-in-out infinite`,
              animationDelay: `${-index * PETAL_DELAY_MS}ms`,
              '@media (prefers-reduced-motion: reduce)': {
                animation: 'none',
                opacity: 1,
                transform: 'none'
              }
            }}
          />
        </Box>
      ))}
    </Box>
  )
}
