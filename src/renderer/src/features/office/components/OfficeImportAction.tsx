import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import { useEffect, useMemo, useState } from 'react'

import {
  OFFICE_IMPORT_RULES,
  type OfficeImportFormat,
  type OfficeRendererBridge
} from '../../../../../shared/officeProtocol'
import {
  createOfficeImportController,
  officeImportFormatForPath,
  type OfficeImportController,
  type OfficeImportUiState
} from '../lib/officeImportController'

export interface OfficeImportActionProps {
  bridge: OfficeRendererBridge
  sourcePath: string
  onImported: (draftPath: string) => void
  requestIdFactory?: () => string
}

let fallbackRequestSequence = 0

function defaultRequestIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `office-import-${globalThis.crypto.randomUUID()}`
  }
  fallbackRequestSequence += 1
  return `office-import-${Date.now()}-${fallbackRequestSequence}`
}

function OfficeImportRulesText(): React.JSX.Element {
  return (
    <Typography variant="caption" color="text.secondary">
      最多 {OFFICE_IMPORT_RULES.maxRows.toLocaleString('zh-CN')} 行、
      {OFFICE_IMPORT_RULES.maxColumns} 列、
      {OFFICE_IMPORT_RULES.maxCells.toLocaleString('zh-CN')}
      格、5 MiB；无歧义十进制按数值，其余（含前导零、日期、科学计数法、=
      开头）按文本，绝不创建公式。
    </Typography>
  )
}

function OfficeImportActionView({
  sourcePath,
  format,
  state,
  controller,
  setState
}: {
  sourcePath: string
  format: OfficeImportFormat
  state: OfficeImportUiState
  controller: OfficeImportController
  setState: (state: OfficeImportUiState) => void
}): React.JSX.Element {
  const preparing = state.state === 'preparing'
  const typeLabel = format === 'csv' ? 'CSV' : 'TSV'
  const activate = (): void => {
    if (!preparing) {
      void controller.submit(sourcePath, format)
      return
    }
    void controller.cancel().then(() => setState({ state: 'idle' }))
  }
  return (
    <Box
      data-phi-office-import-action="true"
      sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Button
          data-phi-office-import-button="true"
          size="small"
          variant={preparing ? 'outlined' : 'contained'}
          onClick={activate}
          startIcon={preparing ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {preparing ? `取消导入 ${typeLabel}` : '导入为 Excel 草稿'}
        </Button>
        <OfficeImportRulesText />
      </Box>
      {state.state === 'error' ? (
        <Alert data-phi-office-import-error="true" severity="error" sx={{ mt: 1 }}>
          {state.message}
        </Alert>
      ) : null}
    </Box>
  )
}

export function OfficeImportAction({
  bridge,
  sourcePath,
  onImported,
  requestIdFactory = defaultRequestIdFactory
}: OfficeImportActionProps): React.JSX.Element | null {
  const [state, setState] = useState<OfficeImportUiState>({ state: 'idle' })
  const format = officeImportFormatForPath(sourcePath)
  const controller = useMemo(
    () =>
      createOfficeImportController({
        bridge,
        requestIdFactory,
        onState: setState,
        onImported
      }),
    [bridge, onImported, requestIdFactory]
  )

  useEffect(
    () => () => {
      void controller.dispose().catch(() => undefined)
    },
    [controller]
  )

  if (
    !bridge.enabled ||
    !bridge.importFile ||
    !bridge.cancelImport ||
    !format ||
    sourcePath.startsWith('ssh://')
  ) {
    return null
  }

  return (
    <OfficeImportActionView
      sourcePath={sourcePath}
      format={format}
      state={state}
      controller={controller}
      setState={setState}
    />
  )
}
