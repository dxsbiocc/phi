import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'

import type { OfficePreviewDocument } from '../../../../../shared/officeProtocol'
import type { OfficeSaveUiState } from '../lib/officeSaveController'
import type { OfficeSaveAsUiState } from '../lib/officeSaveAsController'

export interface OfficeSaveToolbarProps {
  document: OfficePreviewDocument
  state: OfficeSaveUiState
  onSave: () => void
  saveAsState?: OfficeSaveAsUiState
  onSaveAs?: () => void
  onRevealOutput?: () => void
}

export function OfficeSaveToolbar({
  document,
  state,
  onSave,
  saveAsState = { phase: 'idle' },
  onSaveAs,
  onRevealOutput
}: OfficeSaveToolbarProps): React.JSX.Element {
  const saveState = state.phase === 'pending' ? 'saving' : document.saveState
  const blocked = document.readOnly || document.freezeState === 'unknown'
  const disabled = blocked || saveState === 'editing' || saveState === 'saving'
  return (
    <Box data-phi-office-save-state={saveState} sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ px: 1.5, py: 0.75, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ flex: 1 }}>
          {saveStatusLabel(document, saveState)}
        </Typography>
        <Button
          size="small"
          data-phi-office-save-draft="true"
          variant={saveState === 'failed' || saveState === 'unsaved' ? 'contained' : 'text'}
          disabled={disabled}
          startIcon={saveState === 'saving' ? <CircularProgress size={12} /> : undefined}
          onClick={onSave}
        >
          {saveState === 'failed' ? '重试' : saveState === 'saving' ? '保存中…' : '保存草稿'}
        </Button>
        <Button
          size="small"
          data-phi-office-save-as="true"
          disabled={
            !onSaveAs || blocked || saveState !== 'saved' || saveAsState.phase === 'pending'
          }
          onClick={onSaveAs}
        >
          {saveAsState.phase === 'pending' ? '另存中…' : '另存为…'}
        </Button>
      </Box>
      {state.phase === 'error' && (
        <Alert severity="error" icon={false} sx={{ borderRadius: 0, py: 0 }}>
          {state.message}
        </Alert>
      )}
      {saveAsState.phase === 'success' && (
        <Alert
          data-phi-office-save-as-success="true"
          severity="success"
          icon={false}
          action={
            onRevealOutput ? (
              <Button color="inherit" size="small" onClick={onRevealOutput}>
                在文件夹中显示
              </Button>
            ) : undefined
          }
          sx={{ borderRadius: 0, py: 0 }}
        >
          已创建 {saveAsState.output.fileName}（{saveAsState.output.outputPath}，
          {formatBytes(saveAsState.output.size)}，revision {saveAsState.output.revision}）
        </Alert>
      )}
      {saveAsState.phase === 'error' && (
        <Alert
          data-phi-office-save-as-error="true"
          severity="error"
          icon={false}
          sx={{ borderRadius: 0, py: 0 }}
        >
          {saveAsState.message}
        </Alert>
      )}
    </Box>
  )
}

function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`
}

function saveStatusLabel(
  document: OfficePreviewDocument,
  saveState: OfficePreviewDocument['saveState']
): string {
  if (document.freezeState === 'unknown') return '请先核对写入结果，再保存草稿'
  if (document.readOnly) return '当前文档为只读，不能保存草稿'
  if (saveState === 'editing') return '正在修改草稿…'
  if (saveState === 'unsaved') return '有未保存的修改'
  if (saveState === 'saving') return '保存中…'
  if (saveState === 'failed') return '保存失败，内容仍保留'
  return document.sourceHash ? '草稿已保存（原文件未改动）' : '草稿已保存'
}
