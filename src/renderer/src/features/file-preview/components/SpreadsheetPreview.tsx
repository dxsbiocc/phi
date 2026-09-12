import { Box, Typography } from '@mui/material'
import { Fragment } from 'react'
import {
  spreadsheetColumnLabel,
  type SpreadsheetPreviewModel
} from '../../../lib/spreadsheetPreview'

export function SpreadsheetPreview({
  model
}: {
  model: SpreadsheetPreviewModel
}): React.JSX.Element {
  const firstCell = model.rows[0]?.[0] ?? ''
  const columns = Array.from({ length: model.columnCount }, (_, index) =>
    spreadsheetColumnLabel(index)
  )
  const gridTemplateColumns = `48px repeat(${model.columnCount}, minmax(108px, 180px))`

  return (
    <Box
      data-phi-spreadsheet-preview="true"
      data-phi-spreadsheet-format={model.format}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0
        }}
      >
        <Box
          component="span"
          data-phi-spreadsheet-name-box="true"
          sx={{
            flex: '0 0 64px',
            minWidth: 0,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            px: 1,
            py: 0.35,
            bgcolor: 'background.paper',
            color: 'text.secondary',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            textAlign: 'center'
          }}
        >
          A1
        </Box>
        <Box
          component="span"
          data-phi-spreadsheet-formula-bar="true"
          title={firstCell}
          sx={{
            flex: 1,
            minWidth: 0,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            px: 1,
            py: 0.35,
            bgcolor: 'background.paper',
            color: 'text.primary',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {firstCell}
        </Box>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns,
            minWidth: 'max-content',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            lineHeight: 1.45
          }}
        >
          <Box
            data-phi-spreadsheet-corner="true"
            sx={{
              position: 'sticky',
              top: 0,
              left: 0,
              zIndex: 4,
              height: 30,
              borderRight: 1,
              borderBottom: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper'
            }}
          />
          {columns.map((column) => (
            <Box
              key={column}
              data-phi-spreadsheet-column={column}
              sx={{
                position: 'sticky',
                top: 0,
                zIndex: 3,
                height: 30,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRight: 1,
                borderBottom: 1,
                borderColor: 'divider',
                bgcolor: 'background.paper',
                color: 'text.secondary',
                userSelect: 'none'
              }}
            >
              {column}
            </Box>
          ))}
          {model.rows.map((row, rowIndex) => (
            <Fragment key={`row-${rowIndex}`}>
              <Box
                component="span"
                data-phi-spreadsheet-row={rowIndex + 1}
                sx={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 2,
                  height: 30,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  pr: 1,
                  borderRight: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  color: 'text.secondary',
                  userSelect: 'none'
                }}
              >
                {rowIndex + 1}
              </Box>
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex] ?? ''
                const isActive = rowIndex === 0 && columnIndex === 0

                return (
                  <Box
                    key={`${rowIndex}-${columnIndex}`}
                    component="span"
                    data-phi-spreadsheet-cell={`${spreadsheetColumnLabel(columnIndex)}${rowIndex + 1}`}
                    title={value}
                    sx={{
                      height: 30,
                      minWidth: 0,
                      display: 'flex',
                      alignItems: 'center',
                      px: 1,
                      borderRight: 1,
                      borderBottom: 1,
                      borderColor: 'divider',
                      bgcolor: 'background.default',
                      color: 'text.primary',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      boxShadow: isActive
                        ? (theme) => `inset 0 0 0 2px ${theme.palette.primary.main}`
                        : 'none'
                    }}
                  >
                    {value}
                  </Box>
                )
              })}
            </Fragment>
          ))}
        </Box>
      </Box>
      {model.rowsTruncated || model.columnsTruncated ? (
        <Typography
          data-phi-spreadsheet-truncated="true"
          variant="caption"
          color="text.secondary"
          sx={{ px: 1.25, py: 0.6, borderTop: 1, borderColor: 'divider', flexShrink: 0 }}
        >
          已显示前 {model.rows.length} 行、{model.columnCount} 列
        </Typography>
      ) : null}
    </Box>
  )
}
