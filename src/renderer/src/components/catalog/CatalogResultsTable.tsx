import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from '@mui/material'

export interface CatalogResultRow {
  rowKey: string
  id: string
  title: string
  summary: string
  metadata: string
  details: string
  icon?: React.ReactNode
  action: React.ReactNode
}

/** Catalog rows use the same theme table defaults as the search-engine settings. */
export function CatalogResultsTable({
  label,
  nameLabel,
  detailsLabel,
  rows,
  rowAttribute,
  onOpen
}: {
  label: string
  nameLabel: string
  detailsLabel: string
  rows: readonly CatalogResultRow[]
  rowAttribute: string
  /** When set, clicking a row (or pressing Enter on its name) opens that entry's detail. */
  onOpen?: (id: string) => void
}): React.JSX.Element {
  return (
    <TableContainer
      data-phi-catalog-table-scroll="true"
      sx={{
        flex: rows.length > 0 ? 1 : '0 0 auto',
        minHeight: 0,
        overflow: 'auto',
        borderRadius: 2
      }}
    >
      <Table size="small" stickyHeader aria-label={label} sx={{ tableLayout: 'fixed' }}>
        <TableHead>
          <TableRow sx={{ bgcolor: 'action.hover' }}>
            <TableCell>{nameLabel}</TableCell>
            <TableCell sx={{ width: 112, display: { xs: 'none', sm: 'table-cell' } }}>
              来源
            </TableCell>
            <TableCell sx={{ width: 144, display: { xs: 'none', sm: 'table-cell' } }}>
              {detailsLabel}
            </TableCell>
            <TableCell align="right" sx={{ width: 120 }}>
              操作
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.rowKey}
              hover
              {...{ [rowAttribute]: row.id }}
              {...(onOpen ? { onClick: () => onOpen(row.id) } : {})}
              sx={onOpen ? { cursor: 'pointer' } : undefined}
            >
              <TableCell>
                <Box
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}
                  {...(onOpen
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': `查看 ${row.title} 详情`,
                        onKeyDown: (event: React.KeyboardEvent) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          onOpen(row.id)
                        }
                      }
                    : {})}
                >
                  {row.icon}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                      {row.title}
                    </Typography>
                    {row.summary ? (
                      <Typography variant="body2" color="text.secondary" noWrap title={row.summary}>
                        {row.summary}
                      </Typography>
                    ) : null}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: { xs: 'block', sm: 'none' }, overflowWrap: 'anywhere' }}
                    >
                      {row.metadata} · {row.details}
                    </Typography>
                  </Box>
                </Box>
              </TableCell>
              <TableCell
                sx={{ display: { xs: 'none', sm: 'table-cell' }, overflowWrap: 'anywhere' }}
              >
                {row.metadata}
              </TableCell>
              <TableCell
                sx={{ display: { xs: 'none', sm: 'table-cell' }, overflowWrap: 'anywhere' }}
              >
                {row.details}
              </TableCell>
              <TableCell
                align="right"
                {...(onOpen
                  ? { onClick: (event: React.MouseEvent) => event.stopPropagation() }
                  : {})}
              >
                {row.action}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
