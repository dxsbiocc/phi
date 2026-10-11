import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  Typography
} from '@mui/material'

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
  const count = summary?.dependencies.length ?? 0
  return (
    <Dialog open={summary !== null} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>安装 {title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          它依赖另外 {count} 个 wrapper 软件包，会一起安装，共{' '}
          {formatPackageSize(summary?.totalSize ?? 0)}。
        </Typography>
        <List
          dense
          disablePadding
          aria-label="将一起安装的软件包"
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
        <Button onClick={onCancel}>取消</Button>
        <Button variant="contained" onClick={onConfirm}>
          安装全部
        </Button>
      </DialogActions>
    </Dialog>
  )
}
