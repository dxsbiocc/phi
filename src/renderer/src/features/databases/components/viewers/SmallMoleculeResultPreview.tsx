import { Box, Chip, Stack, Typography } from '@mui/material'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MainModule } from '@rdkit/rdkit'
import type { DbResultViewerHint } from '../../../../../../shared/dbConnectorTypes'

const rdkitWasmUrl = new URL(
  '../../../../../../../node_modules/@rdkit/rdkit/dist/RDKit_minimal.wasm',
  import.meta.url
).href

const CONFIDENCE_LABELS: Record<DbResultViewerHint['confidence'], string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信'
}

const RENDERABLE_FIELD_NAMES = new Set([
  'smiles',
  'canonicalsmiles',
  'isomericsmiles',
  'mol',
  'molblock',
  'molfile',
  'sdf'
])

let rdkitModulePromise: Promise<MainModule> | null = null

function loadRdkit(): Promise<MainModule> {
  rdkitModulePromise ??= import('@rdkit/rdkit').then(({ default: initRDKitModule }) =>
    initRDKitModule({
      locateFile: (file: string) => (file.endsWith('.wasm') ? rdkitWasmUrl : file)
    })
  )
  return rdkitModulePromise
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizedField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isRenderableMoleculeField(field: string): boolean {
  return RENDERABLE_FIELD_NAMES.has(normalizedField(field))
}

function moleculeInput(
  hint: DbResultViewerHint,
  rows: Record<string, unknown>[]
): { field: string; value: string } | null {
  const renderableFields = hint.fields.filter(isRenderableMoleculeField)
  for (const row of rows) {
    for (const field of renderableFields) {
      const value = stringValue(row[field])
      if (value) return { field, value }
    }
  }
  if (renderableFields.length === 0) return null
  const sample = hint.sampleValues.find((value) => value.trim())
  return sample ? { field: renderableFields[0], value: sample } : null
}

type MoleculeRenderState = {
  value: string
  svg?: string
  error?: string
}

function MoleculeExpression({
  input
}: {
  input: { field: string; value: string } | null
}): React.JSX.Element | null {
  if (!input) return null
  return (
    <Box
      data-phi-molecule-expression="true"
      sx={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 0.75,
        minWidth: 0,
        flexWrap: 'wrap'
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {input.field}
      </Typography>
      <Box
        component="code"
        sx={{
          minWidth: 0,
          maxWidth: '100%',
          px: 0.75,
          py: 0.3,
          borderRadius: 1,
          bgcolor: 'rgba(148, 163, 184, 0.15)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.78rem',
          lineHeight: 1.4,
          overflowWrap: 'anywhere'
        }}
      >
        {input.value}
      </Box>
    </Box>
  )
}

export function SmallMoleculeResultPreview({
  hint,
  rows
}: {
  hint: DbResultViewerHint
  rows: Record<string, unknown>[]
}): ReactNode {
  const input = useMemo(() => moleculeInput(hint, rows), [hint, rows])
  const [renderState, setRenderState] = useState<MoleculeRenderState | null>(null)
  const activeRenderState = renderState?.value === input?.value ? renderState : null
  const svg = activeRenderState?.svg
  const error = activeRenderState?.error

  useEffect(() => {
    let cancelled = false
    if (!input) return

    void loadRdkit()
      .then((rdkit) => {
        if (cancelled) return
        const molecule = rdkit.get_mol(input.value)
        if (!molecule) {
          setRenderState({ value: input.value, error: `RDKit 无法解析 ${input.field}` })
          return
        }
        try {
          setRenderState({ value: input.value, svg: molecule.get_svg(320, 220) })
        } finally {
          molecule.delete()
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setRenderState({
          value: input.value,
          error: loadError instanceof Error ? loadError.message : String(loadError)
        })
      })

    return () => {
      cancelled = true
    }
  }, [input])

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
          <Chip size="small" label="RDKit.js" />
          <Chip size="small" variant="outlined" label={CONFIDENCE_LABELS[hint.confidence]} />
          <Chip size="small" variant="outlined" label={`${hint.rowCount} 行`} />
        </Stack>

        <MoleculeExpression input={input} />

        {svg ? (
          <Box
            component="img"
            src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
            alt={input ? `${input.field} molecule structure` : 'Molecule structure'}
            sx={{
              display: 'block',
              width: '100%',
              maxWidth: 360,
              height: 220,
              objectFit: 'contain',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'common.white'
            }}
          />
        ) : (
          <Typography variant="caption" color={error ? 'error.main' : 'text.secondary'}>
            {error ?? (input ? '正在加载 RDKit.js 结构预览...' : '没有可渲染的小分子结构字段')}
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
