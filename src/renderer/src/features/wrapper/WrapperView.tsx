import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Link,
  List,
  ListItemButton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from 'react'
import type { WrapperCompositionManifest } from '../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../../../../shared/wrapperModuleDetailsTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import { PhiIcons } from '../../icons'
import { resolveLocalPath } from '../../lib/localPaths'
import { buildWrapperParamsFlowGraph } from './lib/wrapperFlow'
import { parseWrapperNextflowDag } from './lib/wrapperNextflowDag'
import { highlightLine } from '../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../lib/syntaxTheme'
import {
  canCancelBackgroundRun,
  parseWrapperCompositionId,
  runProgressLabel,
  runStateColor,
  runStateLabel,
  wrapperTierLabel
} from './lib/wrapperView'
import type { LocalPathKind } from '../../components/MarkdownContent'
import { WrapperFlowDiagram } from './components/WrapperFlowDiagram'
import { useWrapperCatalog } from './hooks/useWrapperCatalog'

const RefreshIcon = PhiIcons.action.refresh
const ExportIcon = PhiIcons.action.download
const WrapperEntityIcon = PhiIcons.entity.wrapper
const ExpandIcon = PhiIcons.action.expand

type SidebarWidth = number | string

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const plainSidebarRowSx = {
  alignItems: 'center',
  borderRadius: 1.5,
  mx: 1,
  my: 0.25,
  py: 1.25,
  backgroundColor: 'transparent !important',
  transition: 'background-color 120ms ease',
  '&:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.12 : 0.06)} !important`
  },
  '&.Mui-selected': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)} !important`,
    boxShadow: 'none'
  },
  '&.Mui-selected:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)} !important`
  }
} as const

export interface WrapperSidebarProps {
  catalog: WrapperCompositionManifest[]
  selectedId: string | null
  isLoading: boolean
  sidebarWidth?: SidebarWidth
  onSelect: (entry: WrapperCompositionManifest) => void
  onRefresh: () => void
}

export interface WrapperDetailProps {
  catalog: WrapperCompositionManifest[]
  runs: WrapperRun[]
  selectedId: string | null
  error: string | null
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onExportReproducibility?: (runId: string) => void
  onCancelRun?: (runId: string) => void
}

export interface WrapperViewContentProps extends WrapperDetailProps {
  isLoading: boolean
  sidebarWidth: number
  onSelect: (id: string) => void
  onRefresh: () => void
  onStartSidebarResize?: (event: MouseEvent<HTMLDivElement>) => void
}

function ResizeSeparator({
  onMouseDown
}: {
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      onMouseDown={onMouseDown}
      sx={{
        width: '1px',
        flexShrink: 0,
        position: 'relative',
        cursor: 'col-resize',
        bgcolor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          right: -4
        }
      }}
    />
  )
}

function DetailPage({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box
        sx={{
          height: macTitlebarHeight,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: 'drag',
          zIndex: 7
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  )
}

/**
 * Renders raw text with this app's own YAML tokenizer (`syntaxHighlight.ts`)
 * — not a parsed/summarized view: `environment.yml` shows exactly what's on
 * disk, whatever fields it actually has, rather than only the
 * `channels`/`dependencies` shape this component happened to expect.
 */
function WrapperYamlBlock({ yaml }: { yaml: string }): React.JSX.Element {
  const lines = useMemo(() => yaml.replace(/\n$/, '').split('\n'), [yaml])
  return (
    <Box
      sx={{
        bgcolor: 'background.default',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8rem',
        lineHeight: 1.6
      }}
    >
      {lines.map((line, index) => (
        <Box key={index} sx={{ whiteSpace: 'pre' }}>
          {highlightLine(line, 'yaml').map((token, tokenIndex) => (
            <Box
              key={tokenIndex}
              component="span"
              sx={{ color: (theme: Theme) => syntaxTokenColor(theme, token.kind) }}
            >
              {token.value}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** Groups by the `<provider>/<tier>/...` id convention — see `parseWrapperCompositionId`. */
function groupByTier(
  catalog: WrapperCompositionManifest[]
): Array<{ tier: string; entries: WrapperCompositionManifest[] }> {
  const order = ['workflows', 'subworkflows', 'modules']
  const byTier = new Map<string, WrapperCompositionManifest[]>()
  // Seed every known tier up front so one with no wrappers yet (e.g.
  // subworkflows, today) still shows up as an empty group rather than
  // disappearing from the sidebar entirely.
  for (const tier of order) {
    byTier.set(tier, [])
  }
  for (const entry of catalog) {
    const { tier } = parseWrapperCompositionId(entry.id)
    const key = tier || '其他'
    const bucket = byTier.get(key) ?? []
    bucket.push(entry)
    byTier.set(key, bucket)
  }
  const sortedKeys = [...byTier.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  return sortedKeys.map((tier) => ({ tier, entries: byTier.get(tier) ?? [] }))
}

// Rendering every entry in a large tier group at once (nf-core/modules alone
// runs ~30) is what made the Accordion's Collapse height animation
// noticeably janky — the animation has to lay out every mounted row on every
// frame. Paginating each group's rows independently bounds how much is
// mounted up front; the rest loads in as the user scrolls near the bottom.
const DEFAULT_VISIBLE_ENTRY_COUNT = 20
const LOAD_MORE_STEP = 20

// Each AccordionSummary header is given exactly this height (not just a
// `minHeight` — collapsed groups must be a known, fixed size so the
// remaining space available to the expanded group's body can be computed
// precisely; see `useExpandedBodyMaxHeight`).
const ACCORDION_HEADER_HEIGHT = 34
// Matches the outer List's `py: 1` (MUI spacing unit is 8px), which eats
// into the space available to the expanded group's body.
const LIST_VERTICAL_PADDING = 16
const EXPANDED_BODY_MIN_HEIGHT = 80

/**
 * Computes how tall the *currently expanded* group's own scrollable body may
 * be: the sidebar list's real measured height, minus every header (all three
 * stay on-screen at their fixed height, expanded or not) and the list's own
 * padding. This is what lets the body be capped with a plain `max-height` +
 * `overflow-y: auto` — no fighting Collapse's own height animation with
 * flexbox, which is what broke rendering the first time around.
 */
function useExpandedBodyMaxHeight(
  listRef: RefObject<HTMLUListElement | null>,
  groupCount: number
): number {
  const [listHeight, setListHeight] = useState(0)

  useEffect(() => {
    const node = listRef.current
    if (!node) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setListHeight(rect.height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [listRef])

  return Math.max(
    EXPANDED_BODY_MIN_HEIGHT,
    listHeight - groupCount * ACCORDION_HEADER_HEIGHT - LIST_VERTICAL_PADDING
  )
}

/**
 * An invisible row observed against `rootRef` — the currently expanded tier
 * group's own scrollable body. Crossing into view triggers the next page;
 * MUI's `rootMargin` pre-fires slightly before it's actually visible so the
 * next batch is ready before the user hits bottom.
 */
function LoadMoreSentinel({
  rootRef,
  tier,
  totalCount,
  remainingCount,
  onLoadMore
}: {
  rootRef: RefObject<HTMLDivElement | null>
  tier: string
  totalCount: number
  remainingCount: number
  onLoadMore: (tier: string, totalCount: number) => void
}): React.JSX.Element {
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore(tier, totalCount)
      },
      { root: rootRef.current, rootMargin: '160px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [onLoadMore, rootRef, tier, totalCount])

  return (
    <Box
      ref={sentinelRef}
      sx={{ display: 'flex', justifyContent: 'center', py: 1, WebkitAppRegion: 'no-drag' }}
    >
      <Typography variant="caption" color="text.disabled">
        还有 {remainingCount} 个 · 向下滚动加载
      </Typography>
    </Box>
  )
}

function WrapperTierGroupAccordion({
  tier,
  entries,
  selectedId,
  visibleCount,
  expanded,
  expandedBodyMaxHeight,
  onExpandedChange,
  onSelect,
  onLoadMore
}: {
  tier: string
  entries: WrapperCompositionManifest[]
  selectedId: string | null
  visibleCount: number
  expanded: boolean
  expandedBodyMaxHeight: number
  onExpandedChange: (tier: string, expanded: boolean) => void
  onSelect: (entry: WrapperCompositionManifest) => void
  onLoadMore: (tier: string, totalCount: number) => void
}): React.JSX.Element {
  const detailsRef = useRef<HTMLDivElement | null>(null)

  // Pagination must never hide the currently selected wrapper — if it's
  // further down than the default page (e.g. its tab was reopened from
  // elsewhere), reveal up through it regardless of how much has loaded in.
  const selectedIndex = entries.findIndex((entry) => entry.id === selectedId)
  const effectiveVisibleCount = Math.max(visibleCount, selectedIndex + 1)
  const visibleEntries = entries.slice(0, effectiveVisibleCount)
  const remainingCount = entries.length - visibleEntries.length

  return (
    <Accordion
      // Only one tier group is expanded at a time, and none of the three
      // headers ever move — the sidebar's outer list does not scroll at
      // all. The expanded group's own body is capped at a plain, measured
      // `max-height` (see useExpandedBodyMaxHeight) with its own
      // `overflow-y: auto`, so scrolling happens strictly inside that one
      // box. This is deliberately NOT a flexbox/Collapse-internals trick —
      // that fought MUI's own height animation and made content vanish.
      expanded={expanded}
      onChange={(_event, isExpanded) => onExpandedChange(tier, isExpanded)}
      disableGutters
      elevation={0}
      slotProps={{
        transition: { timeout: { enter: 200, exit: 120 } }
      }}
      sx={{
        bgcolor: 'transparent',
        border: 0,
        '&::before': { display: 'none' }
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandIcon fontSize="small" />}
        sx={{
          height: ACCORDION_HEADER_HEIGHT,
          minHeight: `${ACCORDION_HEADER_HEIGHT}px !important`,
          px: 2,
          py: 0,
          WebkitAppRegion: 'no-drag',
          '& .MuiAccordionSummary-content': {
            alignItems: 'center',
            my: 0.5,
            minWidth: 0
          }
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', fontWeight: 800, letterSpacing: 0 }}
        >
          {wrapperTierLabel(tier)} · {entries.length}
        </Typography>
      </AccordionSummary>
      <AccordionDetails
        ref={detailsRef}
        sx={{
          p: 0,
          WebkitAppRegion: 'no-drag',
          ...(expanded ? { maxHeight: expandedBodyMaxHeight, overflowY: 'auto' } : {})
        }}
      >
        {entries.length === 0 ? (
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="body2" color="text.disabled">
              暂无{wrapperTierLabel(tier)} wrapper
            </Typography>
          </Box>
        ) : null}
        {visibleEntries.map((entry) => {
          // The id's own name segment, not the author-chosen display name,
          // is the trustworthy identifier — a manifest's `name` is free text
          // and could be set to anything, including something misleading
          // about which wrapper this actually is.
          const { provider, name } = parseWrapperCompositionId(entry.id)
          return (
            <ListItemButton
              key={entry.id}
              selected={entry.id === selectedId}
              onClick={() => onSelect(entry)}
              sx={plainSidebarRowSx}
            >
              <Box
                sx={{
                  width: 26,
                  height: 26,
                  mr: 1,
                  borderRadius: 0.75,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  flexShrink: 0
                }}
              >
                <WrapperEntityIcon sx={{ fontSize: 15 }} />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  noWrap
                  title={name}
                  sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    lineHeight: 1.25
                  }}
                >
                  {name}
                </Typography>
                <Typography
                  noWrap
                  title={entry.summary}
                  color="text.secondary"
                  sx={{ mt: 0.25, fontSize: '0.75rem', lineHeight: 1.25 }}
                >
                  {entry.summary}
                </Typography>
                <Typography
                  noWrap
                  color="text.secondary"
                  sx={{
                    mt: 0.25,
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    lineHeight: 1.25
                  }}
                >
                  {provider}
                </Typography>
              </Box>
            </ListItemButton>
          )
        })}
        {remainingCount > 0 ? (
          <LoadMoreSentinel
            rootRef={detailsRef}
            tier={tier}
            totalCount={entries.length}
            remainingCount={remainingCount}
            onLoadMore={onLoadMore}
          />
        ) : null}
      </AccordionDetails>
    </Accordion>
  )
}

export function WrapperSidebar({
  catalog,
  selectedId,
  isLoading,
  sidebarWidth = '100%',
  onSelect,
  onRefresh
}: WrapperSidebarProps): React.JSX.Element {
  const groups = useMemo(() => groupByTier(catalog), [catalog])
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const listRef = useRef<HTMLUListElement | null>(null)
  const selectedTier = selectedId ? parseWrapperCompositionId(selectedId).tier : null

  // `undefined` means "no explicit choice yet" (fall back to the selected
  // wrapper's group, then the first group, below); `null` means the user
  // deliberately collapsed every group — kept distinct so the fallback never
  // fights a manual collapse-to-none.
  const [manualExpandedTier, setManualExpandedTier] = useState<string | null | undefined>(undefined)
  // Adjusting state during render (React's documented pattern for reacting
  // to a changed prop) instead of in an effect: when the *selection itself*
  // changes tier (a different wrapper's tab was opened), reveal that group —
  // without fighting a manual collapse the user made afterward for that same
  // selection, and without an extra effect-driven commit.
  const [trackedSelectedTier, setTrackedSelectedTier] = useState(selectedTier)
  if (selectedTier !== trackedSelectedTier) {
    setTrackedSelectedTier(selectedTier)
    if (selectedTier) setManualExpandedTier(selectedTier)
  }

  const expandedTier =
    manualExpandedTier !== undefined
      ? manualExpandedTier
      : (selectedTier ?? groups[0]?.tier ?? null)

  const expandedBodyMaxHeight = useExpandedBodyMaxHeight(listRef, groups.length)

  const handleLoadMore = useCallback((tier: string, totalCount: number): void => {
    setVisibleCounts((counts) => ({
      ...counts,
      [tier]: Math.min((counts[tier] ?? DEFAULT_VISIBLE_ENTRY_COUNT) + LOAD_MORE_STEP, totalCount)
    }))
  }, [])

  const handleExpandedChange = useCallback((tier: string, isExpanded: boolean): void => {
    setManualExpandedTier(isExpanded ? tier : null)
  }, [])

  return (
    <Box
      className="app-sidebar-surface"
      sx={{
        width: sidebarWidth,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Stack
          direction="row"
          sx={{ mb: 1.5, alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.5 }}>
            Wrappers
          </Typography>
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="刷新">
              <span>
                <IconButton
                  aria-label="刷新"
                  size="small"
                  onClick={onRefresh}
                  disabled={isLoading}
                  sx={{ WebkitAppRegion: 'no-drag' }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${catalog.length} 个 wrapper`} />
        </Stack>
      </Box>

      <Divider />

      <List
        ref={listRef}
        disablePadding
        sx={{
          // The outer list itself never scrolls and never moves — all three
          // headers stay exactly where they are. Only the expanded group's
          // own body scrolls, capped at a measured max-height (see
          // useExpandedBodyMaxHeight / WrapperTierGroupAccordion).
          overflow: 'hidden',
          flex: 1,
          py: 1,
          backgroundColor: 'transparent !important',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : catalog.length === 0 ? (
          <Box sx={{ px: 2, py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              没有发现任何 wrapper。
            </Typography>
          </Box>
        ) : (
          groups.map((group) => (
            <WrapperTierGroupAccordion
              key={group.tier}
              tier={group.tier}
              entries={group.entries}
              selectedId={selectedId}
              visibleCount={visibleCounts[group.tier] ?? DEFAULT_VISIBLE_ENTRY_COUNT}
              expanded={group.tier === expandedTier}
              expandedBodyMaxHeight={expandedBodyMaxHeight}
              onExpandedChange={handleExpandedChange}
              onSelect={onSelect}
              onLoadMore={handleLoadMore}
            />
          ))
        )}
      </List>
    </Box>
  )
}

export function WrapperDetail({
  catalog,
  runs,
  selectedId,
  error,
  onOpenLocalPath,
  onExportReproducibility,
  onCancelRun
}: WrapperDetailProps): React.JSX.Element {
  const selected = useMemo(
    () => catalog.find((entry) => entry.id === selectedId),
    [catalog, selectedId]
  )
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.wrapper.canonicalId === selectedId),
    [runs, selectedId]
  )
  const tier = selected ? parseWrapperCompositionId(selected.id).tier : ''
  const params = useMemo(() => (selected ? Object.entries(selected.params) : []), [selected])
  const inputParams = useMemo(() => params.filter(([, param]) => param.kind === 'input'), [params])
  const optionParams = useMemo(
    () => params.filter(([, param]) => param.kind === 'option'),
    [params]
  )
  const outputs = useMemo(() => (selected ? Object.entries(selected.outputs) : []), [selected])
  const paramsGraph = useMemo(
    // Built from the wrapper's own declared params/outputs — its real,
    // user-facing contract — not Nextflow's internal process signature.
    // See buildWrapperParamsFlowGraph's own doc comment for why those two
    // can genuinely disagree (a module's process can take extra channels
    // the wrapper hardcodes off).
    () =>
      selected
        ? buildWrapperParamsFlowGraph({
            name: selected.name,
            inputLabels: inputParams.map(([key]) => key),
            outputLabels: outputs.map(([key]) => key)
          })
        : undefined,
    [selected, inputParams, outputs]
  )
  // Only "workflows" (a complete multi-process pipeline) benefits from the
  // real Nextflow DAG: it has no small enumerable params that represent its
  // internal structure the way a module's do, so the params-graph above
  // would just be a handful of top-level pipeline options, not a structure
  // view at all. Keyed by the id the fetch was made for, so a still-in-flight
  // fetch from a previously-selected wrapper never applies once selection
  // moves on (react-hooks/set-state-in-effect wants setState in the async
  // callback, not synchronously at the top of the effect).
  const [dagResult, setDagResult] = useState<{ id: string; source: string | undefined }>()
  useEffect(() => {
    if (!selectedId || tier !== 'workflows') return undefined
    let cancelled = false
    void window.api
      .getWrapperCompositionDag(selectedId)
      .then((dag) => {
        if (!cancelled) setDagResult({ id: selectedId, source: dag })
      })
      .catch(() => {
        if (!cancelled) setDagResult({ id: selectedId, source: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, tier])
  const dagSource =
    tier === 'workflows' && dagResult?.id === selectedId ? dagResult.source : undefined
  // Nextflow's raw dag.mmd is mostly channel/value plumbing (`channel.empty`,
  // merge points, …) — parseWrapperNextflowDag collapses all of that down to
  // real processes and the direct dependencies between them. Falls back to
  // the params-graph above if parsing finds no processes (e.g. dag.mmd
  // failed to generate for this wrapper).
  const graph = useMemo(
    () => (dagSource ? parseWrapperNextflowDag(dagSource) : undefined) ?? paramsGraph,
    [dagSource, paramsGraph]
  )
  const [moduleDetailsResult, setModuleDetailsResult] = useState<{
    id: string
    details: WrapperModuleDetails | undefined
  }>()
  useEffect(() => {
    if (!selectedId) return undefined
    let cancelled = false
    void window.api
      .getWrapperCompositionModuleDetails(selectedId)
      .then((details) => {
        if (!cancelled) setModuleDetailsResult({ id: selectedId, details })
      })
      .catch(() => {
        if (!cancelled) setModuleDetailsResult({ id: selectedId, details: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])
  const moduleDetails =
    moduleDetailsResult?.id === selectedId ? moduleDetailsResult.details : undefined

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {error && (
        <Alert severity="error" sx={{ m: 3, mb: 0 }}>
          {error}
        </Alert>
      )}

      {!selected ? (
        <Box sx={{ px: { xs: 3, md: 5 }, pt: 3 }}>
          <Typography variant="body2" color="text.secondary">
            从左侧选择一个 wrapper 查看详情。
          </Typography>
        </Box>
      ) : (
        <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: 1,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <WrapperEntityIcon />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                {selected.name}
              </Typography>
              {/* The canonical id, not the display name above, is what actually
                  identifies this wrapper — keep it visible right next to the name. */}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: 'var(--font-mono)', display: 'block' }}
              >
                {selected.id}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {selected.summary}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip
                  size="small"
                  color="primary"
                  label={parseWrapperCompositionId(selected.id).provider}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={wrapperTierLabel(parseWrapperCompositionId(selected.id).tier)}
                />
              </Stack>
            </Box>
          </Stack>

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
            结构
          </Typography>
          {graph && (
            // Keyed by wrapper id so switching wrappers remounts the whole
            // ReactFlow instance instead of reusing it with a new `graph`
            // prop — `fitView` only runs once on mount, so reusing the
            // instance left the old pan/zoom transform in place for a
            // completely different graph, which for a same-size-or-smaller
            // one meant the new nodes could land entirely outside the
            // visible viewport (an apparently blank diagram).
            <WrapperFlowDiagram
              key={selected.id}
              graph={graph}
              height={graph.nodes.length > 8 ? 480 : 180}
            />
          )}

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            输入
          </Typography>
          {inputParams.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              无
            </Typography>
          ) : (
            inputParams.map(([key, param]) => (
              <Typography key={key} variant="body2" color="text.secondary">
                {key} ({param.type}
                {param.required ? '，必填' : ''})
                {param.description ? ` — ${param.description}` : ''}
              </Typography>
            ))
          )}

          {optionParams.length > 0 && (
            <>
              <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
                选项
              </Typography>
              {optionParams.map(([key, param]) => (
                <Typography key={key} variant="body2" color="text.secondary">
                  {key} ({param.type}
                  {param.required ? '，必填' : ''})
                  {param.description ? ` — ${param.description}` : ''}
                </Typography>
              ))}
            </>
          )}

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
            输出
          </Typography>
          {outputs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              无
            </Typography>
          ) : (
            outputs.map(([key, output]) => (
              <Typography key={key} variant="body2" color="text.secondary">
                {key} — {output.path}
                {output.primary ? '（主要）' : ''}
              </Typography>
            ))
          )}

          {moduleDetails?.meta && (
            <>
              <Divider sx={{ my: 4 }} />
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
                关于
              </Typography>
              {moduleDetails.meta.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  {moduleDetails.meta.description}
                </Typography>
              )}
              {moduleDetails.meta.keywords && moduleDetails.meta.keywords.length > 0 && (
                <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
                  {moduleDetails.meta.keywords.map((keyword) => (
                    <Chip key={keyword} size="small" variant="outlined" label={keyword} />
                  ))}
                </Stack>
              )}
              {moduleDetails.meta.tools?.map((tool) => (
                <Box key={tool.name} sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {tool.name}
                  </Typography>
                  {tool.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                      {tool.description}
                    </Typography>
                  )}
                  <Stack
                    direction="row"
                    spacing={1.5}
                    sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}
                  >
                    {tool.licence?.map((licence) => (
                      <Chip key={licence} size="small" label={licence} />
                    ))}
                    {tool.homepage && (
                      <Link
                        href={tool.homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body2"
                      >
                        主页
                      </Link>
                    )}
                    {tool.documentation && (
                      <Link
                        href={tool.documentation}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body2"
                      >
                        文档
                      </Link>
                    )}
                    {tool.doi && (
                      <Link
                        href={`https://doi.org/${tool.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body2"
                      >
                        DOI
                      </Link>
                    )}
                  </Stack>
                </Box>
              ))}
              {moduleDetails.meta.authors && moduleDetails.meta.authors.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  作者：{moduleDetails.meta.authors.join('、')}
                </Typography>
              )}
            </>
          )}

          {moduleDetails?.environment && (
            <>
              <Divider sx={{ my: 4 }} />
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
                环境
              </Typography>
              <WrapperYamlBlock yaml={moduleDetails.environment} />
            </>
          )}

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
            运行记录
          </Typography>
          {selectedRuns.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              还没有运行记录。
            </Typography>
          ) : (
            <Stack spacing={0.75}>
              {selectedRuns
                .slice()
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((run) => (
                  <Stack key={run.runId} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Chip
                      size="small"
                      label={runStateLabel(run.state)}
                      color={runStateColor(run.state)}
                    />
                    <Typography variant="body2" color="text.secondary">
                      {run.runId}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(run.createdAt).toLocaleString()}
                    </Typography>
                    {runProgressLabel(run) ? (
                      <Typography variant="caption" color="text.secondary">
                        {runProgressLabel(run)}
                      </Typography>
                    ) : null}
                    <Box sx={{ flex: 1 }} />
                    {canCancelBackgroundRun(run) ? (
                      <Button
                        size="small"
                        color="error"
                        aria-label="取消运行"
                        onClick={() => onCancelRun?.(run.runId)}
                      >
                        取消运行
                      </Button>
                    ) : null}
                    <Tooltip title="导出可复现性元数据">
                      <span>
                        <IconButton
                          aria-label="导出可复现性元数据"
                          size="small"
                          onClick={() => onExportReproducibility?.(run.runId)}
                        >
                          <ExportIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Button
                      size="small"
                      onClick={() => {
                        const absolutePath = resolveLocalPath(
                          run.outDir.startsWith('/') ? run.outDir : `./${run.outDir}`,
                          run.cwd
                        )
                        if (absolutePath) onOpenLocalPath?.(absolutePath, 'directory')
                      }}
                    >
                      打开输出目录
                    </Button>
                  </Stack>
                ))}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  )
}

/**
 * Pure presentational wrapper view — takes catalog/run data as props instead
 * of fetching it itself, so it renders synchronously and is directly testable.
 */
export function WrapperViewContent({
  catalog,
  runs,
  selectedId,
  isLoading,
  error,
  sidebarWidth,
  onSelect,
  onRefresh,
  onOpenLocalPath,
  onExportReproducibility,
  onCancelRun,
  onStartSidebarResize
}: WrapperViewContentProps): React.JSX.Element {
  const selected = catalog.find((entry) => entry.id === selectedId) ?? null

  return (
    <>
      <WrapperSidebar
        catalog={catalog}
        selectedId={selectedId}
        isLoading={isLoading}
        sidebarWidth={sidebarWidth}
        onSelect={(entry) => onSelect(entry.id)}
        onRefresh={onRefresh}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selected?.name ?? 'Wrappers'}>
        <WrapperDetail
          catalog={catalog}
          runs={runs}
          selectedId={selectedId}
          error={error}
          onOpenLocalPath={onOpenLocalPath}
          onExportReproducibility={onExportReproducibility}
          onCancelRun={onCancelRun}
        />
      </DetailPage>
    </>
  )
}

interface WrapperViewProps {
  sidebarWidth: number
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onStartSidebarResize?: (event: MouseEvent<HTMLDivElement>) => void
}

export default function WrapperView({
  sidebarWidth,
  onOpenLocalPath,
  onStartSidebarResize
}: WrapperViewProps): React.JSX.Element {
  const {
    catalog,
    runs,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    setSelectedWrapperId,
    refreshWrappers,
    exportWrapperReproducibility
  } = useWrapperCatalog()

  return (
    <WrapperViewContent
      catalog={catalog}
      runs={runs}
      selectedId={selectedWrapperId}
      isLoading={isLoadingWrappers}
      error={wrapperError}
      sidebarWidth={sidebarWidth}
      onSelect={setSelectedWrapperId}
      onRefresh={() => void refreshWrappers()}
      onOpenLocalPath={onOpenLocalPath}
      onExportReproducibility={(runId) => void exportWrapperReproducibility(runId)}
      onStartSidebarResize={onStartSidebarResize}
    />
  )
}
