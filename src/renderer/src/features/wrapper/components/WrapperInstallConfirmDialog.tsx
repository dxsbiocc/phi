import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { wrapperCopy } from '../lib/wrapperCopy'
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  Typography
} from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { formatPackageSize } from '../../../components/catalog/packageSize'
import type { WrapperInstallSummary } from '../lib/wrapperInstallPlan'

/** Lists everything one install will add before any of it is downloaded. */
export function WrapperInstallConfirmDialog({
  title,
  summary,
  onConfirm,
  onCancel
}: {
  title: string
  summary: WrapperInstallSummary | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  useUiLanguage()
  const count = summary?.dependencies.length ?? 0
  return (
    <ConfirmationDialog open={summary !== null} onClose={onCancel}>
      <DialogTitle>{wrapperCopy.installTitle(title)}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {wrapperCopy.installDependencies(count, formatPackageSize(summary?.totalSize ?? 0))}
        </Typography>
        <List
          dense
          disablePadding
          aria-label={wrapperCopy.packagesToInstall}
          sx={{ maxHeight: 280, overflow: 'auto' }}
        >
          {summary?.dependencies.map((entry) => (
            <ListItem key={entry.id} disableGutters sx={{ gap: 1 }}>
              <Typography
                variant="body2"
                noWrap
                title={entry.id}
                sx={{ flex: 1, fontFamily: 'var(--font-mono)' }}
              >
                {entry.name}
              </Typography>
              <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.75rem' }}>
                {entry.kind} · {formatPackageSize(entry.size)}
              </Box>
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{resourceUi.cancel}</Button>
        <Button variant="contained" onClick={onConfirm}>
          {wrapperCopy.installAll}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
