import { Box, InputAdornment, TextField, Typography } from '@mui/material'
import { PhiIcons } from '../../../icons'
import type { CustomConnectorEntry, CustomConnectorServerEntry } from '../lib/customConnectorGroup'
import { McpCustomConnectorCard, McpCustomConnectorEmptyState } from './McpCustomConnectorCard'

export function McpCustomConnectorGroup({
  entries,
  query,
  busy,
  onQueryChange,
  onOpen,
  onViewJob
}: {
  entries: readonly CustomConnectorEntry[]
  query: string
  busy: boolean
  onQueryChange: (value: string) => void
  onOpen: (entry: CustomConnectorServerEntry) => void
  onViewJob: (jobId: string) => void
}): React.JSX.Element {
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? entries.filter((entry) =>
        [entry.name, entry.subtitle].some((value) => value.toLowerCase().includes(normalizedQuery))
      )
    : entries
  // Preserve the helper's job-first/name order; catalog sort and sign-in filters do not apply.

  return (
    <>
      <TextField
        size="small"
        placeholder="搜索连接器"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <PhiIcons.action.search fontSize="small" />
              </InputAdornment>
            )
          }
        }}
        sx={{ width: { xs: 220, md: 320 }, mb: 2 }}
      />
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
        normalizedQuery ? (
          <Typography color="text.secondary" sx={{ mt: 2 }}>
            没有符合条件的连接器
          </Typography>
        ) : (
          <McpCustomConnectorEmptyState />
        )
      ) : null}
    </>
  )
}
