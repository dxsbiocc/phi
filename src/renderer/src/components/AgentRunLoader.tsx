import { Box } from '@mui/material'
import { keyframes } from '@mui/material/styles'
import type { SxProps, Theme } from '@mui/material/styles'

const ORBIT_EASING = 'cubic-bezier(0.37, 0, 0.63, 1)'

const redOrbit = keyframes`
  0%, 100% { transform: translate3d(-12px, 2px, 0) scale(.72); opacity: .45; }
  25% { transform: translate3d(-6px, -2px, 0) scale(.95); opacity: .78; }
  50% { transform: translate3d(12px, 0, 0) scale(1.18); opacity: 1; }
  75% { transform: translate3d(6px, 2px, 0) scale(.95); opacity: .78; }
`

const blueOrbit = keyframes`
  0%, 100% { transform: translate3d(10px, -1px, 0) scale(1); opacity: .95; }
  25% { transform: translate3d(5px, 2px, 0) scale(.88); opacity: .72; }
  50% { transform: translate3d(-10px, 1px, 0) scale(.68); opacity: .42; }
  75% { transform: translate3d(-5px, -2px, 0) scale(.88); opacity: .72; }
`

const yellowOrbit = keyframes`
  0%, 100% { transform: translate3d(-7px, 1px, 0) scale(.82); opacity: .65; }
  20% { transform: translate3d(-4px, -1px, 0) scale(.94); opacity: .82; }
  50% { transform: translate3d(7px, 0, 0) scale(1.08); opacity: 1; }
  80% { transform: translate3d(4px, 1px, 0) scale(.94); opacity: .82; }
`

const greenOrbit = keyframes`
  0% { transform: translate3d(16px, 2px, 0) scale(.52); opacity: .25; }
  20% { transform: translate3d(11px, -1px, 0) scale(.68); opacity: .45; }
  50% { transform: translate3d(0, 1px, 0) scale(1); opacity: .9; }
  80% { transform: translate3d(-11px, -1px, 0) scale(.68); opacity: .45; }
  100% { transform: translate3d(-16px, 2px, 0) scale(.52); opacity: .25; }
`

const ORBIT_DOTS = [
  {
    id: 'red',
    size: 6,
    zIndex: 30,
    light: '#E24B4B',
    dark: '#FF6B6B',
    animation: redOrbit,
    duration: '3.8s',
    staticTransform: 'translate3d(-12px, 2px, 0) scale(.72)',
    staticOpacity: 0.45
  },
  {
    id: 'blue',
    size: 5,
    zIndex: 10,
    light: '#3478E5',
    dark: '#60A5FA',
    animation: blueOrbit,
    duration: '5.6s',
    staticTransform: 'translate3d(10px, -1px, 0) scale(1)',
    staticOpacity: 0.95
  },
  {
    id: 'yellow',
    size: 4,
    zIndex: 40,
    light: '#C99700',
    dark: '#FACC15',
    animation: yellowOrbit,
    duration: '3.1s',
    staticTransform: 'translate3d(-7px, 1px, 0) scale(.82)',
    staticOpacity: 0.65
  },
  {
    id: 'green',
    size: 7,
    zIndex: 0,
    light: '#2B9B63',
    dark: '#4ADE80',
    animation: greenOrbit,
    duration: '6.4s',
    alternate: true,
    staticTransform: 'translate3d(16px, 2px, 0) scale(.52)',
    staticOpacity: 0.25
  }
] as const

export type AgentRunLoaderProps = {
  label: string
  sx?: SxProps<Theme>
}

/** Compact, theme-aware activity indicator for a running agent. */
export function AgentRunLoader({ label, sx }: AgentRunLoaderProps): React.JSX.Element {
  const styles = [
    {
      position: 'relative',
      display: 'inline-flex',
      width: 46,
      height: 14,
      flexShrink: 0,
      overflow: 'hidden',
      verticalAlign: 'text-bottom'
    },
    ...(Array.isArray(sx) ? sx : [sx])
  ].filter(Boolean) as SxProps<Theme>

  return (
    <Box
      component="span"
      role="status"
      aria-label={label}
      data-phi-agent-run-loader="true"
      sx={styles}
    >
      {ORBIT_DOTS.map((dot) => (
        <Box
          key={dot.id}
          component="span"
          aria-hidden="true"
          sx={(theme) => {
            const color = theme.palette.mode === 'dark' ? dot.dark : dot.light
            return {
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: dot.size,
              height: dot.size,
              mt: `${-dot.size / 2}px`,
              ml: `${-dot.size / 2}px`,
              borderRadius: '50%',
              bgcolor: color,
              boxShadow: `0 0 6px ${color}`,
              zIndex: dot.zIndex,
              transform: dot.staticTransform,
              opacity: dot.staticOpacity,
              animation: `${dot.animation} ${dot.duration} ${ORBIT_EASING} infinite${
                'alternate' in dot && dot.alternate ? ' alternate' : ''
              }`,
              '@media (prefers-reduced-motion: reduce)': {
                animation: 'none'
              }
            }
          }}
        />
      ))}
    </Box>
  )
}
