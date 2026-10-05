import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField
} from '@mui/material'

import type { OfficeDocumentKind, OfficeRendererBridge } from '../../../../../shared/officeProtocol'
import {
  createOfficeCreateController,
  type OfficeCreateUiState
} from '../lib/officeCreateController'
import { officeDocumentCopy } from '../lib/officeDocumentUi'

export interface OfficeCreateButtonProps {
  bridge: OfficeRendererBridge
  disabled: boolean
  onCreated: (draftPath: string) => void
  requestIdFactory?: () => string
}

let fallbackRequestSequence = 0

function defaultRequestIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `office-create-${globalThis.crypto.randomUUID()}`
  }
  fallbackRequestSequence += 1
  return `office-create-${Date.now()}-${fallbackRequestSequence}`
}

export function OfficeCreateButton({
  bridge,
  disabled,
  onCreated,
  requestIdFactory = defaultRequestIdFactory
}: OfficeCreateButtonProps): React.JSX.Element | null {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [kind, setKind] = useState<OfficeDocumentKind>('xlsx')
  const [name, setName] = useState('')
  const [state, setState] = useState<OfficeCreateUiState>({ state: 'idle' })
  const handleCreated = useCallback(
    (draftPath: string): void => {
      setDialogOpen(false)
      setName('')
      setState({ state: 'idle' })
      onCreated(draftPath)
    },
    [onCreated]
  )
  const controller = useMemo(
    () =>
      createOfficeCreateController({
        bridge,
        requestIdFactory,
        onState: setState,
        onCreated: handleCreated
      }),
    [bridge, handleCreated, requestIdFactory]
  )

  useEffect(
    () => () => {
      void controller.dispose().catch(() => undefined)
    },
    [controller]
  )

  if (!bridge.enabled) return null

  const preparing = state.state === 'preparing'
  const closeDialog = (): void => {
    if (preparing) void controller.cancel().catch(() => undefined)
    setDialogOpen(false)
    setName('')
    setState({ state: 'idle' })
  }
  const submit = (): void => {
    const trimmedName = name.trim()
    void controller.submit(trimmedName || undefined, kind)
  }
  const copy = officeDocumentCopy(kind)
  const openDialog = (nextKind: OfficeDocumentKind): void => {
    setKind(nextKind)
    setState({ state: 'idle' })
    setDialogOpen(true)
  }

  return (
    <>
      <Box sx={{ display: 'flex', gap: 0.75, minWidth: 0, flexShrink: 1 }}>
        {(['xlsx', 'docx', 'pptx'] as const).map((entryKind) => (
          <Button
            key={entryKind}
            aria-label={`新建空白 ${officeDocumentCopy(entryKind).productName}`}
            data-phi-office-create-button="true"
            data-phi-office-create-kind={entryKind}
            disabled={disabled}
            size="small"
            variant="outlined"
            onClick={() => openDialog(entryKind)}
            sx={{
              minWidth: 0,
              flexShrink: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              WebkitAppRegion: 'no-drag'
            }}
          >
            <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>
              新建空白{' '}
            </Box>
            {officeDocumentCopy(entryKind).productName}
          </Button>
        ))}
      </Box>
      <Dialog
        data-phi-office-create-dialog="true"
        open={dialogOpen}
        onClose={closeDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>新建空白 {copy.productName}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            disabled={preparing}
            label="名称（可选）"
            placeholder={copy.createPlaceholder}
            value={name}
            onChange={(event) => setName(event.target.value)}
            slotProps={{
              htmlInput: {
                'data-phi-office-create-name': 'true',
                maxLength: 64
              }
            }}
            sx={{ mt: 1 }}
          />
          {preparing ? (
            <Alert severity="info" icon={<CircularProgress size={16} />} sx={{ mt: 2 }}>
              正在创建空白 {copy.productName}…
            </Alert>
          ) : null}
          {state.state === 'error' ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {state.message}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button data-phi-office-create-cancel="true" onClick={closeDialog}>
            取消
          </Button>
          <Button
            data-phi-office-create-submit="true"
            disabled={preparing}
            variant="contained"
            onClick={submit}
          >
            创建
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
