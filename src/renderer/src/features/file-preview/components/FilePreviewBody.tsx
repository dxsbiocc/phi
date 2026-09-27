import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import { spreadsheetPreviewModel } from '../../../lib/spreadsheetPreview'
import { formatBytes } from '../../../lib/toolOutputPresentation'
import type { DirectoryListing } from '../../../types'
import type { FilePreviewPanelState } from '../lib/filePreviewState'
import { CodePreview } from './CodePreview'
import { MediaPreview } from './MediaPreview'
import { molecularStructureFormatForPath } from '../lib/molecularStructureFiles'
import { MolecularStructureFilePreview } from './MolecularStructureFilePreview'
import { ProjectFileTree } from './ProjectFileTree'
import { SpreadsheetPreview } from './SpreadsheetPreview'

type FilePreviewBodyProps = {
  state: FilePreviewPanelState
  onOpenFile: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  onDownloadFile?: (path: string) => void
}

export function FilePreviewBody({
  state,
  onOpenFile,
  onListDirectory,
  onDownloadFile
}: FilePreviewBodyProps): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          color: 'text.secondary'
        }}
      >
        <CircularProgress size={18} />
        <Typography variant="body2">
          {state.pathKind === 'directory' ? '正在读取目录' : '正在读取文件'}
        </Typography>
      </Box>
    )
  }

  if (state.status === 'error') {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" variant="outlined">
          {state.message}
        </Alert>
      </Box>
    )
  }

  if (state.status === 'directory') {
    return (
      <ProjectFileTree
        key={state.directory.path}
        rootPath={state.directory.path}
        activePath={state.directory.path}
        initialListing={state.directory}
        variant="standalone"
        onOpenFile={onOpenFile}
        onListDirectory={onListDirectory}
      />
    )
  }

  if (state.file.kind === 'image' || state.file.kind === 'pdf') {
    return <MediaPreview file={state.file} />
  }

  if (state.file.kind === 'metadata') {
    return (
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Typography variant="body2">大小：{formatBytes(state.file.bytes)}</Typography>
        <Typography variant="body2">类型：{state.file.mimeType}</Typography>
        <Alert severity="info" variant="outlined">
          {state.file.reason === 'large_file'
            ? '文件较大，预览仅显示元数据；完整文件仍保留在服务器上。'
            : '此二进制文件暂不能直接预览，原文件保留在服务器上。'}
        </Alert>
        <Button
          size="small"
          variant="outlined"
          disabled={!onDownloadFile}
          onClick={() => onDownloadFile?.(state.file.path)}
          sx={{ alignSelf: 'flex-start' }}
        >
          下载文件
        </Button>
      </Box>
    )
  }

  const spreadsheetModel = spreadsheetPreviewModel(state.file)
  const molecularStructureFormat =
    state.file.kind === 'text' ? molecularStructureFormatForPath(state.file.path) : null

  return (
    <>
      {state.file.truncated ? (
        <Alert severity="info" variant="outlined" sx={{ m: 1.5, mb: 0 }}>
          文件较大，已预览前 {formatBytes(state.file.previewBytes)} /{' '}
          {formatBytes(state.file.bytes)}
        </Alert>
      ) : null}
      {spreadsheetModel ? (
        <SpreadsheetPreview model={spreadsheetModel} />
      ) : molecularStructureFormat && state.file.kind === 'text' ? (
        <>
          <MolecularStructureFilePreview file={state.file} format={molecularStructureFormat} />
          <CodePreview file={state.file} />
        </>
      ) : (
        <CodePreview file={state.file} />
      )}
    </>
  )
}
