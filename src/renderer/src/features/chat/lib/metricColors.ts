const STATUS_COLOR = {
  ok: 'success',
  warn: 'warning',
  error: 'error',
  neutral: 'grey'
} as const

const FALLBACK_COLORS = ['info', 'secondary', 'primary'] as const

type MetricStatus = keyof typeof STATUS_COLOR | undefined
export type MetricColor =
  (typeof STATUS_COLOR)[keyof typeof STATUS_COLOR] | (typeof FALLBACK_COLORS)[number]

export function metricColorKeys(statuses: MetricStatus[]): MetricColor[] {
  const used = new Set<MetricColor>()
  return statuses.map((status) => {
    const preferred: MetricColor = STATUS_COLOR[status ?? 'neutral']
    const color = used.has(preferred)
      ? (FALLBACK_COLORS.find((candidate) => !used.has(candidate)) ?? preferred)
      : preferred
    used.add(color)
    return color
  })
}
