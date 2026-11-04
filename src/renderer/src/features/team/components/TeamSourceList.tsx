import { useState } from 'react'
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
  onRemove,
  onSubmit
}: {
  sources: TeamSourceView[]
  busySourceId: string | null
  onCheck: (source: TeamSourceView) => void
  onRemove: (source: TeamSourceView) => void
  onSubmit: (source: TeamSourceView) => void
}): React.JSX.Element {
  useUiLanguage()
  const [expandedAnnouncements, setExpandedAnnouncements] = useState<Set<string>>(() => new Set())

  return (
    <List disablePadding>
      {/* eslint-disable-next-line max-lines-per-function -- row renders one cohesive source summary */}
      {sources.map((source, index) => {
        const announcements = [...source.status.announcements].sort(
          (left, right) =>
            Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
            right.release - left.release
        )
        const announcementsExpanded = expandedAnnouncements.has(source.id)
        const visibleAnnouncements = announcementsExpanded
          ? announcements
          : announcements.slice(0, 1)
        const forwardedResources = Object.entries(source.status.resources)
          .filter((entry) => entry[1].originalSource !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
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
                <Button
                  disabled={
                    busySourceId !== null ||
                    !source.status.submissionsAvailable ||
                    source.status.state === 'not-member'
                  }
                  onClick={() => onSubmit(source)}
                >
                  {teamCopy.submitResources}
                </Button>
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
                  {!source.status.submissionsAvailable ? (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {teamCopy.submissionUnavailable}
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
                  {announcements.length > 0 ? (
                    <Stack component="span" spacing={0.5} sx={{ display: 'block', pt: 0.75 }}>
                      <Typography component="span" variant="subtitle2" sx={{ display: 'block' }}>
                        {announcementsExpanded
                          ? teamCopy.announcements
                          : teamCopy.latestAnnouncement}
                      </Typography>
                      {visibleAnnouncements.map((announcement) => (
                        <Stack
                          key={`${announcement.release}:${announcement.publishedAt}`}
                          component="span"
                          spacing={0.25}
                          sx={{ display: 'block' }}
                        >
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            {teamCopy.announcementVersionValue(
                              announcement.release,
                              new Intl.DateTimeFormat(getUiLocale(), {
                                dateStyle: 'medium',
                                timeStyle: 'short'
                              }).format(new Date(announcement.publishedAt))
                            )}
                          </Typography>
                          <Typography
                            component="span"
                            variant="body2"
                            sx={{ display: 'block', whiteSpace: 'pre-wrap' }}
                          >
                            {announcement.text}
                          </Typography>
                        </Stack>
                      ))}
                      {announcements.length > 1 ? (
                        <Button
                          size="small"
                          sx={{ alignSelf: 'flex-start' }}
                          onClick={() =>
                            setExpandedAnnouncements((current) => {
                              const next = new Set(current)
                              if (next.has(source.id)) next.delete(source.id)
                              else next.add(source.id)
                              return next
                            })
                          }
                        >
                          {announcementsExpanded
                            ? teamCopy.showLatestAnnouncement
                            : teamCopy.showAllAnnouncements(announcements.length)}
                        </Button>
                      ) : null}
                    </Stack>
                  ) : null}
                  {forwardedResources.length > 0 ? (
                    <Stack component="span" spacing={0.25} sx={{ display: 'block', pt: 0.75 }}>
                      <Typography component="span" variant="subtitle2" sx={{ display: 'block' }}>
                        {teamCopy.forwardedResources}
                      </Typography>
                      {forwardedResources.map(([resource, metadata]) => {
                        const origin = metadata.originalSource
                        if (!origin) return null
                        return (
                          <Typography
                            key={resource}
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            {teamCopy.originalSourceValue(
                              resource,
                              origin.teamName,
                              origin.publicKeyFingerprint
                            )}
                          </Typography>
                        )
                      })}
                    </Stack>
                  ) : null}
                </Stack>
              }
            />
          </ListItem>
        )
      })}
    </List>
  )
}
