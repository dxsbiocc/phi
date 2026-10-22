import { Box, useMediaQuery } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import MetaBalls from './MetaBalls'

const staticOrbs = [
  { left: '18%', top: '32%', size: '44%' },
  { left: '43%', top: '24%', size: '36%' },
  { left: '48%', top: '48%', size: '34%' }
] as const

/** Compact, decorative loading mark for chat surfaces. */
export function MetaBallsLoader({ size = 30 }: { size?: number }): React.JSX.Element {
  const theme = useTheme()
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const color = theme.palette.mode === 'dark' ? '#ffffff' : theme.palette.primary.main

  return (
    <Box
      data-phi-meta-balls-loader="true"
      aria-hidden="true"
      sx={{ position: 'relative', width: size, height: size, flexShrink: 0, pointerEvents: 'none' }}
    >
      {reducedMotion ? (
        staticOrbs.map(({ left, top, size: orbSize }, index) => (
          <Box
            key={index}
            component="span"
            sx={{
              position: 'absolute',
              left,
              top,
              width: orbSize,
              height: orbSize,
              borderRadius: '50%',
              bgcolor: color
            }}
          />
        ))
      ) : (
        <MetaBalls
          color={color}
          cursorBallColor={color}
          variant="solid"
          motion="orbit"
          speed={0.4}
          ballCount={15}
          animationSize={30}
          gooeyness={0.5}
          stretch={0.5}
          wobble={0.5}
          enableTransparency
          enableMouseInteraction={false}
          clickBurst={false}
        />
      )}
    </Box>
  )
}
