import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'

export function RemoteNextflowInstallDialog({
  open,
  installing,
  onClose,
  onConfirm
}: {
  open: boolean
  installing: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onClose={() => !installing && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>自动安装 Nextflow</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mt: 1 }}>
          Phi 将从 Nextflow 官方安装地址获取安装脚本，在所选服务器的当前账号下执行，并把程序放入
          ~/.local/bin。不会使用 sudo，也不会安装 Java、Slurm 或容器运行时。
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={installing}>
          取消
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={installing}>
          确认安装
        </Button>
      </DialogActions>
    </Dialog>
  )
}
