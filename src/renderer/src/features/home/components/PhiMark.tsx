import { Box } from '@mui/material'
import { useId, type CSSProperties } from 'react'
import { PHI_MARK_PATH } from '../../../../../shared/phiMark'

const CYCLE_SECONDS = 4.8
const DRAW_START = 0.12
const DRAW_END = 0.58
const PHI_TRACE = 'phi-mark-trace'
const PHI_BREATH = 'phi-mark-breath'
const PHI_SCATTER = 'phi-mark-scatter'

// Sampled along PHI_MARK_PATH in drawing order. Each fleck starts beside the wet stroke.
const pigment = [
  [159, 154, 10, 0],
  [124, 180, -36, -21],
  [138, 222, 60, 1],
  [118, 267, -40, 17],
  [162, 287, 34, -45],
  [177, 337, 0, 16],
  [224, 309, -6, -39],
  [266, 349, 7, 60],
  [299, 309, -3, -47],
  [343, 308, 19, 29],
  [354, 262, -22, -15],
  [396, 238, 48, 18],
  [368, 195, -62, -11],
  [391, 147, 30, -23],
  [337, 142, -17, 39],
  [309, 107, -10, -20],
  [280, 138, 29, 13],
  [242, 161, -43, -23],
  [262, 205, 26, 1],
  [231, 245, -48, 7],
  [265, 286, 38, -16],
  [227, 325, -51, -8],
  [266, 369, 54, 9],
  [224, 401, -24, -6]
] as const

const markSx = {
  display: 'block',
  flexShrink: 0,
  overflow: 'visible',
  transformOrigin: 'center',
  animation: `${PHI_BREATH} ${CYCLE_SECONDS}s ease-in-out infinite`,
  [`@keyframes ${PHI_BREATH}`]: {
    '0%, 100%': { transform: 'scale(1)' },
    '50%': { transform: 'scale(1.035)' }
  },
  [`@keyframes ${PHI_TRACE}`]: {
    '0%, 12%': { strokeDashoffset: 1 },
    '58%, 100%': { strokeDashoffset: 0 }
  },
  [`@keyframes ${PHI_SCATTER}`]: {
    '0%': { opacity: 0, transform: 'translate(0, 0) scale(0.45)' },
    '2%': { opacity: 0.85 },
    '13%': {
      opacity: 0.46,
      transform: 'translate(var(--scatter-x), var(--scatter-y)) scale(1.2)'
    },
    '25%, 100%': {
      opacity: 0,
      transform: 'translate(var(--scatter-x), var(--scatter-y)) scale(0.3)'
    }
  },
  '& .phi-mark-stroke': {
    strokeDasharray: 1,
    strokeDashoffset: 1,
    animation: `${PHI_TRACE} ${CYCLE_SECONDS}s linear infinite`
  },
  '& .phi-mark-particle': {
    opacity: 0,
    transformBox: 'fill-box',
    transformOrigin: 'center',
    animation: `${PHI_SCATTER} ${CYCLE_SECONDS}s ease-out infinite`
  },
  '@media (prefers-reduced-motion: reduce)': {
    animation: 'none',
    '& .phi-mark-stroke': { animation: 'none', strokeDashoffset: 0 },
    '& .phi-mark-particle': { animation: 'none', opacity: 0 }
  }
} as const

type MarkIds = {
  inkId: string
  fleckId: string
  washId: string
  edgeId: string
}

/** Transparent watercolor phi with pigment released as the stroke is drawn. */
export function PhiMark({ size = 76 }: { size?: number }): React.JSX.Element {
  const id = useId().replace(/:/g, '')
  const inkId = `phi-ink-${id}`
  const fleckId = `phi-fleck-${id}`
  const washId = `phi-wash-${id}`
  const edgeId = `phi-edge-${id}`

  return (
    <Box
      component="svg"
      data-phi-home-mark="true"
      viewBox="72 64 376 392"
      aria-hidden
      sx={{ width: size, height: size, ...markSx }}
    >
      <PhiMarkDefinitions inkId={inkId} fleckId={fleckId} washId={washId} edgeId={edgeId} />
      <path
        className="phi-mark-stroke"
        d={PHI_MARK_PATH}
        pathLength={1}
        fill="none"
        stroke={`url(#${inkId})`}
        strokeWidth={62}
        strokeLinecap="round"
        opacity={0.28}
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
        stroke="#D3FFE5"
        strokeWidth={10}
        strokeLinecap="round"
        opacity={0.3}
      />
      {pigment.map(([x, y, driftX, driftY], index) => (
        <circle
          key={index}
          className="phi-mark-particle"
          cx={x}
          cy={y}
          r={5 + ((index * 5) % 8)}
          fill={index % 4 === 0 ? '#1DBF8A' : `url(#${fleckId})`}
          style={
            {
              animationDelay: `${(DRAW_START + ((index + 0.6) / pigment.length) * (DRAW_END - DRAW_START)) * CYCLE_SECONDS}s`,
              '--scatter-x': `${driftX}px`,
              '--scatter-y': `${driftY}px`
            } as CSSProperties
          }
        />
      ))}
    </Box>
  )
}

function PhiMarkDefinitions({ inkId, fleckId, washId, edgeId }: MarkIds): React.JSX.Element {
  return (
    <defs>
      <linearGradient id={inkId} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#72E8B3" />
        <stop offset="0.48" stopColor="#00B67B" />
        <stop offset="1" stopColor="#008B79" />
      </linearGradient>
      <radialGradient id={fleckId}>
        <stop offset="0" stopColor="#0CB88A" stopOpacity="0.8" />
        <stop offset="0.45" stopColor="#36D7A1" stopOpacity="0.48" />
        <stop offset="1" stopColor="#72E8B3" stopOpacity="0" />
      </radialGradient>
      <filter id={washId} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="11" />
      </filter>
      <filter id={edgeId} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.035"
          numOctaves="2"
          seed="7"
          result="grain"
        />
        <feDisplacementMap in="SourceGraphic" in2="grain" scale="7" />
      </filter>
    </defs>
  )
}
