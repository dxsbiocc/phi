import { Alert, Box, Button } from '@mui/material'
import { useMemo, useState } from 'react'

import { HTML_REPORT_FRAME_NAME, htmlReportSrcDoc } from '../../../../../shared/htmlReportPreview'
import type { FilePreview } from '../../../types'
import { CodePreview } from './CodePreview'

const SOURCE_PREVIEW_CHARS = 320000

export function HtmlReportPreview({
  file
}: {
  file: Extract<FilePreview, { kind: 'html' }>
}): React.JSX.Element {
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const srcDoc = useMemo(() => htmlReportSrcDoc(file.content), [file.content])
  const sourceFile = useMemo<Extract<FilePreview, { kind: 'text' }>>(
    () => ({
      ...file,
      kind: 'text',
      mimeType: 'text/plain',
      content: file.content.slice(0, SOURCE_PREVIEW_CHARS),
      previewBytes: Math.min(file.previewBytes, SOURCE_PREVIEW_CHARS),
      truncated: file.content.length > SOURCE_PREVIEW_CHARS
    }),
    [file]
  )

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{ display: 'flex', gap: 0.75, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        <Button
          size="small"
          variant={mode === 'rendered' ? 'contained' : 'outlined'}
          aria-pressed={mode === 'rendered'}
          onClick={() => setMode('rendered')}
        >
          报告预览
        </Button>
        <Button
          size="small"
          variant={mode === 'source' ? 'contained' : 'outlined'}
          aria-pressed={mode === 'source'}
          onClick={() => setMode('source')}
        >
          查看源码
        </Button>
      </Box>
      {mode === 'rendered' ? (
        <>
          <Alert severity="info" sx={{ mx: 1.5, my: 1 }}>
            此处只显示报告的静态内容。交互图表请用默认应用打开。
          </Alert>
          <Box
            component="iframe"
            name={HTML_REPORT_FRAME_NAME}
            title={`HTML 报告预览：${file.name}`}
            data-phi-html-report-preview="true"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            sx={{ flex: 1, minHeight: 0, width: '100%', border: 0, bgcolor: 'background.default' }}
          />
        </>
      ) : (
        <CodePreview file={sourceFile} />
      )}
    </Box>
  )
}
