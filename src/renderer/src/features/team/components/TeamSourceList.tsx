import { Button, Chip, List, ListItem, ListItemText, Stack, Typography } from '@mui/material'

import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import type { TeamSourceView } from '../lib/teamTypes'

function sourceLocation(source: TeamSourceView): string {
  return source.location.kind === 'directory' ? source.location.path : source.location.url
}

// eslint-disable-next-line max-lines-per-function -- operational state and credential decisions share each source row
export function TeamSourceList({
  sources,
  busySourceId,
  onCheck,
  onRemove
}: {
  sources: TeamSourceView[]
  busySourceId: string | null
  onCheck: (source: TeamSourceView) => void
  onRemove: (source: TeamSourceView) => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <List disablePadding>
      {/* eslint-disable-next-line max-lines-per-function -- row renders one cohesive source summary */}
      {sources.map((source, index) => {
        const checkedAt = source.status.lastCheckedAt
          ? new Intl.DateTimeFormat(getUiLocale(), {
              dateStyle: 'medium',
              timeStyle: 'short'
            }).format(new Date(source.status.lastCheckedAt))
          : teamCopy.neverChecked
        return (
          <ListItem
            key={source.id}
            divider={index < sources.length - 1}
            disableGutters
            alignItems="flex-start"
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button disabled={busySourceId !== null} onClick={() => onCheck(source)}>
                  {teamCopy.checkNow}
                </Button>
                <Button
                  color="error"
                  disabled={busySourceId !== null}
                  onClick={() => onRemove(source)}
                >
                  {teamCopy.remove}
                </Button>
              </Stack>
            }
            sx={{ pr: 24 }}
          >
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography component="span" sx={{ fontWeight: 700 }}>
                    {source.teamName}
                  </Typography>
                  <Chip
                    size="small"
                    label={teamCopy.sourceStatus[source.status.state]}
                    color={source.status.state === 'healthy' ? 'success' : 'default'}
                  />
                </Stack>
              }
              secondary={
                <Stack component="span" spacing={0.25} sx={{ mt: 0.5 }}>
                  <Typography component="span" variant="body2" color="text.secondary">
                    {sourceLocation(source)}
                  </Typography>
                  <Typography component="span" variant="caption" color="text.secondary">
                    {source.status.lastSuccessfulRelease === null
                      ? teamCopy.neverUpdated
                      : teamCopy.versionValue(source.status.lastSuccessfulRelease)}
                    {' · '}
                    {teamCopy.lastCheckedValue(checkedAt)}
                  </Typography>
                  {source.status.state === 'not-member' ? (
                    <Typography component="span" variant="caption" color="warning.dark">
                      {teamCopy.formerMemberHint}
                    </Typography>
                  ) : null}
                  {source.status.credentialProviders.length > 0 ? (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {teamCopy.configuredProvidersValue(
                        source.status.credentialProviders.join(', ')
                      )}
                    </Typography>
                  ) : null}
                  {source.status.credentialConflicts.map((provider) => (
                    <Typography
                      key={`conflict:${provider}`}
                      component="span"
                      variant="caption"
                      color="warning.dark"
                    >
                      {teamCopy.credentialConflictValue(provider)}
                    </Typography>
                  ))}
                  {source.status.skippedProviders.map((provider) => (
                    <Typography
                      key={`skipped:${provider}`}
                      component="span"
                      variant="caption"
                      color="text.secondary"
                    >
                      {teamCopy.skippedProviderValue(provider)}
                    </Typography>
                  ))}
                </Stack>
              }
            />
          </ListItem>
        )
      })}
    </List>
  )
}
