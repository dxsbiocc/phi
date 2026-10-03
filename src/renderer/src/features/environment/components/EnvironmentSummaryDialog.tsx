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
import { buildEnvironmentSections } from '../lib/environmentPanel'

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
  const sections = buildEnvironmentSections([], snapshot)
  const dependencies = sections[1].items
  const hostTools = sections[2].items
  const readyDependencies = dependencies.filter((dependency) => dependency.status === 'ready')
  const missingDependencies = dependencies.filter((dependency) => dependency.status !== 'ready')

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>工作台环境检测</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Phi 的 Python、R、Conda、Nextflow 和 Jupyter
          默认由托管环境提供。本次仅检查必须由本机提供的依赖， 并列出可明确选择的非托管工具。
        </Typography>

        <Alert severity={missingDependencies.length ? 'warning' : 'success'} sx={{ mb: 1.5 }}>
          宿主依赖：{readyDependencies.length} 项可用，{missingDependencies.length} 项未就绪
        </Alert>
        <Stack spacing={0.75} sx={{ mb: 2 }}>
          {dependencies.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              尚无检测结果
            </Typography>
          ) : (
            dependencies.map((dependency) => (
              <Box key={dependency.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Chip
                  size="small"
                  color={dependency.status === 'ready' ? 'success' : 'default'}
                  label={dependency.status === 'ready' ? '可用' : '缺失'}
                  sx={{ mt: 0.25 }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {dependency.label}
                  </Typography>
                  {dependency.path || dependency.version ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}
                    >
                      {[dependency.path, dependency.version].filter(Boolean).join(' · ')}
                    </Typography>
                  ) : null}
                </Box>
              </Box>
            ))
          )}
        </Stack>

        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
          可选的本机工具
        </Typography>
        {hostTools.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            未检测到；仍会使用 Phi 托管版本。
          </Typography>
        ) : (
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
            {hostTools.map((tool) => (
              <Chip
                key={tool.id}
                size="small"
                variant="outlined"
                label={`${tool.label} · ${tool.selected ? '已明确启用' : '非托管'}`}
              />
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
