import { Box, Chip, Stack, Typography } from '@mui/material'
import { useMemo, type ReactNode } from 'react'
import {
  MolstarStructureViewer,
  type MolstarStructureSource
} from '../../../../components/MolstarStructureViewer'
import type { DbResultViewerHint } from '../../../../../../shared/dbConnectorTypes'

const CONFIDENCE_LABELS: Record<DbResultViewerHint['confidence'], string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信'
}

type StructureSource =
  | { kind: 'pdb'; value: string; label: string }
  | { kind: 'url'; value: string; label: string; format: 'mmcif' | 'pdb' }

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function structureSource(
  hint: DbResultViewerHint,
  rows: Record<string, unknown>[]
): StructureSource | null {
  for (const row of rows) {
    for (const field of hint.fields) {
      const value = stringValue(row[field])
      if (!value) continue
      const pdbId = value.match(/\b[0-9][A-Za-z0-9]{3}\b/)?.[0]
      if (pdbId) return { kind: 'pdb', value: pdbId.toUpperCase(), label: field }
      if (/^https?:\/\//.test(value)) {
        const lower = value.toLowerCase()
        return {
          kind: 'url',
          value,
          label: field,
          format: lower.endsWith('.pdb') ? 'pdb' : 'mmcif'
        }
      }
    }
  }

  for (const sample of hint.sampleValues) {
    const pdbId = sample.match(/\b[0-9][A-Za-z0-9]{3}\b/)?.[0]
    if (pdbId) return { kind: 'pdb', value: pdbId.toUpperCase(), label: 'sample' }
    if (/^https?:\/\//.test(sample)) {
      return {
        kind: 'url',
        value: sample,
        label: 'sample',
        format: sample.toLowerCase().endsWith('.pdb') ? 'pdb' : 'mmcif'
      }
    }
  }
  return null
}

export function ProteinStructureResultPreview({
  hint,
  rows
}: {
  hint: DbResultViewerHint
  rows: Record<string, unknown>[]
}): ReactNode {
  const source = useMemo(() => structureSource(hint, rows), [hint, rows])
  const molstarSource = useMemo<MolstarStructureSource | null>(() => {
    if (!source) return null
    if (source.kind === 'pdb') return { kind: 'pdb-id', value: source.value, label: source.label }
    return {
      kind: 'url',
      value: source.value,
      format: source.format,
      label: source.label
    }
  }, [source])

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
          <Chip size="small" label="Mol*" />
          <Chip size="small" variant="outlined" label={CONFIDENCE_LABELS[hint.confidence]} />
          <Chip size="small" variant="outlined" label={`${hint.rowCount} 行`} />
        </Stack>

        {source ? (
          <MolstarStructureViewer source={molstarSource} />
        ) : (
          <MolstarStructureViewer source={null} />
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
