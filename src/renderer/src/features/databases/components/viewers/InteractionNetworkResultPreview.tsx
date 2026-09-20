import { Box, Chip, Stack, Typography } from '@mui/material'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type cytoscape from 'cytoscape'
import type { DbResultViewerHint } from '../../../../../../shared/dbConnectorTypes'

const CONFIDENCE_LABELS: Record<DbResultViewerHint['confidence'], string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信'
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function networkElements(
  hint: DbResultViewerHint,
  rows: Record<string, unknown>[]
): cytoscape.ElementDefinition[] {
  const [sourceField, targetField] = hint.fields
  if (!sourceField || !targetField) return []

  const nodes = new Map<string, cytoscape.ElementDefinition>()
  const edges: cytoscape.ElementDefinition[] = []
  rows.forEach((row, index) => {
    const source = stringValue(row[sourceField])
    const target = stringValue(row[targetField])
    if (!source || !target) return
    nodes.set(source, { data: { id: source, label: source } })
    nodes.set(target, { data: { id: target, label: target } })
    edges.push({
      data: {
        id: `${source}-${target}-${index}`,
        source,
        target,
        label: stringValue(row[hint.fields[2]]) ?? ''
      }
    })
  })
  return [...nodes.values(), ...edges]
}

export function InteractionNetworkResultPreview({
  hint,
  rows
}: {
  hint: DbResultViewerHint
  rows: Record<string, unknown>[]
}): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const elements = useMemo(() => networkElements(hint, rows), [hint, rows])
  const edgeCount = elements.filter((element) => 'source' in element.data).length

  useEffect(() => {
    const container = containerRef.current
    if (!container || edgeCount === 0) return
    let cy: cytoscape.Core | null = null
    let cancelled = false

    void import('cytoscape').then(({ default: cytoscapeFactory }) => {
      if (cancelled) return
      cy = cytoscapeFactory({
        container,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'background-color': '#2E9FB3',
              color: '#DDECEF',
              'font-size': 10,
              'text-valign': 'center',
              'text-halign': 'center',
              width: 36,
              height: 36,
              'text-outline-color': '#0B262D',
              'text-outline-width': 2
            }
          },
          {
            selector: 'edge',
            style: {
              width: 2,
              'line-color': '#93AEB4',
              'target-arrow-color': '#93AEB4',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              label: 'data(label)',
              color: '#8CA4AA',
              'font-size': 9,
              'text-rotation': 'autorotate'
            }
          }
        ],
        layout: {
          name: 'cose',
          animate: false,
          fit: true,
          padding: 18
        },
        wheelSensitivity: 0.25,
        minZoom: 0.4,
        maxZoom: 2.5
      })
    })

    return () => {
      cancelled = true
      cy?.destroy()
    }
  }, [edgeCount, elements])

  return (
    <Box
      sx={{
        p: 1.25,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.default',
        minWidth: 0
      }}
    >
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {hint.label}
          </Typography>
          <Chip size="small" label="Cytoscape.js" />
          <Chip size="small" variant="outlined" label={CONFIDENCE_LABELS[hint.confidence]} />
          <Chip size="small" variant="outlined" label={`${hint.rowCount} 行`} />
        </Stack>

        {edgeCount > 0 ? (
          <Box
            ref={containerRef}
            sx={{
              height: 240,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: '#081E24',
              overflow: 'hidden'
            }}
          />
        ) : (
          <Typography variant="caption" color="text.secondary">
            没有可渲染的 source/target 互作边。
          </Typography>
        )}

        {hint.sampleValues.length > 0 ? (
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
            {hint.sampleValues.map((value) => (
              <Chip
                key={value}
                size="small"
                variant="outlined"
                label={value}
                sx={{
                  maxWidth: '100%',
                  '& .MuiChip-label': {
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'block'
                  }
                }}
              />
            ))}
          </Stack>
        ) : null}

        {hint.fields.length > 0 ? (
          <Typography
            variant="caption"
            component="div"
            sx={{
              color: 'text.secondary',
              fontFamily: 'var(--font-mono)',
              overflowWrap: 'anywhere'
            }}
          >
            {hint.fields.join(', ')}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  )
}
