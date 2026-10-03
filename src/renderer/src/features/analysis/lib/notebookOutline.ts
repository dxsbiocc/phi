const outlineMarkerActiveWidth = 22
const outlineMarkerMinWidth = 6

export function outlineMarkerWidth(distance: number): number {
  if (distance <= 0) return outlineMarkerActiveWidth
  const falloff = Math.exp(-distance * 0.35)
  const wave = 0.42 + 0.58 * Math.abs(Math.sin(distance * 1.2))
  const width = outlineMarkerMinWidth + 8 * falloff * wave
  return Math.round(width * 10) / 10
}
