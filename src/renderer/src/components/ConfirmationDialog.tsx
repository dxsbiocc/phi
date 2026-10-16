import { Dialog, type DialogProps } from '@mui/material'

type ConfirmationDialogProps = Omit<DialogProps, 'fullWidth' | 'maxWidth'>

const confirmationDialogSx = {
  '& .MuiDialog-paper': {
    width: 480,
    maxWidth: 'calc(100% - 32px)',
    m: 2,
    borderRadius: 2
  },
  '& .MuiDialogTitle-root': {
    p: '24px 24px 12px',
    fontSize: 18,
    fontWeight: 600,
    lineHeight: 1.5,
    overflowWrap: 'anywhere'
  },
  '& .MuiDialogContent-root': {
    px: 3,
    pt: 0,
    pb: 3,
    minWidth: 0,
    overflowWrap: 'anywhere'
  },
  '& .MuiDialogTitle-root + .MuiDialogContent-root': { pt: 0 },
  '& .MuiDialogActions-root': {
    p: '0 24px 24px',
    gap: 1,
    flexWrap: 'wrap',
    '& > :not(style) ~ :not(style)': { ml: 0 },
    '& .MuiButton-root': {
      minWidth: 88,
      minHeight: 36,
      height: 36,
      px: 2,
      borderRadius: 1
    },
    '& .MuiButton-text': { color: 'text.secondary' }
  }
} as const

/** Shared proportions for short action confirmations; content may grow and scroll. */
export function ConfirmationDialog({
  children,
  sx,
  ...props
}: ConfirmationDialogProps): React.JSX.Element {
  return (
    <Dialog
      {...props}
      fullWidth
      maxWidth={false}
      data-phi-dialog-kind="confirmation"
      sx={[confirmationDialogSx, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      {children}
    </Dialog>
  )
}
