import { useUiLanguage } from '../../../lib/i18n'
import { connectorCopy } from '../lib/connectorCopy'
import { Box, Typography } from '@mui/material'
import {
  filterCustomConnectorEntries,
  type CustomConnectorEntry,
  type CustomConnectorServerEntry
} from '../lib/customConnectorGroup'
import type {
  ConnectorInstallFilter,
  ConnectorSignInFilter,
  ConnectorSort
} from '../lib/featuredConnectorFilters'
import { McpCustomConnectorCard, McpCustomConnectorEmptyState } from './McpCustomConnectorCard'

export function McpCustomConnectorGroup({
  entries,
  query,
  signIn = 'all',
  install = 'all',
  sort = 'default',
  busy,
  onOpen,
  onViewJob
}: {
  entries: readonly CustomConnectorEntry[]
  query: string
  signIn?: ConnectorSignInFilter
  install?: ConnectorInstallFilter
  sort?: ConnectorSort
  busy: boolean
  onOpen: (entry: CustomConnectorServerEntry) => void
  onViewJob: (jobId: string) => void
}): React.JSX.Element {
  useUiLanguage()

  const filtered = filterCustomConnectorEntries(entries, { query, signIn, install, sort })
  const filteredEmpty = query.trim().length > 0 || signIn !== 'all' || install !== 'all'

  return (
    <>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 1.5
        }}
      >
        {filtered.map((entry) => (
          <McpCustomConnectorCard
            key={`${entry.kind}:${entry.kind === 'server' ? entry.server.id : entry.job.id}`}
            entry={entry}
            busy={busy}
            onOpen={() => {
              if (entry.kind === 'server') onOpen(entry)
            }}
            onViewJob={onViewJob}
          />
        ))}
      </Box>
      {filtered.length === 0 ? (
        filteredEmpty ? (
          <Typography color="text.secondary" sx={{ mt: 2 }}>
            {connectorCopy.noMatches}
          </Typography>
        ) : (
          <McpCustomConnectorEmptyState />
        )
      ) : null}
    </>
  )
}
