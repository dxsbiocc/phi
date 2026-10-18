import { useUiLanguage } from '../../lib/i18n'
import { TablePagination } from '@mui/material'
import { resourceCatalogCopy } from '../../lib/resourceUi'

export function CatalogPagination({
  count,
  page,
  rowsPerPage,
  onPageChange,
  onRowsPerPageChange
}: {
  count: number
  page: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  onRowsPerPageChange: (rowsPerPage: number) => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <TablePagination
      component="nav"
      aria-label={resourceCatalogCopy.pagination}
      count={count}
      page={page}
      rowsPerPage={rowsPerPage}
      onPageChange={(_, nextPage) => onPageChange(nextPage)}
      onRowsPerPageChange={(event) => onRowsPerPageChange(Number(event.target.value))}
      rowsPerPageOptions={[10, 20, 50]}
      labelRowsPerPage={resourceCatalogCopy.rowsPerPage}
      labelDisplayedRows={({ from, to, count }) => `${from}–${to} / ${count}`}
      getItemAriaLabel={(type) => resourceCatalogCopy.pages[type]}
      showFirstButton
      showLastButton
      sx={{
        '& .MuiTablePagination-toolbar': { flexWrap: 'wrap', px: 0 },
        '& .MuiTablePagination-spacer': {
          display: { xs: 'none', sm: 'block' },
          flex: '1 1 auto'
        },
        '& .MuiTablePagination-displayedRows': { mx: 2 },
        '& .MuiTablePagination-actions': { ml: { xs: 'auto', sm: 2 } }
      }}
    />
  )
}
