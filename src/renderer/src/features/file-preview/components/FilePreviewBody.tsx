import { filePreviewCopy } from '../lib/filePreviewUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import type { FileTreeActions } from '../lib/fileTreeActions'
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import { spreadsheetPreviewModel } from '../../../lib/spreadsheetPreview'
import { formatBytes } from '../../../lib/toolOutputPresentation'
import type { DirectoryListing } from '../../../types'
import type { FilePreviewPanelState } from '../lib/filePreviewState'
import { CodePreview } from './CodePreview'
import { HtmlReportPreview } from './HtmlReportPreview'
import { MediaPreview } from './MediaPreview'
import { molecularStructureFormatForPath } from '../lib/molecularStructureFiles'
import { MolecularStructureFilePreview } from './MolecularStructureFilePreview'
import { ProjectFileTree } from './ProjectFileTree'
import { SpreadsheetPreview } from './SpreadsheetPreview'
import { MarkdownFilePreview } from './MarkdownFilePreview'
import { isMarkdownFilePath } from '../lib/markdownFiles'
import { TextFilePreview } from './TextFilePreview'

function binaryPreviewMessage(mimeType: string): string {
  const subtype = mimeType.split('/').at(-1)?.replace(/^x-/, '') ?? 'binary'
  const label =
    mimeType === 'application/octet-stream'
      ? 'BINARY'
      : subtype
          .replace(/^vnd\./, '')
          .replace(/[^a-z0-9]+/gi, ' ')
          .trim()
          .toUpperCase()
  return filePreviewCopy.binaryFile(label)
}

type FilePreviewBodyProps = {
  state: FilePreviewPanelState
  onOpenFile: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  fileActions?: FileTreeActions
  treeRevision?: number
  onDownloadFile?: (path: string) => void
}

export function FilePreviewBody({
  state,
  onOpenFile,
  onListDirectory,
  onDownloadFile,
  fileActions,
  treeRevision = 0
}: FilePreviewBodyProps): React.JSX.Element {
  useUiLanguage()
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
          {state.pathKind === 'directory'
            ? filePreviewCopy.readingFolder
            : filePreviewCopy.readingFile}
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
        key={`${state.directory.path}:${treeRevision}`}
        rootPath={state.directory.path}
        activePath={state.directory.path}
        initialListing={treeRevision === 0 ? state.directory : undefined}
        fileActions={fileActions}
        variant="standalone"
        onOpenFile={onOpenFile}
        onListDirectory={onListDirectory}
      />
    )
  }

  if (state.file.kind === 'image' || state.file.kind === 'pdf') {
    return <MediaPreview file={state.file} />
  }

  if (state.file.kind === 'html') {
    const file = state.file
    return (
      <TextFilePreview
        key={file.path}
        file={file}
        fileActions={fileActions}
        renderPreview={(content) => <HtmlReportPreview file={{ ...file, content }} />}
      />
    )
  }

  if (state.file.kind === 'metadata') {
    return (
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Typography variant="body2">
          {filePreviewCopy.sizeLabel} {formatBytes(state.file.bytes)}
        </Typography>
        <Typography variant="body2">
          {filePreviewCopy.typeLabel} {state.file.mimeType}
        </Typography>
        <Alert severity="info" variant="outlined">
          {state.file.reason === 'large_file'
            ? filePreviewCopy.metadataOnly
            : binaryPreviewMessage(state.file.mimeType)}
        </Alert>
        <Button
          size="small"
          variant="outlined"
          disabled={!onDownloadFile}
          onClick={() => onDownloadFile?.(state.file.path)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {filePreviewCopy.downloadFile}
        </Button>
      </Box>
    )
  }

  const file = state.file
  const molecularStructureFormat =
    state.file.kind === 'text' ? molecularStructureFormatForPath(state.file.path) : null

  return (
    <>
      {state.file.truncated ? (
        <Alert severity="info" variant="outlined" sx={{ m: 1.5, mb: 0 }}>
          {filePreviewCopy.previewPortion(
            formatBytes(state.file.previewBytes),
            formatBytes(state.file.bytes)
          )}
        </Alert>
      ) : null}
      {state.file.kind === 'text' && isMarkdownFilePath(state.file.path) ? (
        <MarkdownFilePreview
          key={state.file.path}
          file={state.file}
          fileActions={fileActions}
          onOpenFile={onOpenFile}
        />
      ) : (
        <TextFilePreview
          key={file.path}
          file={file}
          fileActions={fileActions}
          renderPreview={(content) => {
            const currentFile = { ...file, content }
            const spreadsheetModel = spreadsheetPreviewModel(currentFile)
            return spreadsheetModel ? (
              <SpreadsheetPreview model={spreadsheetModel} />
            ) : molecularStructureFormat ? (
              <>
                <MolecularStructureFilePreview
                  file={currentFile}
                  format={molecularStructureFormat}
                />
                <CodePreview file={currentFile} />
              </>
            ) : (
              <CodePreview file={currentFile} />
            )
          }}
        />
      )}
    </>
  )
}
