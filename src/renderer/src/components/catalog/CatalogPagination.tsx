import { TablePagination } from '@mui/material'

const pageLabels = { first: '第一页', previous: '上一页', next: '下一页', last: '最后一页' }

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
  return (
    <TablePagination
      component="nav"
      aria-label="目录分页"
      count={count}
      page={page}
      rowsPerPage={rowsPerPage}
      onPageChange={(_, nextPage) => onPageChange(nextPage)}
      onRowsPerPageChange={(event) => onRowsPerPageChange(Number(event.target.value))}
      rowsPerPageOptions={[10, 20, 50]}
      labelRowsPerPage="每页"
      labelDisplayedRows={({ from, to, count }) => `${from}–${to} / ${count}`}
      getItemAriaLabel={(type) => pageLabels[type]}
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
