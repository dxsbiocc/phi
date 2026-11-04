import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type { InstalledPackageView } from '../../../../../shared/packageManagerTypes'
import type {
  TeamPublishedAdminRelease,
  TeamResourceSharing
} from '../../../../../shared/teamPackTypes'

import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { packageSelectionKey } from '../lib/teamPackages'

const MAX_ANNOUNCEMENT_LENGTH = 4000

interface TeamPublishSectionProps {
  storeDir: string | null
  teamId: string
  latestRelease: number | null
  packages: InstalledPackageView[]
  selected: string[]
  sharingByKey: Record<string, TeamResourceSharing>
  announcement: string
  busy: boolean
  published: TeamPublishedAdminRelease | null
  onToggle: (entry: InstalledPackageView) => void
  onSharingChange: (entry: InstalledPackageView, sharing: TeamResourceSharing) => void
  onAnnouncementChange: (value: string) => void
  onPublish: () => void
  onAnnounceOnly: () => void
}

function hasForbiddenAnnouncementControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return (
      codePoint <= 0x09 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
  })
}

function TeamPackageRow({
  entry,
  teamId,
  selected,
  sharing,
  onToggle,
  onSharingChange
}: {
  entry: InstalledPackageView
  teamId: string
  selected: boolean
  sharing: TeamResourceSharing
  onToggle: () => void
  onSharingChange: (sharing: TeamResourceSharing) => void
}): React.JSX.Element {
  const teamSource = entry.teamSource
  const sourceOrigin = teamSource?.originalSource ?? teamSource
  const restrictedBySource =
    teamSource !== undefined && teamSource.teamId !== teamId && teamSource.sharing === 'team-only'
  return (
    <ListItem disableGutters divider>
      <Stack spacing={0.5} sx={{ width: '100%' }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ alignItems: { sm: 'center' } }}
        >
          <FormControlLabel
            disabled={restrictedBySource}
            sx={{ flex: 1, m: 0 }}
            control={<Checkbox checked={selected} onChange={onToggle} />}
            label={
              <ListItemText primary={entry.title} secondary={`${entry.type} · ${entry.version}`} />
            }
          />
          <TextField
            select
            size="small"
            label={teamCopy.sharing}
            value={sharing}
            disabled={!selected || restrictedBySource}
            sx={{ minWidth: 180 }}
            onChange={(event) => onSharingChange(event.target.value as TeamResourceSharing)}
          >
            <MenuItem value="team-only">{teamCopy.teamOnly}</MenuItem>
            <MenuItem value="forwardable">{teamCopy.forwardable}</MenuItem>
          </TextField>
        </Stack>
        {sourceOrigin ? (
          <Typography variant="caption" color="text.secondary">
            {teamCopy.teamSourceValue(sourceOrigin.teamName, sourceOrigin.teamKeyId)}
          </Typography>
        ) : null}
        {restrictedBySource ? (
          <Typography variant="caption" color="warning.dark">
            {teamCopy.teamOnlySourceReason}
          </Typography>
        ) : null}
      </Stack>
    </ListItem>
  )
}

function TeamPackageList({
  packages,
  teamId,
  selected,
  sharingByKey,
  onToggle,
  onSharingChange
}: Pick<
  TeamPublishSectionProps,
  'packages' | 'teamId' | 'selected' | 'sharingByKey' | 'onToggle' | 'onSharingChange'
>): React.JSX.Element {
  const selectedSet = new Set(selected)
  if (packages.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {teamCopy.noInstalledResources}
      </Typography>
    )
  }
  return (
    <List disablePadding>
      {packages.map((entry) => {
        const key = packageSelectionKey(entry)
        return (
          <TeamPackageRow
            key={key}
            entry={entry}
            teamId={teamId}
            selected={selectedSet.has(key)}
            sharing={sharingByKey[key] ?? 'team-only'}
            onToggle={() => onToggle(entry)}
            onSharingChange={(sharing) => onSharingChange(entry, sharing)}
          />
        )
      })}
    </List>
  )
}

function AnnouncementPublishControls({
  latestRelease,
  selectedCount,
  announcement,
  busy,
  onAnnouncementChange,
  onPublish,
  onAnnounceOnly
}: Pick<
  TeamPublishSectionProps,
  | 'latestRelease'
  | 'announcement'
  | 'busy'
  | 'onAnnouncementChange'
  | 'onPublish'
  | 'onAnnounceOnly'
> & { selectedCount: number }): React.JSX.Element {
  const announcementLength = [...announcement].length
  const announcementHasContent = announcement.trim().length > 0
  const announcementHasControl = hasForbiddenAnnouncementControl(announcement)
  const announcementTooLong = announcementLength > MAX_ANNOUNCEMENT_LENGTH
  const validAnnouncement =
    announcementHasContent && !announcementTooLong && !announcementHasControl
  return (
    <>
      <TextField
        multiline
        minRows={3}
        label={teamCopy.announcement}
        placeholder={teamCopy.announcementPlaceholder}
        value={announcement}
        error={announcementHasControl || announcementTooLong}
        helperText={
          announcementHasControl
            ? teamCopy.announcementControlError
            : announcementTooLong
              ? teamCopy.announcementLengthError(announcementLength, MAX_ANNOUNCEMENT_LENGTH)
              : teamCopy.announcementHelp(announcementLength, MAX_ANNOUNCEMENT_LENGTH)
        }
        onChange={(event) => onAnnouncementChange(event.target.value)}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button
          variant="contained"
          disabled={busy || selectedCount === 0 || (announcementHasContent && !validAnnouncement)}
          onClick={onPublish}
        >
          {teamCopy.publishSelected}
        </Button>
        <Button
          variant="outlined"
          disabled={busy || latestRelease === null || !validAnnouncement}
          onClick={onAnnounceOnly}
        >
          {teamCopy.announceOnly}
        </Button>
      </Stack>
      {latestRelease === null ? (
        <Typography variant="caption" color="text.secondary">
          {teamCopy.announceOnlyRequiresRelease}
        </Typography>
      ) : null}
    </>
  )
}

export function TeamPublishSection({
  storeDir,
  teamId,
  latestRelease,
  packages,
  selected,
  sharingByKey,
  announcement,
  busy,
  published,
  onToggle,
  onSharingChange,
  onAnnouncementChange,
  onPublish,
  onAnnounceOnly
}: TeamPublishSectionProps): React.JSX.Element {
  useUiLanguage()
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Typography variant="h6">{teamCopy.publish}</Typography>
        <Alert severity="info">
          <Typography variant="body2">{teamCopy.fixedPublishingFolderHint}</Typography>
          <Typography component="code" variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {storeDir ?? teamCopy.choosePublishingFolderOnPublish}
          </Typography>
        </Alert>
        <Typography variant="subtitle2">{teamCopy.installedResources}</Typography>
        <TeamPackageList
          packages={packages}
          teamId={teamId}
          selected={selected}
          sharingByKey={sharingByKey}
          onToggle={onToggle}
          onSharingChange={onSharingChange}
        />
        <AnnouncementPublishControls
          latestRelease={latestRelease}
          selectedCount={selected.length}
          announcement={announcement}
          busy={busy}
          onAnnouncementChange={onAnnouncementChange}
          onPublish={onPublish}
          onAnnounceOnly={onAnnounceOnly}
        />
        {published ? (
          <Alert severity="success">
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {teamCopy.publishedReleaseValue(published.release)}
            </Typography>
            <Typography variant="body2">{teamCopy.syncFolderHint}</Typography>
            <Typography component="code" variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              {published.storeDir}
            </Typography>
          </Alert>
        ) : null}
      </Stack>
    </Paper>
  )
}
