import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'

import type {
  OfficeExportFormat,
  OfficePreviewDocument
} from '../../../../../shared/officeProtocol'
import type { OfficeExportUiState } from '../lib/officeExportController'
import { officeDocumentKind } from '../lib/officeDocumentUi'

export interface OfficeExportMenuProps {
  readonly available: boolean
  readonly document: OfficePreviewDocument
  readonly activeSheet?: string
  readonly state: OfficeExportUiState
  readonly onExport: (format: OfficeExportFormat) => void
  readonly onCancel: () => void
  readonly onRevealOutput: () => void
}

function exportBlockReason(
  document: OfficePreviewDocument,
  activeSheet: string | undefined
): string | undefined {
  if (document.previewState === 'preview_failed') return '预览渲染失败，无法确认当前工作表'
  if (document.readOnly) return '当前文档为只读，不能导出'
  if (document.freezeState === 'unknown') return '写入结果待核对，核对后才能导出'
  if (document.needsSave) return '草稿尚未成功保存，保存后才能导出'
  if (document.saveState === 'editing') return '草稿正在修改，请等待修改并保存完成'
  if (document.saveState === 'unsaved') return '草稿尚未保存，保存后才能导出'
  if (document.saveState === 'saving') return '草稿正在保存，请等待保存完成'
  if (document.saveState === 'failed') return '草稿保存失败，请重试保存后再导出'
  if (!activeSheet?.trim()) return '请先在表格预览中选择一个工作表'
  return undefined
}

function OfficeExportFeedback({
  state,
  onCancel,
  onRevealOutput
}: Pick<OfficeExportMenuProps, 'state' | 'onCancel' | 'onRevealOutput'>): React.JSX.Element | null {
  if (state.phase === 'pending') {
    return (
      <Box sx={{ mt: 0.5 }}>
        {state.cancelMessage ? (
          <Alert severity="warning" icon={false} sx={{ py: 0 }}>
            {state.cancelMessage}
          </Alert>
        ) : (
          <Button
            size="small"
            variant="outlined"
            startIcon={<CircularProgress size={12} color="inherit" />}
            onClick={onCancel}
          >
            取消导出 {state.format.toUpperCase()}
          </Button>
        )}
      </Box>
    )
  }
  if (state.phase === 'success') {
    const output = state.output
    return (
      <Alert
        data-phi-office-export-success="true"
        severity="success"
        icon={false}
        action={
          <Button color="inherit" size="small" onClick={onRevealOutput}>
            在文件夹中显示
          </Button>
        }
        sx={{ mt: 0.5, py: 0 }}
      >
        已导出 {output.format.toUpperCase()}：{output.sheet}，{output.rows} × {output.columns}，
        revision {output.revision}
      </Alert>
    )
  }
  if (state.phase === 'error') {
    return (
      <Alert
        data-phi-office-export-error={state.code}
        severity="error"
        icon={false}
        sx={{ mt: 0.5, py: 0 }}
      >
        {state.message}
      </Alert>
    )
  }
  return null
}

export function OfficeExportMenu(props: OfficeExportMenuProps): React.JSX.Element | null {
  if (!props.available || officeDocumentKind(props.document) !== 'xlsx') return null
  const blockedReason = exportBlockReason(props.document, props.activeSheet)
  const disabled = blockedReason !== undefined || props.state.phase === 'pending'
  return (
    <Box
      data-phi-office-export-menu="true"
      sx={{ px: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Button
          size="small"
          data-phi-office-export-csv="true"
          disabled={disabled}
          onClick={() => props.onExport('csv')}
        >
          导出为 CSV
        </Button>
        <Button
          size="small"
          data-phi-office-export-tsv="true"
          disabled={disabled}
          onClick={() => props.onExport('tsv')}
        >
          导出为 TSV
        </Button>
        <Typography variant="caption" color="text.secondary">
          当前工作表：{props.activeSheet ?? '未选择'}
        </Typography>
      </Box>
      <Typography sx={{ display: 'block' }} variant="caption" color="text.secondary">
        仅导出当前工作表的计算值；不保留格式、公式或图表。
      </Typography>
      <Typography sx={{ display: 'block' }} variant="caption" color="warning.main">
        以 =、+、-、@ 开头的文本在 Excel 中打开时可能被当作公式；Phi 会忠实导出，不会改写内容。
      </Typography>
      {blockedReason ? (
        <Typography data-phi-office-export-blocked="true" variant="caption" color="error.main">
          {blockedReason}
        </Typography>
      ) : null}
      <OfficeExportFeedback
        state={props.state}
        onCancel={props.onCancel}
        onRevealOutput={props.onRevealOutput}
      />
    </Box>
  )
}
