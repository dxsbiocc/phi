import { chatCopy } from '../../lib/chatCopy'
import { useUiLanguage } from '../../../../lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip
} from '@mui/material'
import { GoCopy } from 'react-icons/go'

import type { TableUiBlock } from '../../../../../../shared/uiBlockTypes'
import { sortTableRows, type TableSortDirection } from '../../lib/uiBlocks'
import { UiBlockContainer } from './UiBlockContainer'

type CopyState = 'idle' | 'copied' | 'failed'

export function TableBlock({ block }: { block: TableUiBlock }): React.JSX.Element {
  useUiLanguage()
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [direction, setDirection] = useState<TableSortDirection>('asc')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const rows = useMemo(
    () => (sortKey ? sortTableRows(block.rows, sortKey, direction) : [...block.rows]),
    [block.rows, direction, sortKey]
  )

  const sortBy = (key: string): void => {
    if (sortKey === key) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setDirection('asc')
  }

  useEffect(() => {
    if (copyState === 'idle') return undefined
    const timer = window.setTimeout(() => setCopyState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [copyState])

  const copyTsv = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(toTsv(block, rows))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const copyLabel =
    copyState === 'copied'
      ? chatCopy.tSVCopied
      : copyState === 'failed'
        ? chatCopy.copyFailed
        : chatCopy.copyTSV

  return (
    <UiBlockContainer title={block.title}>
      <Box
        sx={{
          position: 'relative',
          '&:hover .phi-table-copy, &:focus-within .phi-table-copy': {
            opacity: 1,
            pointerEvents: 'auto'
          }
        }}
      >
        <Tooltip title={copyLabel}>
          <IconButton
            className="phi-table-copy"
            size="small"
            aria-label={copyLabel}
            onClick={() => void copyTsv()}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              zIndex: 3,
              width: 26,
              height: 26,
              opacity: copyState === 'idle' ? 0 : 1,
              pointerEvents: copyState === 'idle' ? 'none' : 'auto',
              color: copyState === 'failed' ? 'error.main' : 'text.secondary',
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              '&:hover': { bgcolor: 'background.paper', color: 'text.primary' }
            }}
          >
            <GoCopy size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <TableContainer sx={{ maxHeight: 360, overflow: 'auto' }}>
          <Table
            size="small"
            aria-label={block.title ?? chatCopy.structuredDataTable}
            sx={{
              minWidth: block.columns.length * 120,
              borderCollapse: 'collapse',
              '& .MuiTableCell-head': {
                position: 'sticky',
                top: 0,
                zIndex: 2,
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark' ? theme.palette.grey[800] : theme.palette.grey[100],
                borderBottom: '1px solid',
                borderBottomColor: 'divider'
              },
              '& .MuiTableBody-root .MuiTableRow-root:last-of-type .MuiTableCell-root': {
                borderBottom: 0
              }
            }}
          >
            <TableHead>
              <TableRow>
                {block.columns.map((column) => (
                  <TableCell
                    key={column.key}
                    align={column.align ?? 'left'}
                    sortDirection={sortKey === column.key ? direction : false}
                    sx={{
                      py: 0.75,
                      px: 1.25,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      '@container phi-chat (max-width: 560px)': { px: 0.75, fontSize: '0.72rem' }
                    }}
                  >
                    <TableSortLabel
                      active={sortKey === column.key}
                      direction={sortKey === column.key ? direction : 'asc'}
                      onClick={() => sortBy(column.key)}
                    >
                      {column.label}
                    </TableSortLabel>
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={rowIndex} hover>
                  {block.columns.map((column) => (
                    <TableCell
                      key={column.key}
                      align={column.align ?? 'left'}
                      sx={{
                        py: 0.65,
                        px: 1.25,
                        maxWidth: 320,
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                        '@container phi-chat (max-width: 560px)': { px: 0.75, fontSize: '0.72rem' }
                      }}
                    >
                      {displayCell(row[column.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </UiBlockContainer>
  )
}

function displayCell(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value)
}

function toTsv(block: TableUiBlock, rows: TableUiBlock['rows']): string {
  const clean = (value: string | number | null | undefined): string =>
    value === null || value === undefined ? '' : String(value).replace(/[\t\r\n]+/gu, ' ')
  return [
    block.columns.map((column) => clean(column.label)).join('\t'),
    ...rows.map((row) => block.columns.map((column) => clean(row[column.key])).join('\t'))
  ].join('\n')
}
