import { Box, Stack, Typography } from '@mui/material'
import { useMemo, type ReactNode } from 'react'
import type { DbQueryToolDetails, DbResultViewerHint } from '../../../../../shared/dbConnectorTypes'
import { dbQueryDetailsFromToolOutput } from '../lib/dbResultViewers'
import { InteractionNetworkResultPreview } from './viewers/InteractionNetworkResultPreview'
import { ProteinStructureResultPreview } from './viewers/ProteinStructureResultPreview'
import { SmallMoleculeResultPreview } from './viewers/SmallMoleculeResultPreview'

function rowsFromDetails(details: DbQueryToolDetails): Record<string, unknown>[] {
  return details.mode === 'inline' ? details.rows : details.sampleRows
}

function renderViewerHint(hint: DbResultViewerHint, rows: Record<string, unknown>[]): ReactNode {
  switch (hint.kind) {
    case 'protein_structure':
      return <ProteinStructureResultPreview hint={hint} rows={rows} />
    case 'small_molecule':
      return <SmallMoleculeResultPreview hint={hint} rows={rows} />
    case 'interaction_network':
      return <InteractionNetworkResultPreview hint={hint} rows={rows} />
    default:
      return null
  }
}

export function DbQueryResultPreview({ output }: { output: string }): ReactNode {
  const details = useMemo(() => dbQueryDetailsFromToolOutput(output), [output])
  const hints = details?.viewerHints ?? []
  if (hints.length === 0) return null
  const rows = details ? rowsFromDetails(details) : []

  return (
    <Box sx={{ mb: 1.25, minWidth: 0 }}>
      <Typography
        variant="caption"
        component="div"
        sx={{ mb: 0.75, color: 'text.secondary', fontWeight: 600 }}
      >
        数据库结果展示
      </Typography>
      <Stack spacing={0.75}>
        {hints.map((hint) => (
          <Box key={hint.kind}>{renderViewerHint(hint, rows)}</Box>
        ))}
      </Stack>
    </Box>
  )
}
