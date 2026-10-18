import { memoryUi } from './lib/memoryUi'
import { useUiLanguage } from '../../lib/i18n'
import { Alert, Box, Divider, Paper, Stack, Typography } from '@mui/material'

import type { Project } from '../../lib/projectTypes'
import { ProjectMemoryCard } from './components/ProjectMemoryCard'
import { projectMemorySettings } from './lib/projectMemorySettings'

type MemorySettingsPanelProps = {
  projects: Project[]
  onProjectUpdated: (project: Project) => void
}

export function MemorySettingsPanel({
  projects,
  onProjectUpdated
}: MemorySettingsPanelProps): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">{memoryUi.memory}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>
          {memoryUi.withProjectMemoryEnabledPhiSummarizesCompletedProject}
        </Typography>
      </Box>

      <Alert severity="info" variant="outlined" sx={{ borderRadius: 1 }}>
        {memoryUi.allowingTheAgentToRecordLessonsLetsIt}
      </Alert>

      <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
        {projects.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <Typography color="text.secondary">{memoryUi.noProjectsYet}</Typography>
          </Box>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {projects.map((project) => (
              <ProjectMemoryCard
                key={project.id}
                project={project}
                settings={projectMemorySettings(project)}
                onSettingsSaved={onProjectUpdated}
              />
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  )
}
