import { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel
} from '@mui/material'
import { GoCopy } from 'react-icons/go'

import type { TableUiBlock } from '../../../../../../shared/uiBlockTypes'
import { sortTableRows, type TableSortDirection } from '../../lib/uiBlocks'
import { UiBlockContainer } from './UiBlockContainer'

type CopyState = 'idle' | 'copied' | 'failed'

export function TableBlock({ block }: { block: TableUiBlock }): React.JSX.Element {
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

  const copyTsv = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(toTsv(block, rows))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const copyLabel =
    copyState === 'copied' ? '已复制 TSV' : copyState === 'failed' ? '复制失败' : '复制 TSV'

  return (
    <UiBlockContainer title={block.title}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, pb: 0.75 }}>
        <Button
          size="small"
          color={copyState === 'failed' ? 'error' : 'inherit'}
          startIcon={<GoCopy aria-hidden="true" />}
          onClick={() => void copyTsv()}
          sx={{ minWidth: 0, fontSize: '0.72rem' }}
        >
          {copyLabel}
        </Button>
      </Box>
      <TableContainer
        sx={{ maxHeight: 360, overflowX: 'auto', borderTop: 1, borderColor: 'divider' }}
      >
        <Table
          stickyHeader
          size="small"
          aria-label={block.title ?? '结构化数据表'}
          sx={{ minWidth: block.columns.length * 120 }}
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
                    bgcolor: 'background.paper',
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
