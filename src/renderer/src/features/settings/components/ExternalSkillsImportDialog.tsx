import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Typography
} from '@mui/material'
import { GoSearch } from 'react-icons/go'

import { errorMessage } from '../../../../../shared/errorCodes'
import type {
  HomeSkillCandidate,
  HomeSkillImportResult,
  HomeSkillSource,
  HomeSkillSourceStatus
} from '../../../../../shared/homeSkillImportTypes'
import { useUiLanguage } from '../../../lib/i18n'
import { settingsUi } from '../lib/settingsUi'
import { TabLabel } from './TabCountBadge'

const SOURCE_ORDER: HomeSkillSource[] = ['agents', 'claude', 'codex', 'cursor']
const SETTINGS_DIALOG_MAX_HEIGHT = 'min(720px, calc(100vh - 96px))'

function sourceLabel(source: HomeSkillSource): string {
  switch (source) {
    case 'agents':
      return settingsUi.externalSkillSourceAgents
    case 'claude':
      return settingsUi.externalSkillSourceClaude
    case 'codex':
      return settingsUi.externalSkillSourceCodex
    case 'cursor':
      return settingsUi.externalSkillSourceCursor
  }
}

function candidateKey(candidate: Pick<HomeSkillCandidate, 'source' | 'id'>): string {
  return `${candidate.source}:${candidate.id}`
}

export function ExternalSkillsImportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<HomeSkillSource>('agents')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(8)
  const [candidates, setCandidates] = useState<HomeSkillCandidate[]>([])
  const [sources, setSources] = useState<HomeSkillSourceStatus[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HomeSkillImportResult | null>(null)

  // Reset while rendering the open transition (React's "adjust state when a prop changes"),
  // so the effect below only sets state from its async callbacks.
  const [openSeen, setOpenSeen] = useState(false)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (open) {
      setLoading(true)
      setError(null)
      setResult(null)
      setQuery('')
      setPage(0)
      setSelected(new Set())
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api
      .listHomeSkillImportCandidates()
      .then((response) => {
        if (cancelled) return
        setCandidates(response.candidates)
        setSources(response.sources)
        const first = SOURCE_ORDER.find((item) =>
          response.candidates.some((candidate) => candidate.source === item)
        )
        setSource(first ?? 'agents')
      })
      .catch((cause) => {
        if (cancelled) return
        setError(errorMessage(cause))
        setCandidates([])
        setSources([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const sourceCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.source === source),
    [candidates, source]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sourceCandidates
    return sourceCandidates.filter((candidate) => {
      const haystack = `${candidate.id} ${candidate.title} ${candidate.summary}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [query, sourceCandidates])

  const pageRows = useMemo(() => {
    const start = page * rowsPerPage
    return filtered.slice(start, start + rowsPerPage)
  }, [filtered, page, rowsPerPage])

  const selectableKeys = useMemo(
    () =>
      filtered
        .filter((candidate) => !candidate.installed)
        .map((candidate) => candidateKey(candidate)),
    [filtered]
  )

  const selectedInSource = useMemo(
    () => selectableKeys.filter((key) => selected.has(key)).length,
    [selectableKeys, selected]
  )

  const toggle = (candidate: HomeSkillCandidate, checked: boolean): void => {
    if (candidate.installed) return
    setSelected((current) => {
      const next = new Set(current)
      const key = candidateKey(candidate)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const selectKeys = (keys: readonly string[], checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) {
        if (checked) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  const confirmImport = async (): Promise<void> => {
    const selections = candidates
      .filter((candidate) => selected.has(candidateKey(candidate)) && !candidate.installed)
      .map((candidate) => ({ source: candidate.source, id: candidate.id }))
    if (selections.length === 0) {
      setError(settingsUi.importExternalSkillsNoneSelected)
      return
    }
    setImporting(true)
    setError(null)
    setResult(null)
    try {
      const response = await window.api.importHomeSkills(selections)
      setResult(response)
      const refreshed = await window.api.listHomeSkillImportCandidates()
      setCandidates(refreshed.candidates)
      setSources(refreshed.sources)
      setSelected(new Set())
    } catch (cause) {
      setError(settingsUi.importExternalSkillsFailed(errorMessage(cause)))
    } finally {
      setImporting(false)
    }
  }

  const sourceCount = (item: HomeSkillSource): number =>
    sources.find((entry) => entry.source === item)?.count ??
    candidates.filter((candidate) => candidate.source === item).length

  return (
    <Dialog
      open={open}
      onClose={importing ? undefined : onClose}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 'min(960px, calc(100vw - 120px))',
            height: 'min(640px, calc(100vh - 160px))',
            maxHeight: SETTINGS_DIALOG_MAX_HEIGHT,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }
        }
      }}
    >
      <DialogTitle sx={{ pb: 1.5 }}>{settingsUi.importExternalSkillsTitle}</DialogTitle>
      <DialogContent
        dividers
        sx={{
          p: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          flex: 1
        }}
      >
        <Card
          elevation={0}
          sx={{
            border: 0,
            borderRadius: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            flex: 1
          }}
        >
          <Tabs
            value={source}
            onChange={(_, value: HomeSkillSource) => {
              setSource(value)
              setPage(0)
            }}
            variant="scrollable"
            scrollButtons="auto"
            aria-label={settingsUi.importExternalSkillsSourceTabs}
            sx={{ px: 2, borderBottom: 1, borderColor: 'divider', minHeight: 48 }}
          >
            {SOURCE_ORDER.map((item) => (
              <Tab
                key={item}
                value={item}
                label={<TabLabel text={sourceLabel(item)} count={sourceCount(item)} />}
              />
            ))}
          </Tabs>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{
              px: 2,
              py: 1.5,
              borderBottom: 1,
              borderColor: 'divider',
              alignItems: { sm: 'center' }
            }}
          >
            <TextField
              fullWidth
              size="small"
              value={query}
              disabled={loading || importing}
              placeholder={settingsUi.importExternalSkillsSearch}
              onChange={(event) => {
                setQuery(event.target.value)
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
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
              <Button
                size="small"
                onClick={() => selectKeys(selectableKeys, true)}
                disabled={loading || importing || selectableKeys.length === 0}
              >
                {settingsUi.importExternalSkillsSelectAll}
              </Button>
              <Button
                size="small"
                onClick={() => selectKeys(selectableKeys, false)}
                disabled={loading || importing || selectedInSource === 0}
              >
                {settingsUi.importExternalSkillsClear}
              </Button>
            </Stack>
          </Stack>
          <TableContainer sx={{ flex: 1, minHeight: 0 }}>
            <Table
              size="small"
              stickyHeader
              aria-label={settingsUi.importExternalSkillsTitle}
              sx={{
                minWidth: 720,
                '& th:first-of-type, & td:first-of-type': { pl: 2 },
                '& th:last-of-type, & td:last-of-type': { pr: 2 }
              }}
            >
              <TableHead>
                <TableRow sx={{ bgcolor: 'action.hover' }}>
                  <TableCell padding="checkbox" sx={{ width: 56 }}>
                    <Checkbox
                      size="small"
                      indeterminate={
                        selectedInSource > 0 && selectedInSource < selectableKeys.length
                      }
                      checked={
                        selectableKeys.length > 0 && selectedInSource === selectableKeys.length
                      }
                      disabled={loading || importing || selectableKeys.length === 0}
                      onChange={(event) => selectKeys(selectableKeys, event.target.checked)}
                      slotProps={{
                        input: { 'aria-label': settingsUi.importExternalSkillsSelectAll }
                      }}
                    />
                  </TableCell>
                  <TableCell sx={{ width: 200 }}>
                    {settingsUi.importExternalSkillsColumnSkill}
                  </TableCell>
                  <TableCell>{settingsUi.importExternalSkillsColumnSummary}</TableCell>
                  <TableCell sx={{ width: 100 }}>
                    {settingsUi.importExternalSkillsColumnStatus}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Typography variant="body2" color="text.secondary">
                        {settingsUi.loadingSettings}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
                {!loading && pageRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Typography variant="body2" color="text.secondary">
                        {settingsUi.importExternalSkillsEmpty}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
                {pageRows.map((candidate) => {
                  const key = candidateKey(candidate)
                  return (
                    <TableRow key={key} hover selected={selected.has(key)}>
                      <TableCell padding="checkbox">
                        <Checkbox
                          size="small"
                          checked={candidate.installed || selected.has(key)}
                          disabled={candidate.installed || importing}
                          onChange={(event) => toggle(candidate, event.target.checked)}
                          slotProps={{
                            input: { 'aria-label': candidate.title }
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {candidate.title}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {candidate.id}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden'
                          }}
                        >
                          {candidate.summary || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={candidate.installed ? 'default' : 'success'}
                          label={
                            candidate.installed
                              ? settingsUi.importExternalSkillsInstalled
                              : settingsUi.importExternalSkillsAvailable
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={filtered.length}
            page={page}
            onPageChange={(_, next) => setPage(next)}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={(event) => {
              setRowsPerPage(Number.parseInt(event.target.value, 10))
              setPage(0)
            }}
            rowsPerPageOptions={[8, 16, 32]}
            labelRowsPerPage={settingsUi.perPage}
          />
        </Card>
        {(error || result) && (
          <Box sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: 'divider' }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            {result ? (
              <Alert
                severity={result.errors.length > 0 ? 'warning' : 'success'}
                sx={{ mt: error ? 1 : 0 }}
              >
                {settingsUi.importExternalSkillsDone(
                  result.imported.length,
                  result.skipped.length,
                  result.errors.length
                )}
                {result.errors.length > 0 ? (
                  <Box component="ul" sx={{ m: 0, pl: 2 }}>
                    {result.errors.map((item) => (
                      <li key={`${item.source}:${item.id}`}>
                        {item.id}: {item.message}
                      </li>
                    ))}
                  </Box>
                ) : null}
              </Alert>
            ) : null}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button onClick={onClose} disabled={importing}>
          {settingsUi.close}
        </Button>
        <Button variant="contained" onClick={() => void confirmImport()} disabled={importing}>
          {importing
            ? settingsUi.importExternalSkillsImporting
            : settingsUi.importExternalSkillsConfirm}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
