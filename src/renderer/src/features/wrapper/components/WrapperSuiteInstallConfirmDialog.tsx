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
import type { WrapperInstallItem } from '../lib/wrapperInstallPlan'
import type { WrapperSuiteInstallSummary } from '../lib/wrapperSuiteAction'

function PackageLine({ entry }: { entry: WrapperInstallItem }): React.JSX.Element {
  return (
    <ListItem disableGutters sx={{ gap: 1 }}>
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
  )
}

/** Lists every tool (and each extra dependency once) before a whole tool group is installed. */
export function WrapperSuiteInstallConfirmDialog({
  suite,
  summary,
  onConfirm,
  onCancel
}: {
  suite: string | null
  summary: WrapperSuiteInstallSummary | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  useUiLanguage()
  const dependencies = summary?.dependencies ?? []
  return (
    <ConfirmationDialog open={summary !== null} onClose={onCancel}>
      <DialogTitle>{wrapperCopy.installSuiteTitle(suite ?? '')}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {wrapperCopy.installSuiteSummary(
            summary?.tools.length ?? 0,
            dependencies.length,
            formatPackageSize(summary?.totalSize ?? 0)
          )}
        </Typography>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          {wrapperCopy.tools}
        </Typography>
        <List
          dense
          disablePadding
          aria-label={wrapperCopy.wrapperToolList}
          sx={{ maxHeight: 200, overflow: 'auto' }}
        >
          {summary?.tools.map((entry) => (
            <PackageLine key={entry.id} entry={entry} />
          ))}
        </List>
        {dependencies.length > 0 ? (
          <>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mt: 1.5, mb: 0.5 }}>
              {wrapperCopy.packagesToInstall}
            </Typography>
            <List
              dense
              disablePadding
              aria-label={wrapperCopy.packagesToInstall}
              sx={{ maxHeight: 200, overflow: 'auto' }}
            >
              {dependencies.map((entry) => (
                <PackageLine key={entry.id} entry={entry} />
              ))}
            </List>
          </>
        ) : null}
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
