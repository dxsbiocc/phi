import { alpha, Box, useMediaQuery, useTheme } from '@mui/material'
import { useId } from 'react'
import { PHI_MARK_PATH } from '../../../../../shared/phiMark'

const CYCLE_SECONDS = 6.4
const PHI_TRACE = 'phi-mark-trace'
const PHI_BRUSH = 'phi-mark-brush'

const markSx = {
  display: 'block',
  flexShrink: 0,
  overflow: 'visible',
  [`@keyframes ${PHI_TRACE}`]: {
    '0%, 10%': { strokeDashoffset: 1, opacity: 1 },
    '72%, 88%': { strokeDashoffset: 0, opacity: 1 },
    '96%, 100%': { strokeDashoffset: 0, opacity: 0 }
  },
  [`@keyframes ${PHI_BRUSH}`]: {
    '0%, 8%': { opacity: 0 },
    '12%, 70%': { opacity: 1 },
    '74%, 100%': { opacity: 0 }
  },
  '& .phi-mark-stroke': {
    strokeDasharray: 1,
    strokeDashoffset: 1,
    animation: `${PHI_TRACE} ${CYCLE_SECONDS}s linear infinite`
  },
  '& .phi-mark-brush': {
    animation: `${PHI_BRUSH} ${CYCLE_SECONDS}s ease-in-out infinite`
  },
  '@media (prefers-reduced-motion: reduce)': {
    '& .phi-mark-stroke': { animation: 'none', strokeDashoffset: 0, opacity: 1 }
  }
} as const

/** A watercolor brush paints the lowercase phi on a small canvas. */
export function PhiMark({ size = 76 }: { size?: number }): React.JSX.Element {
  const theme = useTheme()
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const id = useId().replace(/:/g, '')
  const inkId = `phi-ink-${id}`
  const washId = `phi-wash-${id}`
  const edgeId = `phi-edge-${id}`
  const shadowId = `phi-brush-shadow-${id}`
  const colors = [
    theme.palette.primary.main,
    theme.palette.info.main,
    theme.palette.success.main,
    theme.palette.warning.main,
    theme.palette.error.main
  ]

  return (
    <Box
      component="svg"
      data-phi-home-mark="true"
      viewBox="0 0 120 120"
      aria-hidden
      sx={{ width: size, height: size, ...markSx }}
    >
      <defs>
        <linearGradient id={inkId} x1="120" y1="110" x2="390" y2="400" gradientUnits="userSpaceOnUse">
          {colors.map((color, index) => (
            <stop key={index} offset={`${index * 25}%`} stopColor={color} />
          ))}
        </linearGradient>
        <filter id={washId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <filter id={edgeId} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="7" result="grain" />
          <feDisplacementMap in="SourceGraphic" in2="grain" scale="7" />
        </filter>
        <filter id={shadowId} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="2" dy="3" stdDeviation="3" floodOpacity="0.22" />
        </filter>
      </defs>

      <rect
        x="10"
        y="13"
        width="99"
        height="98"
        rx="9"
        fill={theme.palette.background.paper}
        stroke={alpha(theme.palette.text.primary, 0.16)}
        strokeWidth="1.5"
      />
      <path d="M19 27 V22 Q19 20 21 20 H31" fill="none" stroke={alpha(colors[0], 0.18)} strokeWidth="2" />
      <path d="M98 98 V102 Q98 104 96 104 H86" fill="none" stroke={alpha(colors[3], 0.22)} strokeWidth="2" />

      <g transform="translate(1 6) scale(0.22)">
        <path
          className="phi-mark-stroke"
          d={PHI_MARK_PATH}
          pathLength={1}
          fill="none"
          stroke={`url(#${inkId})`}
          strokeWidth={68}
          strokeLinecap="round"
          opacity={0.3}
          filter={`url(#${washId})`}
        />
        <path
          className="phi-mark-stroke"
          d={PHI_MARK_PATH}
          pathLength={1}
          fill="none"
          stroke={`url(#${inkId})`}
          strokeWidth={34}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${edgeId})`}
        />
        <path
          className="phi-mark-stroke"
          d={PHI_MARK_PATH}
          pathLength={1}
          fill="none"
          stroke={`url(#${inkId})`}
          strokeWidth={22}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.72}
        />

        {!reducedMotion && (
          <g className="phi-mark-brush" filter={`url(#${shadowId})`}>
            <animateMotion
              path={PHI_MARK_PATH}
              dur={`${CYCLE_SECONDS}s`}
              repeatCount="indefinite"
              keyTimes="0;0.1;0.72;1"
              keyPoints="0;0;1;1"
              calcMode="linear"
            />
            <path d="M0 0 Q8 -5 20 -27 L28 -20 Q10 -4 0 0" fill={colors[3]} />
            <path d="M20 -27 L36 -44 L44 -36 L28 -19 Z" fill={alpha(theme.palette.text.primary, 0.7)} />
            <path d="M23 -27 L39 -41" stroke={alpha(theme.palette.background.paper, 0.7)} strokeWidth="3" />
            <path
              d="M35 -43 L91 -99 Q99 -107 105 -101 Q111 -95 102 -86 L43 -35 Z"
              fill={theme.palette.text.primary}
            />
            <path d="M43 -42 L99 -98" stroke={alpha(theme.palette.background.paper, 0.48)} strokeWidth="4" strokeLinecap="round" />
            <circle cx="0" cy="0" r="5" fill={colors[0]} />
          </g>
        )}
      </g>
    </Box>
  )
}

