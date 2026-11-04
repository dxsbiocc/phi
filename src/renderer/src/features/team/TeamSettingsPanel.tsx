import { useState } from 'react'
import { Alert, Box, Stack, Tab, Tabs, Typography } from '@mui/material'

import { useUiLanguage } from '../../lib/i18n'
import { AdminTeamsPanel } from './components/AdminTeamsPanel'
import { MemberTeamsPanel } from './components/MemberTeamsPanel'
import { useTeamPackMember } from './hooks/useTeamPackMember'
import { teamCopy } from './lib/teamCopy'

type TeamSettingsTab = 'member' | 'admin'

export function TeamSettingsPanel(): React.JSX.Element {
  useUiLanguage()
  const [tab, setTab] = useState<TeamSettingsTab>('member')
  const member = useTeamPackMember()

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Box>
        <Typography variant="h5">{teamCopy.team}</Typography>
        <Alert severity="info" sx={{ mt: 1 }}>
          {teamCopy.resourceCatalogHint}
        </Alert>
      </Box>
      <Tabs
        value={tab}
        onChange={(_, value: TeamSettingsTab) => setTab(value)}
        aria-label={teamCopy.team}
      >
        <Tab value="member" label={teamCopy.joinedTeams} />
        <Tab value="admin" label={teamCopy.managedTeams} />
      </Tabs>
      {tab === 'member' ? <MemberTeamsPanel controller={member} /> : <AdminTeamsPanel />}
    </Stack>
  )
}
