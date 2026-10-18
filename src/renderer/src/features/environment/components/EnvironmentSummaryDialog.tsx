import { environmentUi } from '../lib/environmentUi'
import { useUiLanguage } from '../../../lib/i18n'
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
  useUiLanguage()
  const { dependencies, tools } = environmentHostResources(snapshot)
  const capabilityGroups = [
    {
      title: environmentUi.jupyterEnvironment,
      items: tools.filter((tool) => tool.id === 'jupyter')
    },
    {
      title: environmentUi.nextflowEnvironment,
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
      <DialogTitle>{environmentUi.workbenchEnvironmentDetection}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {environmentUi.phiAutomaticallyDetectsLocalJupyterNextflowAndContainer}
        </Typography>

        <Alert
          severity={readyCapabilities.length === capabilities.length ? 'success' : 'warning'}
          sx={{ mb: 1.5 }}
        >
          {environmentUi.capabilitySummary(readyCapabilities.length, capabilities.length)}
        </Alert>
        {capabilities.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {environmentUi.noDetectionResultsYet}
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
                      label={`${item.label} · ${item.status === 'ready' ? environmentUi.available : environmentUi.notReady2}`}
                    />
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onOpenSettings}>{environmentUi.openEnvironmentSettings}</Button>
        <Button variant="contained" onClick={onClose}>
          {environmentUi.gotIt}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
