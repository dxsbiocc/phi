import { alpha, Box, useMediaQuery, useTheme, type Theme } from '@mui/material'
import { useEffect, useId, useRef } from 'react'
import { PHI_MARK_PATH } from '../../../../../shared/phiMark'
import { phiMarkFrameAt } from '../lib/phiMarkMotion'

type MarkIds = { ink: string; wash: string; edge: string; shadow: string }
type PaintColors = readonly [string, string, string, string, string]

/** A watercolor brush paints a lowercase phi on a transparent surface. */
export function PhiMark({ size = 76 }: { size?: number }): React.JSX.Element {
  const theme = useTheme()
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const svgRef = useRef<SVGSVGElement>(null)
  const id = useId().replace(/:/g, '')
  const ids: MarkIds = {
    ink: `phi-ink-${id}`,
    wash: `phi-wash-${id}`,
    edge: `phi-edge-${id}`,
    shadow: `phi-brush-shadow-${id}`
  }
  const colors: PaintColors = [
    theme.palette.primary.main,
    theme.palette.info.main,
    theme.palette.success.main,
    theme.palette.warning.main,
    theme.palette.error.main
  ]

  useEffect(() => {
    const svg = svgRef.current
    const path = svg?.querySelector<SVGPathElement>('.phi-mark-stroke')
    const ink = svg?.querySelector<SVGGElement>('.phi-mark-ink')
    if (!path || !ink) return
    if (reducedMotion) {
      ink.removeAttribute('stroke-dasharray')
      ink.removeAttribute('stroke-dashoffset')
      ink.setAttribute('opacity', '1')
      return
    }

    const brush = svg?.querySelector<SVGGElement>('.phi-mark-brush')
    if (!brush) return
    const pathLength = path.getTotalLength()
    if (!Number.isFinite(pathLength) || pathLength <= 0) return
    ink.setAttribute('stroke-dasharray', String(pathLength))

    let startTime: number | null = null
    let frameId = 0
    const paint = (now: number): void => {
      startTime ??= now
      const frame = phiMarkFrameAt(now - startTime, pathLength)
      const tip = path.getPointAtLength(frame.brushDistance)
      ink.setAttribute('stroke-dashoffset', String(frame.strokeDashOffset))
      ink.setAttribute('opacity', String(frame.inkOpacity))
      brush.setAttribute('transform', `translate(${tip.x} ${tip.y})`)
      brush.setAttribute('opacity', String(frame.brushOpacity))
      frameId = window.requestAnimationFrame(paint)
    }
    frameId = window.requestAnimationFrame(paint)

    return () => window.cancelAnimationFrame(frameId)
  }, [reducedMotion])

  return (
    <Box
      component="svg"
      ref={svgRef}
      data-phi-home-mark="true"
      viewBox="0 0 120 120"
      aria-hidden
      sx={{ width: size, height: size, display: 'block', flexShrink: 0, overflow: 'visible' }}
    >
      <MarkDefinitions ids={ids} colors={colors} />
      <g transform="translate(1 6) scale(0.22)">
        <g className="phi-mark-ink" opacity={reducedMotion ? 1 : 0}>
          <WatercolorStroke ids={ids} />
        </g>
        {!reducedMotion && <WatercolorBrush theme={theme} colors={colors} shadowId={ids.shadow} />}
      </g>
    </Box>
  )
}

function MarkDefinitions({
  ids,
  colors
}: {
  ids: MarkIds
  colors: PaintColors
}): React.JSX.Element {
  return (
    <defs>
      <linearGradient
        id={ids.ink}
        x1="120"
        y1="110"
        x2="390"
        y2="400"
        gradientUnits="userSpaceOnUse"
      >
        {colors.map((color, index) => (
          <stop key={index} offset={`${index * 25}%`} stopColor={color} />
        ))}
      </linearGradient>
      <filter id={ids.wash} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="11" />
      </filter>
      <filter id={ids.edge} x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.04"
          numOctaves="2"
          seed="7"
          result="grain"
        />
        <feDisplacementMap in="SourceGraphic" in2="grain" scale="7" />
      </filter>
      <filter id={ids.shadow} x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="2" dy="3" stdDeviation="3" floodOpacity="0.22" />
      </filter>
    </defs>
  )
}

function WatercolorStroke({ ids }: { ids: MarkIds }): React.JSX.Element {
  const ink = `url(#${ids.ink})`
  return (
    <>
      <path
        className="phi-mark-stroke"
        d={PHI_MARK_PATH}
        fill="none"
        stroke={ink}
        strokeWidth={68}
        strokeLinecap="round"
        strokeOpacity={0.3}
        filter={`url(#${ids.wash})`}
      />
      <path
        className="phi-mark-stroke"
        d={PHI_MARK_PATH}
        fill="none"
        stroke={ink}
        strokeWidth={34}
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${ids.edge})`}
      />
      <path
        className="phi-mark-stroke"
        d={PHI_MARK_PATH}
        fill="none"
        stroke={ink}
        strokeWidth={22}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity={0.72}
      />
    </>
  )
}

function WatercolorBrush({
  theme,
  colors,
  shadowId
}: {
  theme: Theme
  colors: PaintColors
  shadowId: string
}): React.JSX.Element {
  return (
    <g className="phi-mark-brush" filter={`url(#${shadowId})`} opacity={0}>
      <path d="M0 0 Q10 -8 23 -33 L34 -23 Q13 -4 0 0" fill={colors[3]} />
      <path d="M23 -34 L42 -53 L55 -40 L35 -21 Z" fill={alpha(theme.palette.text.primary, 0.72)} />
      <path
        d="M29 -35 L47 -49"
        stroke={alpha(theme.palette.background.paper, 0.72)}
        strokeWidth="4"
      />
      <path
        d="M41 -52 L107 -118 Q116 -127 124 -119 Q132 -111 122 -100 L53 -40 Z"
        fill={theme.palette.warning.dark}
      />
      <path
        d="M52 -48 L118 -113"
        stroke={alpha(theme.palette.background.paper, 0.64)}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle cx="0" cy="0" r="5" fill={colors[0]} />
    </g>
  )
}
