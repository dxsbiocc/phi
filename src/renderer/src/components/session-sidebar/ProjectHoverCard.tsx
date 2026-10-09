import { Box, Typography } from '@mui/material'

import { ROW_LABEL_FONT_SIZE, ROW_META_FONT_SIZE } from '../../lib/sessionSidebarShared'
import type { Project } from '../../types'
import { projectHoverDetailRows } from './projectHoverDetails'

export function ProjectHoverCard({
  project,
  sessionsReady,
  sessionCount
}: {
  project: Project
  sessionsReady: boolean
  sessionCount: number
}): React.JSX.Element {
  return (
    <Box data-phi-project-hover-details="true" sx={{ minWidth: 220, maxWidth: 320 }}>
      <Typography sx={{ fontSize: ROW_LABEL_FONT_SIZE, fontWeight: 700, overflowWrap: 'anywhere' }}>
        {project.name}
      </Typography>
      <Typography sx={{ mt: 0.25, fontSize: ROW_META_FONT_SIZE, color: 'text.secondary' }}>
        {project.location.kind === 'ssh' ? '远程项目' : '本地项目'}
      </Typography>
      <Box
        sx={{
          mt: 1.25,
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          columnGap: 1.5,
          rowGap: 0.75,
          fontSize: ROW_META_FONT_SIZE
        }}
      >
        {projectHoverDetailRows(project, sessionsReady, sessionCount).map((item) => (
          <Box key={item.label} sx={{ display: 'contents' }}>
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {item.label}
            </Box>
            <Box
              component="span"
              title={item.value}
              sx={{ minWidth: 0, overflowWrap: 'anywhere', color: 'text.primary' }}
            >
              {item.value}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
