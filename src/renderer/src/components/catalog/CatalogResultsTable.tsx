import { useUiLanguage } from '../../lib/i18n'
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
import { resourceCatalogCopy, resourceUi } from '../../lib/resourceUi'
import { CATALOG_SCROLLBAR_GUTTER } from './catalogPaging'

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

const catalogHeaderCellSx = {
  py: 1.25,
  px: 2,
  bgcolor: 'action.hover',
  color: 'text.secondary',
  fontWeight: 600,
  lineHeight: '24px',
  borderBottom: 'none',
  whiteSpace: 'nowrap'
} as const

/** Catalog rows share one header bar so category switches do not change column chrome. */
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
  useUiLanguage()

  return (
    <TableContainer
      data-phi-catalog-table-scroll="true"
      sx={{
        flex: rows.length > 0 ? 1 : '0 0 auto',
        // The gutter always occupies the layout's right padding, so 10 rows and fewer than 10 share one content edge.
        width: `calc(100% + ${CATALOG_SCROLLBAR_GUTTER})`,
        mr: `-${CATALOG_SCROLLBAR_GUTTER}`,
        minWidth: 0,
        alignSelf: 'stretch',
        minHeight: 0,
        overflow: 'auto',
        scrollbarGutter: 'stable',
        borderRadius: 2
      }}
    >
      <Table
        size="small"
        stickyHeader
        aria-label={label}
        sx={{ width: '100%', tableLayout: 'fixed' }}
      >
        <TableHead>
          <TableRow>
            <TableCell sx={{ ...catalogHeaderCellSx, borderTopLeftRadius: 8 }}>
              {nameLabel}
            </TableCell>
            <TableCell
              sx={{ ...catalogHeaderCellSx, width: 112, display: { xs: 'none', sm: 'table-cell' } }}
            >
              {resourceUi.source}
            </TableCell>
            <TableCell
              sx={{ ...catalogHeaderCellSx, width: 144, display: { xs: 'none', sm: 'table-cell' } }}
            >
              {detailsLabel}
            </TableCell>
            <TableCell
              align="right"
              sx={{ ...catalogHeaderCellSx, width: 120, borderTopRightRadius: 8 }}
            >
              {resourceCatalogCopy.actions}
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
              <TableCell sx={{ pl: 2 }}>
                <Box
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}
                  {...(onOpen
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': resourceCatalogCopy.viewDetails(row.title),
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
