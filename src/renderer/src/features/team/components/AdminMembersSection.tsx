import { Button, Chip, List, ListItem, ListItemText, Paper, Stack, Typography } from '@mui/material'
import type {
  TeamAdminMember,
  TeamAdminMemberModelMetadata
} from '../../../../../shared/teamPackTypes'

import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'

function shortRecipient(recipient: string): string {
  return recipient.length <= 24 ? recipient : `${recipient.slice(0, 12)}…${recipient.slice(-8)}`
}

// eslint-disable-next-line max-lines-per-function -- each row keeps identity, grant metadata, and actions together
export function AdminMembersSection({
  members,
  modelGrants,
  onAdd,
  onEditModels,
  onRemove
}: {
  members: TeamAdminMember[]
  modelGrants: TeamAdminMemberModelMetadata[]
  onAdd: () => void
  onEditModels: (member: TeamAdminMember) => void
  onRemove: (member: TeamAdminMember) => void
}): React.JSX.Element {
  useUiLanguage()
  const currentMembers = members.filter((member) => !member.removedAt)
  const grantsByMember = new Map(modelGrants.map((entry) => [entry.memberId, entry.models]))

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">{teamCopy.members}</Typography>
          <Button variant="outlined" onClick={onAdd}>
            {teamCopy.addMember}
          </Button>
        </Stack>
        {currentMembers.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {teamCopy.noMembers}
          </Typography>
        ) : (
          <List disablePadding>
            {currentMembers.map((member, index) => {
              const models = grantsByMember.get(member.memberId) ?? []
              return (
                <ListItem
                  key={member.memberId}
                  disableGutters
                  divider={index < currentMembers.length - 1}
                  alignItems="flex-start"
                  sx={{ flexDirection: 'column', gap: 1 }}
                >
                  <ListItemText
                    primary={member.displayName}
                    secondary={
                      <Stack component="span" spacing={0.25}>
                        <Typography component="code" variant="caption">
                          {shortRecipient(member.recipient)}
                        </Typography>
                        <Typography component="span" variant="caption" color="text.secondary">
                          {teamCopy.joinedValue(
                            new Intl.DateTimeFormat(getUiLocale(), { dateStyle: 'medium' }).format(
                              new Date(member.addedAt)
                            )
                          )}
                        </Typography>
                      </Stack>
                    }
                  />
                  <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
                    {models.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        {teamCopy.noModelKeys}
                      </Typography>
                    ) : (
                      models.map((model) => (
                        <Chip
                          key={`${model.providerId}:${model.label}`}
                          size="small"
                          label={`${model.providerId} · ${model.label}`}
                        />
                      ))
                    )}
                  </Stack>
                  <Stack direction="row" spacing={1}>
                    <Button size="small" onClick={() => onEditModels(member)}>
                      {teamCopy.editModelKeys}
                    </Button>
                    <Button size="small" color="error" onClick={() => onRemove(member)}>
                      {teamCopy.removeMember}
                    </Button>
                  </Stack>
                </ListItem>
              )
            })}
          </List>
        )}
      </Stack>
    </Paper>
  )
}
