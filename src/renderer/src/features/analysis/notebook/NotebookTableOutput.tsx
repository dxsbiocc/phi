import { useMemo, useState, type MouseEvent } from 'react'
import { Box, Button, Checkbox, InputBase, Menu, MenuItem, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { TbColumns3 } from 'react-icons/tb'
import { PhiIcons } from '../../../icons'
import { parseHtmlTable } from '../lib/notebookHtmlTable'
import NotebookHtmlFrameOutput from './NotebookFrameOutput'

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function downloadCsv(headers: string[], rows: string[][]): void {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof Blob === 'undefined'
  ) {
    return
  }

  const csv = [headers, ...rows]
    .map((row) => row.map((value) => csvEscape(value ?? '')).join(','))
    .join('\n')
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = 'notebook-table.csv'
  link.click()
  URL.revokeObjectURL(blobUrl)
}

export default function NotebookHtmlTableOutput({
  html,
  notebookPath
}: {
  html: string
  notebookPath?: string | null
}): React.JSX.Element {
  const parsedTable = useMemo(() => parseHtmlTable(html), [html])
  const [query, setQuery] = useState('')
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<Set<number>>(() => new Set())

  if (!parsedTable) {
    return <NotebookHtmlFrameOutput html={html} notebookPath={notebookPath} />
  }

  const table = parsedTable
  const visibleColumnIndexes = table.headers
    .map((_, index) => index)
    .filter((index) => !hiddenColumns.has(index))
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRows = normalizedQuery
    ? table.rows.filter((row) =>
        visibleColumnIndexes.some((columnIndex) =>
          (row[columnIndex] ?? '').toLowerCase().includes(normalizedQuery)
        )
      )
    : table.rows

  function toggleColumn(columnIndex: number): void {
    setHiddenColumns((current) => {
      const next = new Set(current)
      if (next.has(columnIndex)) {
        next.delete(columnIndex)
      } else if (next.size < table.headers.length - 1) {
        next.add(columnIndex)
      }
      return next
    })
  }

  function openColumns(event: MouseEvent<HTMLButtonElement>): void {
    setColumnsAnchor(event.currentTarget)
  }

  return (
    <Box
      data-phi-notebook-output-kind="text/html"
      data-phi-notebook-output-table="true"
      sx={{
        border: 1,
        borderColor: (theme) => alpha(theme.palette.text.primary, 0.1),
        borderRadius: 1.25,
        overflow: 'hidden',
        bgcolor: 'background.paper'
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          display: 'flex',
          gap: 1,
          minHeight: 42,
          px: 1,
          borderBottom: 1,
          borderColor: (theme) => alpha(theme.palette.text.primary, 0.08)
        }}
      >
        <Box sx={{ alignItems: 'center', display: 'flex', flex: 1, gap: 0.75, minWidth: 160 }}>
          <PhiIcons.action.search color="action" fontSize="small" />
          <InputBase
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            inputProps={{ 'aria-label': 'Search table rows' }}
            sx={{
              flex: 1,
              minWidth: 0,
              fontSize: '0.82rem',
              color: 'text.primary',
              '& input::placeholder': { color: 'text.secondary', opacity: 0.85 }
            }}
          />
        </Box>
        <Button
          size="small"
          color="inherit"
          onClick={openColumns}
          startIcon={<TbColumns3 size={15} />}
          sx={{ minWidth: 0, px: 1, color: 'text.secondary', textTransform: 'none' }}
        >
          Columns
        </Button>
        <Button
          size="small"
          color="inherit"
          onClick={() => downloadCsv(table.headers, filteredRows)}
          startIcon={<PhiIcons.action.download fontSize="small" />}
          sx={{ minWidth: 0, px: 1, color: 'text.secondary', textTransform: 'none' }}
        >
          Export
        </Button>
      </Box>
      <Box sx={{ maxHeight: 460, overflow: 'auto' }}>
        <Box
          component="table"
          sx={{
            width: '100%',
            borderCollapse: 'separate',
            borderSpacing: 0,
            tableLayout: 'fixed',
            fontFamily: 'var(--font-sans)',
            fontSize: '0.82rem'
          }}
        >
          <Box component="thead">
            <Box component="tr">
              {visibleColumnIndexes.map((columnIndex) => (
                <Box
                  key={columnIndex}
                  component="th"
                  sx={{
                    p: '9px 10px',
                    textAlign: 'left',
                    verticalAlign: 'bottom',
                    borderRight: 1,
                    borderBottom: 1,
                    borderColor: (theme) => alpha(theme.palette.text.primary, 0.08),
                    color: 'text.secondary',
                    fontWeight: 700,
                    bgcolor: (theme) => alpha(theme.palette.background.default, 0.72),
                    '&:last-of-type': { borderRight: 0 }
                  }}
                >
                  <Typography component="div" sx={{ fontSize: '0.82rem', fontWeight: 700 }}>
                    {table.headers[columnIndex]}
                  </Typography>
                  <Typography
                    component="div"
                    sx={{ mt: 0.25, fontSize: '0.72rem', color: 'text.secondary' }}
                  >
                    {table.columnTypes[columnIndex]}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
          <Box component="tbody">
            {filteredRows.map((row, rowIndex) => (
              <Box key={rowIndex} component="tr">
                {visibleColumnIndexes.map((columnIndex) => (
                  <Box
                    key={columnIndex}
                    component="td"
                    sx={{
                      p: '7px 10px',
                      borderRight: 1,
                      borderBottom: 1,
                      borderColor: (theme) => alpha(theme.palette.text.primary, 0.08),
                      color: 'text.primary',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign:
                        table.columnTypes[columnIndex] === 'float64' ||
                        table.columnTypes[columnIndex] === 'int64'
                          ? 'right'
                          : 'left',
                      '&:last-of-type': { borderRight: 0 }
                    }}
                  >
                    {row[columnIndex] ?? ''}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Box
        sx={{
          alignItems: 'center',
          color: 'text.secondary',
          display: 'flex',
          fontSize: '0.75rem',
          justifyContent: 'space-between',
          minHeight: 34,
          px: 1
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {filteredRows.length} rows, {visibleColumnIndexes.length} columns
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
          No selection
        </Typography>
      </Box>
      <Menu
        anchorEl={columnsAnchor}
        open={Boolean(columnsAnchor)}
        onClose={() => setColumnsAnchor(null)}
      >
        {table.headers.map((header, columnIndex) => (
          <MenuItem key={columnIndex} onClick={() => toggleColumn(columnIndex)} dense>
            <Checkbox
              size="small"
              checked={!hiddenColumns.has(columnIndex)}
              disabled={
                !hiddenColumns.has(columnIndex) && hiddenColumns.size >= table.headers.length - 1
              }
            />
            {header}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  )
}
