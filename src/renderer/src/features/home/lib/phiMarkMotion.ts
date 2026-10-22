export const PHI_MARK_CYCLE_MS = 6400

export type PhiMarkFrame = {
  brushDistance: number
  strokeDashOffset: number
  inkOpacity: number
  brushOpacity: number
}

function ramp(value: number, start: number, end: number): number {
  return Math.min(1, Math.max(0, (value - start) / (end - start)))
}

/** The same measured path distance drives the brush tip and the visible stroke. */
export function phiMarkFrameAt(elapsedMs: number, pathLength: number): PhiMarkFrame {
  const phase =
    (((elapsedMs % PHI_MARK_CYCLE_MS) + PHI_MARK_CYCLE_MS) % PHI_MARK_CYCLE_MS) / PHI_MARK_CYCLE_MS
  const brushDistance = pathLength * ramp(phase, 0.1, 0.72)

  return {
    brushDistance,
    strokeDashOffset: pathLength - brushDistance,
    inkOpacity: 1 - ramp(phase, 0.88, 0.96),
    brushOpacity: Math.min(ramp(phase, 0.06, 0.1), 1 - ramp(phase, 0.72, 0.76))
  }
}
