import { useState } from 'react'
import { Box, Button, Typography } from '@mui/material'

import { useUiLanguage } from '../../../lib/i18n'
import { settingsUi } from '../lib/settingsUi'
import { ExternalSkillsImportDialog } from './ExternalSkillsImportDialog'

export function ExternalSkillsSettingsGroup(): React.JSX.Element {
  useUiLanguage()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <Box data-phi-external-skills-settings>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {settingsUi.externalSkills}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        {settingsUi.externalSkillsHint}
      </Typography>
      <Button
        size="small"
        variant="contained"
        sx={{ mt: 1.25 }}
        onClick={() => setDialogOpen(true)}
      >
        {settingsUi.importExternalSkills}
      </Button>
      <ExternalSkillsImportDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </Box>
  )
}
