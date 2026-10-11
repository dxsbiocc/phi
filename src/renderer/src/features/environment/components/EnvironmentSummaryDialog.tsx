import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type { EnvironmentSnapshot } from '../../../../../shared/environmentTypes'
import { environmentHostResources } from '../lib/environmentPanel'

export type EnvironmentSummaryDialogProps = {
  open: boolean
  snapshot: EnvironmentSnapshot | null
  onClose: () => void
  onOpenSettings: () => void
}

export function EnvironmentSummaryDialog({
  open,
  snapshot,
  onClose,
  onOpenSettings
}: EnvironmentSummaryDialogProps): React.JSX.Element {
  const { dependencies, tools } = environmentHostResources(snapshot)
  const capabilityGroups = [
    {
      title: 'Jupyter 环境',
      items: tools.filter((tool) => tool.id === 'jupyter')
    },
    {
      title: 'Nextflow 环境',
      items: [
        ...tools.filter((tool) => tool.id === 'nextflow'),
        ...dependencies.filter(
          (dependency) => dependency.id === 'docker' || dependency.id === 'singularity'
        )
      ]
    }
  ]
  const capabilities = capabilityGroups.flatMap((group) => group.items)
  const readyCapabilities = capabilities.filter((capability) => capability.status === 'ready')

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>工作台环境检测</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Phi 会自动检测本机已有的 Jupyter、Nextflow 与容器运行时，并把结果合并到对应环境中。
        </Typography>

        <Alert
          severity={readyCapabilities.length === capabilities.length ? 'success' : 'warning'}
          sx={{ mb: 1.5 }}
        >
          宿主能力：{readyCapabilities.length} 项可用，
          {capabilities.length - readyCapabilities.length} 项未就绪
        </Alert>
        {capabilities.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            尚无检测结果。
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {capabilityGroups.map((group) => (
              <Box key={group.title}>
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  {group.title}
                </Typography>
                <Stack
                  direction="row"
                  spacing={0.75}
                  useFlexGap
                  sx={{ flexWrap: 'wrap', rowGap: 0.75 }}
                >
                  {group.items.map((item) => (
                    <Chip
                      key={item.id}
                      size="small"
                      color={item.status === 'ready' ? 'success' : 'default'}
                      variant="outlined"
                      label={`${item.label} · ${item.status === 'ready' ? '可用' : '未就绪'}`}
                    />
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onOpenSettings}>打开环境设置</Button>
        <Button variant="contained" onClick={onClose}>
          知道了
        </Button>
      </DialogActions>
    </Dialog>
  )
}
