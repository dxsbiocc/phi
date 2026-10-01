import { useEffect, useState } from 'react'
import {
  Alert,
  Card,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  Tabs,
  TextField,
  Tooltip
} from '@mui/material'
import { GoSearch, GoSync } from 'react-icons/go'
import type { SearxngEngineOption } from '../../../../../shared/webSearchSettingsTypes'
import {
  isSearxngEngineUnavailable,
  listSearxngEnginePage,
  mergeSearxngEngines,
  SEARXNG_DEFAULT_ENGINES,
  type SearxngDisplayEngine,
  type SearxngSelectionFilter,
  type SearxngStatusFilter,
  toggleSearxngEngine
} from '../lib/searxngEngines'
import { TabLabel } from './TabCountBadge'

function engineNames(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

export function SearxngEnginePicker({
  endpoint,
  engines,
  onChange,
  disabled = false,
  catalog,
  onConnectionChange
}: {
  endpoint: string
  engines: string
  onChange: (value: string) => void
  disabled?: boolean
  catalog?: SearxngEngineOption[]
  onConnectionChange?: (reachable: boolean) => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<SearxngDisplayEngine[]>(
    catalog ? mergeSearxngEngines(catalog) : SEARXNG_DEFAULT_ENGINES
  )
  const [fromInstance, setFromInstance] = useState(Boolean(catalog))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selectionFilter, setSelectionFilter] = useState<SearxngSelectionFilter>('all')
  const [statusFilter, setStatusFilter] = useState<SearxngStatusFilter>('all')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [nameOrder, setNameOrder] = useState<'original' | 'asc' | 'desc'>('original')
  const selected = engineNames(engines)
  const enabledNames = loaded
    .filter((engine) => engine.enabled && !engine.inactive && engine.available !== false)
    .map((engine) => engine.name)
  const effectiveSelected = selected.length ? selected : enabledNames
  const selectedNames = new Set(effectiveSelected)
  const unknownNames = fromInstance
    ? selected.filter(
        (name) => !loaded.some((engine) => engine.name === name && engine.available !== false)
      )
    : []
  const availableEngines = loaded.filter((engine) => !isSearxngEngineUnavailable(engine))
  const selectedCount = availableEngines.filter((engine) => selectedNames.has(engine.name)).length
  const unavailableCount = loaded.length - availableEngines.length
  const result = listSearxngEnginePage(loaded, {
    query: filter,
    selection: selectionFilter,
    status: statusFilter,
    selectedNames,
    page,
    rowsPerPage,
    nameOrder
  })

  async function refresh(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setLoaded(mergeSearxngEngines(await window.api.listSearxngEngines()))
      setFromInstance(true)
      onConnectionChange?.(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoaded(SEARXNG_DEFAULT_ENGINES)
      setFromInstance(false)
      onConnectionChange?.(false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (catalog || !endpoint) return
    let active = true
    void window.api
      .listSearxngEngines()
      .then((result) => {
        if (active) {
          setLoaded(mergeSearxngEngines(result))
          setFromInstance(true)
          onConnectionChange?.(true)
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoaded(SEARXNG_DEFAULT_ENGINES)
          setFromInstance(false)
          onConnectionChange?.(false)
        }
      })
    return () => {
      active = false
    }
  }, [catalog, endpoint, onConnectionChange])

  function toggle(name: string): void {
    const next = toggleSearxngEngine(selected, enabledNames, name)
    if (next !== null) onChange(next)
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="warning">读取实例引擎失败：{error}</Alert>}
      <Card>
        <Tabs
          value={selectionFilter}
          onChange={(_, value: SearxngSelectionFilter) => {
            setSelectionFilter(value)
            setPage(0)
          }}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="按选择状态筛选搜索引擎"
          sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="all" label={<TabLabel text="全部" count={loaded.length} />} />
          <Tab
            value="selected"
            label={<TabLabel text="已选" count={selectedCount} tone="success" />}
          />
          <Tab
            value="unselected"
            label={
              <TabLabel
                text="未选"
                count={availableEngines.length - selectedCount}
                tone="warning"
              />
            }
          />
          <Tab
            value="unavailable"
            label={<TabLabel text="不可用" count={unavailableCount} tone="error" />}
          />
        </Tabs>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ px: 3, py: 2.5, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}
        >
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel id="searxng-status-filter-label">默认状态</InputLabel>
            <Select
              labelId="searxng-status-filter-label"
              label="默认状态"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as SearxngStatusFilter)
                setPage(0)
              }}
            >
              <MenuItem value="all">全部状态</MenuItem>
              <MenuItem value="default-on">默认开启</MenuItem>
              <MenuItem value="default-off">默认关闭</MenuItem>
              <MenuItem value="admin-required">需实例配置</MenuItem>
              <MenuItem value="instance-missing" disabled={!fromInstance}>
                实例未提供
              </MenuItem>
            </Select>
          </FormControl>
          <TextField
            fullWidth
            size="small"
            placeholder="搜索名称或快捷词"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setPage(0)
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <GoSearch size={17} />
                  </InputAdornment>
                )
              }
            }}
          />
          {Boolean(endpoint) && (
            <Tooltip title="刷新实例引擎">
              <span>
                <IconButton
                  size="small"
                  aria-label="刷新实例引擎"
                  disabled={disabled || loading || Boolean(catalog)}
                  onClick={() => void refresh()}
                >
                  {loading ? <CircularProgress size={16} /> : <GoSync size={17} />}
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
        <TableContainer>
          <Table
            size="small"
            sx={{
              minWidth: 570,
              '& th:first-of-type, & td:first-of-type': { pl: 3 },
              '& th:last-of-type, & td:last-of-type': { pr: 3 }
            }}
            aria-label="SearXNG 搜索引擎列表"
          >
            <TableHead>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell sx={{ width: 76 }}>使用</TableCell>
                <TableCell>
                  <TableSortLabel
                    active={nameOrder !== 'original'}
                    direction={nameOrder === 'desc' ? 'desc' : 'asc'}
                    onClick={() => {
                      setNameOrder(nameOrder === 'asc' ? 'desc' : 'asc')
                      setPage(0)
                    }}
                  >
                    搜索引擎
                  </TableSortLabel>
                </TableCell>
                <TableCell sx={{ width: 100 }}>快捷词</TableCell>
                <TableCell sx={{ width: 122 }}>状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {result.rows.map((engine) => {
                const checked = selectedNames.has(engine.name)
                const unavailable = isSearxngEngineUnavailable(engine)
                const status =
                  engine.available === false
                    ? '实例未提供'
                    : engine.inactive
                      ? '需实例配置'
                      : engine.enabled
                        ? '默认开启'
                        : '默认关闭'
                return (
                  <TableRow key={engine.name} hover>
                    <TableCell padding="checkbox">
                      <Switch
                        size="small"
                        checked={checked}
                        disabled={
                          disabled || unavailable || (checked && effectiveSelected.length === 1)
                        }
                        onChange={() => toggle(engine.name)}
                        slotProps={{ input: { 'aria-label': `启用 ${engine.name} 引擎` } }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{engine.name}</TableCell>
                    <TableCell>
                      {engine.shortcut && (
                        <Chip size="small" variant="outlined" label={engine.shortcut} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={status}
                        color={unavailable ? 'default' : engine.enabled ? 'success' : 'warning'}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
              {result.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                    没有符合条件的搜索引擎
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={result.total}
          page={result.page}
          onPageChange={(_, nextPage) => setPage(nextPage)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value))
            setPage(0)
          }}
          rowsPerPageOptions={[10, 20, 50]}
          labelRowsPerPage="每页"
          labelDisplayedRows={({ from, to, count }) => `${from}–${to} / ${count}`}
          sx={{ '& .MuiTablePagination-toolbar': { pl: 3 } }}
        />
      </Card>

      {unknownNames.length > 0 && (
        <Alert severity="warning">实例未列出已填写的引擎：{unknownNames.join('、')}</Alert>
      )}
    </Stack>
  )
}
