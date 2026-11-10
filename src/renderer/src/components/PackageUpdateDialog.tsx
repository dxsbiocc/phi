import { useMemo, useState } from 'react'
import { settingsUi } from '../features/settings/lib/settingsUi'
import { phiPluginDisplayTitle } from '../features/phi-plugin/lib/phiPlugins'
import { getUiLocale, useUiLanguage } from '../lib/i18n'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  Divider,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import type { ChipProps } from '@mui/material'
import type { PackageChangelogEntry, PackageUpdateView } from '../../../shared/packageManagerTypes'
import MarkdownContent from './MarkdownContent'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../lib/packageTrust'
import {
  formatPackageChangelogDate,
  parsePackageChangelogNotes,
  type PackageChangeType,
  type PackageChangelogChange
} from '../lib/packageChangelog'
import { PhiIcons } from '../icons'
import { OverlayScroll } from './OverlayScroll'

const ExpandIcon = PhiIcons.action.expand
const CloseIcon = PhiIcons.action.close
/** Each open version scrolls its own notes; its row and the dialog stay put. */
const VERSION_NOTES_MAX_HEIGHT = 'min(48vh, 480px)'
const COLLAPSED_NOTE_LINES = 8
const COLLAPSED_NOTE_MAX_LENGTH = 640

const CHANGE_COLORS: Readonly<Record<PackageChangeType, ChipProps['color']>> = {
  new: 'primary',
  improved: 'info',
  fixed: 'success',
  breaking: 'error'
}

function isLongNotes(notes: string): boolean {
  return (
    notes.length > COLLAPSED_NOTE_MAX_LENGTH ||
    notes.split('\n').filter((line) => line.trim()).length > COLLAPSED_NOTE_LINES
  )
}

function changeTypeLabel(type: PackageChangeType): string {
  if (type === 'new') return settingsUi.changeNew
  if (type === 'improved') return settingsUi.changeImproved
  if (type === 'fixed') return settingsUi.changeFixed
  return settingsUi.changeBreaking
}

/** Existing dialog fade/expand behaviour, reused for the block-markdown details. */
function NotesBody({
  notes,
  detailsLabel
}: {
  notes: string
  detailsLabel?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const long = isLongNotes(notes)
  return (
    <Box>
      {detailsLabel ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5, fontWeight: 600 }}
        >
          {detailsLabel}
        </Typography>
      ) : null}
      <Box sx={{ position: 'relative' }}>
        <Box
          sx={{
            maxHeight: expanded || !long ? undefined : 'calc(1.5em * 8)',
            overflow: expanded || !long ? undefined : 'hidden',
            fontSize: '0.875rem',
            lineHeight: 1.5,
            '& > :first-of-type': { mt: 0 },
            '& > :last-of-type': { mb: 0 }
          }}
        >
          <MarkdownContent text={notes} />
        </Box>
        {long && !expanded ? (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              insetInline: 0,
              bottom: 0,
              height: '2.5em',
              pointerEvents: 'none',
              background: (theme) =>
                `linear-gradient(to bottom, transparent, ${theme.palette.background.paper})`
            }}
          />
        ) : null}
      </Box>
      {long ? (
        <Button size="small" sx={{ mt: 0.5 }} onClick={() => setExpanded((value) => !value)}>
          {expanded ? settingsUi.showLess : settingsUi.showMore}
        </Button>
      ) : null}
    </Box>
  )
}

function ChangeRow({ change }: { change: PackageChangelogChange }): React.JSX.Element {
  return (
    <Stack
      component="li"
      direction="row"
      spacing={1}
      // Baseline alignment puts the chip label on the first line of the text.
      sx={{ alignItems: 'baseline', minWidth: 0 }}
    >
      <Chip
        size="small"
        color={CHANGE_COLORS[change.type]}
        label={changeTypeLabel(change.type)}
        sx={{ flexShrink: 0 }}
      />
      <Box sx={{ minWidth: 0, flex: 1, fontSize: '0.875rem', lineHeight: 1.5 }}>
        <MarkdownContent text={change.text} inline />
      </Box>
    </Stack>
  )
}

function VersionAccordion({
  change,
  latest,
  expanded,
  onExpandedChange
}: {
  change: PackageChangelogEntry
  latest: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): React.JSX.Element {
  const parsed = useMemo(() => parsePackageChangelogNotes(change.notes), [change.notes])
  const date = formatPackageChangelogDate(change.date, getUiLocale())

  return (
    <Accordion
      expanded={expanded}
      onChange={(_event, next) => onExpandedChange(next)}
      disableGutters
      elevation={0}
      slotProps={{ transition: { timeout: { enter: 200, exit: 120 } } }}
      sx={{
        bgcolor: 'transparent',
        // The list frame draws the outer border; items only divide from each other.
        border: 0,
        borderRadius: 0,
        '& + &': { borderTop: 1, borderColor: 'divider' },
        '&::before': { display: 'none' },
        '&.Mui-expanded': { my: 0 }
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandIcon fontSize="small" />}
        sx={{
          px: 1.5,
          py: 0.25,
          minHeight: 44,
          '& .MuiAccordionSummary-content': { alignItems: 'center', my: 0.5, minWidth: 0, gap: 1 }
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0, flex: 1 }}
        >
          <Typography
            component="span"
            sx={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.875rem' }}
          >
            {change.version}
          </Typography>
          {latest ? <Chip size="small" color="success" label={settingsUi.latestRelease} /> : null}
          {parsed.breaking ? (
            <Chip size="small" color="error" label={settingsUi.breakingRelease} />
          ) : null}
          {date ? (
            <Typography component="span" variant="caption" color="text.secondary">
              {date}
            </Typography>
          ) : null}
        </Stack>
      </AccordionSummary>
      {/* The version row stays fixed; only its notes scroll, below a divider. */}
      <AccordionDetails sx={{ p: 0, borderTop: 1, borderColor: 'divider' }}>
        <OverlayScroll
          sx={{ maxHeight: VERSION_NOTES_MAX_HEIGHT }}
          contentSx={{ overscrollBehavior: 'contain' }}
        >
          <Box sx={{ px: 1.5, pt: 1.5, pb: 1.5 }}>
            {parsed.changes.length > 0 ? (
              <>
                <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                  {parsed.changes.map((item, index) => (
                    <ChangeRow key={`${change.version}:${index}`} change={item} />
                  ))}
                </Stack>
                {parsed.otherNotes ? (
                  <Box sx={{ mt: 1.5 }}>
                    <NotesBody
                      notes={parsed.otherNotes}
                      detailsLabel={settingsUi.otherReleaseDetails}
                    />
                  </Box>
                ) : null}
              </>
            ) : (
              <NotesBody notes={change.notes} />
            )}
          </Box>
        </OverlayScroll>
      </AccordionDetails>
    </Accordion>
  )
}

/** Newest release open by default; the rest can be opened independently. */
function PackageChangelogList({
  changes
}: {
  changes: readonly PackageChangelogEntry[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]))

  const setVersionExpanded = (index: number, isExpanded: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (isExpanded) next.add(index)
      else next.delete(index)
      return next
    })
  }

  return (
    <Box
      data-phi-package-changelog="true"
      sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}
    >
      {changes.map((change, index) => (
        <VersionAccordion
          key={`${change.version}:${index}`}
          change={change}
          latest={index === 0}
          expanded={expanded.has(index)}
          onExpandedChange={(isExpanded) => setVersionExpanded(index, isExpanded)}
        />
      ))}
    </Box>
  )
}

/** One package update, opened from that package's message. */
export function PackageUpdateDialog({
  open,
  update,
  busy,
  error,
  onClose,
  onApply
}: {
  open: boolean
  update: PackageUpdateView | null
  busy: boolean
  error: string | null
  onClose: () => void
  onApply: (update: PackageUpdateView) => void
}): React.JSX.Element {
  useUiLanguage()
  const changes = update?.changes ?? []
  const updateButton = update ? (
    <Button
      variant="contained"
      disabled={busy}
      onClick={() => onApply(update)}
      sx={{ minWidth: 88, flexShrink: 0 }}
    >
      {busy ? <CircularProgress size={14} color="inherit" /> : settingsUi.update}
    </Button>
  ) : null
  const title =
    update === null
      ? ''
      : update.type === 'plugin'
        ? phiPluginDisplayTitle({ id: update.id, title: update.title })
        : update.title
  return (
    <Dialog
      open={open && update !== null}
      onClose={busy ? undefined : onClose}
      maxWidth="md"
      fullWidth
    >
      {update ? (
        <Stack spacing={2} sx={{ p: 3, position: 'relative' }}>
          <IconButton
            size="small"
            aria-label={settingsUi.close}
            disabled={busy}
            onClick={onClose}
            sx={{ position: 'absolute', top: 12, right: 12 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
          <Box>
            <Typography variant="overline" color="text.secondary">
              {settingsUi.contentPackageUpdate}
            </Typography>
            {/* The update covers every listed version, so it belongs to the package title. */}
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <Typography variant="h5" sx={{ flex: 1, minWidth: 0 }}>
                {title}
              </Typography>
              {updateButton}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {update.currentVersion} → {update.newVersion}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {settingsUi.updatesAreInstalledOnlyAfterYourConfirmation}
            </Typography>
          </Box>
          <Divider />
          {error ? <Alert severity="error">{error}</Alert> : null}
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  {settingsUi.whatsNew}
                </Typography>
                {update.trust !== 'imported' && (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={PACKAGE_TRUST_LABELS[update.trust]}
                    title={PACKAGE_TRUST_DESCRIPTIONS[update.trust]}
                  />
                )}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                  {settingsUi.releasesCount(changes.length)}
                </Typography>
              </Stack>
              {changes.length > 0 ? (
                <PackageChangelogList
                  key={`${update.id}:${update.currentVersion}:${update.newVersion}`}
                  changes={changes}
                />
              ) : (
                <Stack
                  direction="row"
                  spacing={2}
                  sx={{
                    alignItems: 'center',
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    px: 1.5,
                    py: 1.25
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" color="text.secondary">
                      {settingsUi.noReleaseNotesForThisVersion}
                    </Typography>
                    {update.summary ? (
                      <Typography variant="body2" color="text.secondary">
                        {update.summary}
                      </Typography>
                    ) : null}
                  </Box>
                </Stack>
              )}
            </Box>
          </Stack>
        </Stack>
      ) : null}
    </Dialog>
  )
}
