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
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">记忆</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>
          开启项目记忆后，Phi
          会在后台用当前会话的模型总结这个项目里已结束的对话，并在之后的新会话里提供这份总结。总结只保存在这台电脑上，远程项目也一样，不会写到服务器。设置对新会话生效。
        </Typography>
      </Box>

      <Alert severity="info" variant="outlined" sx={{ borderRadius: 1 }}>
        “允许 agent 记录经验”会让 agent
        在工作中主动记下项目约定、非显而易见的修复等经验。每条经验都可以在这里查看和删除。
      </Alert>

      <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
        {projects.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <Typography color="text.secondary">还没有项目</Typography>
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
