import { useId } from 'react'
import {
  Alert,
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  PHI_PLUGIN_APPROVAL_LABELS,
  PHI_PLUGIN_COMPONENT_LABELS,
  phiPluginComponentEnvironments,
  type PhiPluginInspectableComponent
} from '../lib/phiPluginComponents'

function DetailField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Stack spacing={0.5}>
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ overflowWrap: 'anywhere' }}>{children}</Box>
    </Stack>
  )
}

export function PhiPluginComponentDialog({
  plugin,
  component,
  open,
  icon,
  onClose
}: {
  plugin: PhiPluginDisplayItem
  component: PhiPluginInspectableComponent
  open: boolean
  icon: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const environments = phiPluginComponentEnvironments(plugin, component)
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Box sx={{ color: 'primary.main', display: 'flex' }}>{icon}</Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block' }}
            >
              {PHI_PLUGIN_COMPONENT_LABELS[component.kind]}详情
            </Typography>
            <Typography
              component="span"
              variant="h6"
              sx={{
                display: 'block',
                overflowWrap: 'anywhere',
                ...(component.kind === 'script' ? { fontFamily: 'var(--font-mono)' } : {})
              }}
            >
              {component.name}
            </Typography>
          </Box>
          <IconButton aria-label="关闭组件详情" onClick={onClose} size="small">
            <PhiIcons.action.close size={18} />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <DetailField label="说明">
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {component.description || '此组件未提供说明。'}
            </Typography>
          </DetailField>
          <DetailField label="所属插件">
            <Typography variant="body2">
              {plugin.title} · v{plugin.version}
            </Typography>
          </DetailField>
          {component.kind === 'script' && (
            <>
              <DetailField label="审批">
                <Typography variant="body2">
                  {component.approval ? PHI_PLUGIN_APPROVAL_LABELS[component.approval] : '未声明'}
                </Typography>
              </DetailField>
              <DetailField label="所属技能">
                <Typography variant="body2">{component.skillName || '未声明'}</Typography>
              </DetailField>
            </>
          )}
          <DetailField label="关联环境">
            {environments.length > 0 ? (
              <Stack spacing={0.75}>
                {environments.map((environment, index) => {
                  const { ref } = environment
                  return (
                    <Box key={`${ref}:${index}`}>
                      <Typography variant="body2">{environment?.name || ref}</Typography>
                      {environment?.name && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {ref}
                        </Typography>
                      )}
                    </Box>
                  )
                })}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                未声明关联环境
              </Typography>
            )}
          </DetailField>
          {component.warning && <Alert severity="warning">{component.warning}</Alert>}
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
