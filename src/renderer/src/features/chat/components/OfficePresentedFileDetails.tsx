import { Box, Typography } from '@mui/material'

import type { PresentedOfficeFile } from '../../../../../shared/presentedFileTypes'

const KIND_LABELS = {
  xlsx: 'Excel 表格',
  docx: 'Word 文档',
  pptx: 'PowerPoint 演示文稿'
} as const

export function OfficePresentedFileDetails({
  office
}: {
  office: PresentedOfficeFile
}): React.JSX.Element {
  const warnings = office.warnings.map(officeWarningLabel)
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        component="span"
        variant="caption"
        sx={{ color: 'text.secondary', fontSize: '0.65rem' }}
      >
        {KIND_LABELS[office.kind]} · 版本 {office.revision}
      </Typography>
      {warnings.length > 0 ? (
        <Typography
          variant="caption"
          noWrap
          title={warnings.join('；')}
          sx={{ display: 'block', color: 'warning.main' }}
        >
          {warnings.join('；')}
        </Typography>
      ) : null}
    </Box>
  )
}

function officeWarningLabel(warning: string): string {
  if (warning === 'text_may_overflow') return '文本可能溢出'
  if (warning === 'preview_not_confirmed') return '此前预览刷新未确认；交付内容已重新检查'
  if (warning === 'operation_receipt_not_persisted') return '此前操作回执未持久化'
  return warning
}
