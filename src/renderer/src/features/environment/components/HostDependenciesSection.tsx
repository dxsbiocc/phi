import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type { EnvironmentHostDependency } from '../../../../../shared/environmentTypes'

function dependencyStatus(dependency: EnvironmentHostDependency): {
  label: string
  color: 'success' | 'warning' | 'default'
} {
  if (dependency.status === 'ready') return { label: '可用', color: 'success' }
  if (dependency.status === 'unavailable') return { label: '不可用', color: 'warning' }
  return { label: '未检测到', color: 'default' }
}

export function HostDependenciesSection({
  dependencies
}: {
  dependencies: readonly EnvironmentHostDependency[]
}): React.JSX.Element {
  return (
    <Stack component="section" spacing={1.25} aria-labelledby="host-dependencies-title">
      <Box>
        <Typography id="host-dependencies-title" variant="h6">
          宿主依赖
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Docker、Singularity / Apptainer 和 LibreOffice 由本机提供；Phi 只检查，不会安装。
        </Typography>
      </Box>

      {dependencies.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          尚未完成宿主依赖检测。
        </Typography>
      ) : (
        <Stack spacing={1}>
          {dependencies.map((dependency) => {
            const status = dependencyStatus(dependency)
            return (
              <Paper key={dependency.id} variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
                <Stack spacing={0.75}>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <Typography variant="body1" sx={{ fontWeight: 700 }}>
                      {dependency.label}
                    </Typography>
                    <Chip
                      size="small"
                      color={status.color}
                      variant="outlined"
                      label={status.label}
                    />
                  </Stack>
                  {dependency.path || dependency.version || dependency.detail ? (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ wordBreak: 'break-all' }}
                    >
                      {[dependency.path, dependency.version, dependency.detail]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  ) : null}
                  {dependency.messages?.map((message) => (
                    <Typography key={message} variant="caption" color="text.secondary">
                      {message}
                    </Typography>
                  ))}
                </Stack>
              </Paper>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
