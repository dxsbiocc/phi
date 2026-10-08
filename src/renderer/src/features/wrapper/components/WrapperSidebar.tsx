import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { Box, CircularProgress, List, Typography } from '@mui/material'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { CatalogSidebar } from '../../../components/CatalogSidebar'
import { CatalogResourceRow } from '../../../components/CatalogResourceRow'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { DiscoverButton } from '../../../components/DiscoverButton'
import {
  SidebarAccordionGroup,
  SIDEBAR_GROUP_HEADER_HEIGHT
} from '../../../components/SidebarAccordionGroup'
import {
  createTrustedDialogRequestCoordinator,
  type TrustedOverlayRequest
} from '../../../lib/trustedOverlayRequests'
import { filterWrappers, selectedWrappers, visibleWrapperTier } from '../lib/wrapperSidebar'
import { parseWrapperCompositionId, wrapperTierLabel } from '../lib/wrapperView'
import { WrapperCatalogDialog } from './WrapperCatalogDialog'

export interface WrapperSidebarProps {
  visible?: boolean
  catalog: WrapperCompositionCatalogItem[]
  selectedId: string | null
  isLoading: boolean
  sidebarWidth?: number | string
  busyPackageId?: string | null
  onSelect: (entry: WrapperCompositionCatalogItem) => void
  onRefresh: () => Promise<void> | void
  onSetPackageEnabled?: (packageId: string, enabled: boolean) => Promise<boolean | void> | void
  requestTrustedOverlay?: TrustedOverlayRequest
  cancelTrustedOverlay?: (key: string) => void
  onPreviewInteractionChange?: (active: boolean) => void
}

/** Groups by the `<provider>/<tier>/...` id convention — see `parseWrapperCompositionId`. */
function groupByTier(
  catalog: WrapperCompositionCatalogItem[]
): Array<{ tier: string; entries: WrapperCompositionCatalogItem[] }> {
  const order = ['workflows', 'subworkflows', 'modules']
  const byTier = new Map<string, WrapperCompositionCatalogItem[]>()
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

// Header height lives in the shared SidebarAccordionGroup — collapsed groups
// must be a known, fixed size so the remaining space available to the
// expanded group's body can be computed precisely (see
// `useExpandedBodyMaxHeight`).
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
  groupCount: number,
  visible: boolean
): number {
  const [listHeight, setListHeight] = useState(0)

  useLayoutEffect(() => {
    const node = listRef.current
    if (!node || !visible) return undefined
    const height = node.offsetHeight
    if (height > 0) setListHeight(height)
    const observer = new ResizeObserver(() => {
      const height = node.offsetHeight
      if (height > 0) setListHeight(height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [listRef, visible, listHeight])

  return Math.max(
    EXPANDED_BODY_MIN_HEIGHT,
    listHeight - groupCount * SIDEBAR_GROUP_HEADER_HEIGHT - LIST_VERTICAL_PADDING
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
  onLoadMore,
  busyPackageId,
  onSetPackageEnabled
}: {
  tier: string
  entries: WrapperCompositionCatalogItem[]
  selectedId: string | null
  visibleCount: number
  expanded: boolean
  expandedBodyMaxHeight: number
  onExpandedChange: (tier: string, expanded: boolean) => void
  onSelect: (entry: WrapperCompositionCatalogItem) => void
  onLoadMore: (tier: string, totalCount: number) => void
  busyPackageId?: string | null
  onSetPackageEnabled?: WrapperSidebarProps['onSetPackageEnabled']
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
    // Only one tier group is expanded at a time, and none of the three
    // headers ever move — the sidebar's outer list does not scroll at
    // all. The expanded group's own body is capped at a plain, measured
    // `max-height` (see useExpandedBodyMaxHeight) with its own
    // `overflow-y: auto`, so scrolling happens strictly inside that one
    // box. This is deliberately NOT a flexbox/Collapse-internals trick —
    // that fought MUI's own height animation and made content vanish.
    <SidebarAccordionGroup
      expanded={expanded}
      onExpandedChange={(isExpanded) => onExpandedChange(tier, isExpanded)}
      title={wrapperTierLabel(tier)}
      count={entries.length}
      expandedBodyMaxHeight={expandedBodyMaxHeight}
      detailsRef={detailsRef}
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
          <CatalogResourceRow
            key={entry.id}
            id={entry.id}
            resource="wrappers"
            label={name}
            enabled={entry.packageEnabled !== false}
            selected={entry.id === selectedId}
            busy={
              Boolean(busyPackageId) && busyPackageId === (entry.enablementId ?? entry.packageId)
            }
            onSelect={() => onSelect(entry)}
            disabledReason={
              busyPackageId && busyPackageId !== (entry.enablementId ?? entry.packageId)
                ? '正在更新 wrapper'
                : entry.enablementId || entry.packageId
                  ? undefined
                  : '用户自定义 wrapper 始终可用'
            }
            onEnabledChange={
              onSetPackageEnabled && (entry.enablementId ?? entry.packageId)
                ? (enabled) => onSetPackageEnabled(entry.enablementId ?? entry.packageId!, enabled)
                : undefined
            }
            icon={
              <Box
                sx={{
                  width: 32,
                  height: 32,
                  borderRadius: 1.25,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: entry.packageEnabled !== false ? 'primary.main' : 'action.hover',
                  color: entry.packageEnabled !== false ? 'primary.contrastText' : 'text.secondary',
                  flexShrink: 0
                }}
              >
                <ResourceIcon icon={entry.icon} kind="wrapper" size={32} fallbackSize={18} />
              </Box>
            }
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography
                noWrap
                title={name}
                sx={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  lineHeight: 1.25
                }}
              >
                {name}
              </Typography>
              <Typography
                noWrap
                title={`${provider} · ${entry.summary}`}
                color="text.secondary"
                sx={{ mt: 0.25, fontSize: '0.75rem', lineHeight: 1.25 }}
              >
                {provider} · {entry.summary}
              </Typography>
            </Box>
          </CatalogResourceRow>
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
    </SidebarAccordionGroup>
  )
}

export function WrapperSidebar({
  visible = true,
  catalog,
  selectedId,
  isLoading,
  sidebarWidth = '100%',
  onSelect,
  onRefresh,
  onSetPackageEnabled,
  busyPackageId,
  requestTrustedOverlay,
  cancelTrustedOverlay,
  onPreviewInteractionChange
}: WrapperSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalogPending, setCatalogPending] = useState(false)
  const catalogDialogs = useMemo(
    () =>
      createTrustedDialogRequestCoordinator({
        request: requestTrustedOverlay,
        cancel: cancelTrustedOverlay,
        onCancel: () => {
          setCatalogPending(false)
          onPreviewInteractionChange?.(false)
        }
      }),
    [requestTrustedOverlay, cancelTrustedOverlay, onPreviewInteractionChange]
  )
  useEffect(() => () => catalogDialogs.dispose(), [catalogDialogs])
  if (!visible && (catalogOpen || catalogPending)) {
    setCatalogOpen(false)
    setCatalogPending(false)
  }
  useLayoutEffect(() => {
    if (!visible) catalogDialogs.cancel('wrapper-sidebar-catalog')
  }, [visible, catalogDialogs])
  const catalogInteractionActive = visible && (catalogOpen || catalogPending)
  useEffect(() => {
    if (!catalogInteractionActive) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [catalogInteractionActive, onPreviewInteractionChange])
  const openCatalog = (): void => {
    if (!visible) return
    catalogDialogs.cancel('wrapper-sidebar-catalog')
    onPreviewInteractionChange?.(true)
    setCatalogPending(true)
    catalogDialogs.request('wrapper-sidebar-catalog', () => {
      setCatalogPending(false)
      setCatalogOpen(true)
    })
  }
  const chosenCatalog = useMemo(() => selectedWrappers(catalog), [catalog])
  const filteredCatalog = useMemo(
    () => filterWrappers(chosenCatalog, query),
    [chosenCatalog, query]
  )
  const groups = useMemo(() => {
    const grouped = groupByTier(filteredCatalog)
    return query.trim() ? grouped.filter((group) => group.entries.length > 0) : grouped
  }, [filteredCatalog, query])
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

  const visibleTier = visibleWrapperTier(groups, expandedTier, query)
  const expandedBodyMaxHeight = useExpandedBodyMaxHeight(listRef, groups.length, visible)

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
    <CatalogSidebar
      title="Wrappers"
      resource="wrappers"
      width={sidebarWidth}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="搜索 wrapper"
      summary={`${chosenCatalog.length} 个 wrapper · ${chosenCatalog.filter((entry) => entry.packageEnabled !== false).length} 已启用`}
      action={<DiscoverButton expanded={catalogOpen} onClick={openCatalog} label="从目录添加" />}
    >
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
          minHeight: 0,
          py: 1,
          WebkitAppRegion: 'no-drag'
        }}
      >
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : filteredCatalog.length === 0 ? (
          <Box sx={{ px: 1.5, py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {query.trim() ? '没有匹配的 wrapper' : '尚未添加 wrapper，从目录选择需要的内容。'}
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
              expanded={group.tier === visibleTier}
              expandedBodyMaxHeight={expandedBodyMaxHeight}
              onExpandedChange={handleExpandedChange}
              onSelect={onSelect}
              onLoadMore={handleLoadMore}
              busyPackageId={busyPackageId}
              onSetPackageEnabled={onSetPackageEnabled}
            />
          ))
        )}
      </List>
      {visible && (
        <WrapperCatalogDialog
          open={catalogOpen}
          catalog={catalog}
          onRefresh={onRefresh}
          onSetPackageEnabled={onSetPackageEnabled}
          onClose={() => {
            catalogDialogs.cancel('wrapper-sidebar-catalog')
            setCatalogPending(false)
            setCatalogOpen(false)
          }}
        />
      )}
    </CatalogSidebar>
  )
}
