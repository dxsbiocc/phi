import { useEffect, useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
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
  Typography
} from '@mui/material'
import { GoChevronDown, GoSearch } from 'react-icons/go'
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
  catalog
}: {
  endpoint: string
  engines: string
  onChange: (value: string) => void
  disabled?: boolean
  catalog?: SearxngEngineOption[]
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoaded(SEARXNG_DEFAULT_ENGINES)
      setFromInstance(false)
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
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoaded(SEARXNG_DEFAULT_ENGINES)
          setFromInstance(false)
        }
      })
    return () => {
      active = false
    }
  }, [catalog, endpoint])

  function toggle(name: string): void {
    const next = toggleSearxngEngine(selected, enabledNames, name)
    if (next !== null) onChange(next)
  }

  return (
    <Stack spacing={1.25}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="subtitle2">SearXNG 搜索引擎</Typography>
          <Typography variant="caption" color="text.secondary">
            {selected.length
              ? `已选择 ${selected.length} 个引擎`
              : endpoint
                ? '使用实例默认启用的引擎'
                : '添加实例后使用其默认引擎'}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.5}>
          {engines && (
            <Button size="small" disabled={disabled} onClick={() => onChange('')}>
              使用实例默认
            </Button>
          )}
          <Button
            size="small"
            disabled={disabled || loading || !endpoint || Boolean(catalog)}
            onClick={() => void refresh()}
          >
            {loading ? '读取中' : '刷新引擎'}
          </Button>
        </Stack>
      </Stack>

      {!endpoint && (
        <Typography variant="body2" color="text.secondary">
          已列出 SearXNG 上游默认配置中的全部 {loaded.length}{' '}
          个引擎。默认关闭的开关可以手动打开；添加实例后会校验该实例实际提供哪些引擎。
        </Typography>
      )}
      {loading && <CircularProgress size={18} />}
      {error && (
        <Alert severity="warning">
          读取实例引擎失败：{error}。当前显示上游目录，实例可用性尚未确认。
        </Alert>
      )}
      <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
        <Tabs
          value={selectionFilter}
          onChange={(_, value: SearxngSelectionFilter) => {
            setSelectionFilter(value)
            setPage(0)
          }}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="按选择状态筛选搜索引擎"
          sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="all" label={`全部 ${loaded.length}`} />
          <Tab value="selected" label={`已选 ${selectedCount}`} />
          <Tab value="unselected" label={`未选 ${availableEngines.length - selectedCount}`} />
          <Tab value="unavailable" label={`不可用 ${unavailableCount}`} />
        </Tabs>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ px: 1.5, py: 1.25, borderBottom: 1, borderColor: 'divider' }}
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
        </Stack>
        <TableContainer>
          <Table size="small" sx={{ minWidth: 570 }} aria-label="SearXNG 搜索引擎列表">
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
                <TableCell align="right" sx={{ width: 74 }}>
                  操作
                </TableCell>
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
                    <TableCell align="right">
                      <Button
                        size="small"
                        disabled={disabled || unavailable || engines === engine.name}
                        onClick={() => onChange(engine.name)}
                      >
                        仅此
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {result.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>
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
        />
      </Paper>

      {unknownNames.length > 0 && (
        <Alert severity="warning">实例未列出已填写的引擎：{unknownNames.join('、')}</Alert>
      )}

      <Accordion disableGutters variant="outlined" sx={{ borderRadius: 1 }}>
        <AccordionSummary expandIcon={<GoChevronDown size={17} />}>
          <Typography variant="body2">手动填写引擎名称（高级）</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <TextField
            fullWidth
            size="small"
            label="限定引擎名称（可选）"
            value={engines}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            helperText="留空使用实例默认；多个名称用逗号分隔。"
          />
        </AccordionDetails>
      </Accordion>
    </Stack>
  )
}
