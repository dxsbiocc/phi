import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import type { InstalledPackageView } from '../../../../../shared/packageManagerTypes'
import type { TeamPublishedAdminRelease } from '../../../../../shared/teamPackTypes'

import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { packageSelectionKey } from '../lib/teamPackages'

export function TeamPublishSection({
  storeDir,
  packages,
  selected,
  busy,
  published,
  onToggle,
  onPublish
}: {
  storeDir: string | null
  packages: InstalledPackageView[]
  selected: string[]
  busy: boolean
  published: TeamPublishedAdminRelease | null
  onToggle: (entry: InstalledPackageView) => void
  onPublish: () => void
}): React.JSX.Element {
  useUiLanguage()
  const selectedSet = new Set(selected)
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
        {packages.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {teamCopy.noInstalledResources}
          </Typography>
        ) : (
          <List disablePadding>
            {packages.map((entry) => {
              const key = packageSelectionKey(entry)
              return (
                <ListItem key={key} disableGutters divider>
                  <FormControlLabel
                    sx={{ width: '100%', m: 0 }}
                    control={
                      <Checkbox checked={selectedSet.has(key)} onChange={() => onToggle(entry)} />
                    }
                    label={
                      <ListItemText
                        primary={entry.title}
                        secondary={`${entry.type} · ${entry.version}`}
                      />
                    }
                  />
                </ListItem>
              )
            })}
          </List>
        )}
        <Button variant="contained" disabled={busy || selected.length === 0} onClick={onPublish}>
          {teamCopy.publishSelected}
        </Button>
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
