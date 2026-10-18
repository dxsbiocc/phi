import { filePreviewCopy } from '../lib/filePreviewUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useDeferredValue, useMemo } from 'react'
import { Box, Typography } from '@mui/material'
import MarkdownContent from '../../../components/MarkdownContent'
import type { FilePreview } from '../../../types'
import type { FileTreeActions } from '../lib/fileTreeActions'
import { markdownDirectory } from '../lib/markdownFiles'
import {
  RemoteProjectFileContext,
  type RemoteProjectFileContextValue
} from '../../../lib/remoteProjectFileContext'
import { remotePathInsideRoot } from '../../../../../shared/remoteWorkspacePath'
import { TextFilePreview } from './TextFilePreview'

function MarkdownRendered({
  content,
  path,
  remoteContext,
  fileActions,
  onOpenFile,
  inline = false
}: {
  content: string
  path: string
  remoteContext: RemoteProjectFileContextValue | null
  fileActions?: FileTreeActions
  onOpenFile: (path: string) => void
  inline?: boolean
}): React.JSX.Element {
  useUiLanguage()
  const renderedContent = useDeferredValue(content)
  return (
    <Box
      data-phi-markdown-rendered="true"
      sx={
        inline
          ? { minWidth: 0 }
          : { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', px: 3, py: 2 }
      }
    >
      {content ? (
        <RemoteProjectFileContext.Provider value={remoteContext}>
          <MarkdownContent
            text={renderedContent}
            cwd={markdownDirectory(path)}
            enableMath
            onOpenLocalPath={(target, kind) => {
              if (kind === 'directory' && fileActions?.onOpenDirectory)
                fileActions.onOpenDirectory(target)
              else onOpenFile(target)
            }}
          />
        </RemoteProjectFileContext.Provider>
      ) : (
        <Typography color="text.secondary">{filePreviewCopy.blankMarkdown}</Typography>
      )}
    </Box>
  )
}

export function MarkdownFilePreview({
  file,
  fileActions,
  onOpenFile
}: {
  file: Extract<FilePreview, { kind: 'text' }>
  fileActions?: FileTreeActions
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  useUiLanguage()
  const remoteScope = fileActions?.markdownRemoteContext
  const remoteContext = useMemo<RemoteProjectFileContextValue | null>(() => {
    if (!file.path.startsWith('ssh://')) return null
    try {
      const uri = new URL(file.path)
      if (
        remoteScope &&
        uri.host === remoteScope.hostAlias &&
        remotePathInsideRoot(decodeURIComponent(uri.pathname), remoteScope.canonicalRoot)
      )
        return remoteScope
      // Unbound remote artifacts remain renderable without resolving paths on this computer.
      return {
        sessionId: '',
        projectId: '',
        hostAlias: uri.host,
        remoteRoot: '/',
        canonicalRoot: '/',
        openPath: () => undefined
      }
    } catch {
      return {
        sessionId: '',
        projectId: '',
        hostAlias: '',
        remoteRoot: '/',
        canonicalRoot: '/',
        openPath: () => undefined
      }
    }
  }, [file.path, remoteScope])
  return (
    <TextFilePreview
      file={file}
      fileActions={fileActions}
      markdown
      renderMarkdownBlock={(content) => (
        <MarkdownRendered
          content={content}
          path={file.path}
          remoteContext={remoteContext}
          fileActions={fileActions}
          onOpenFile={onOpenFile}
          inline
        />
      )}
      renderPreview={(content) => (
        <MarkdownRendered
          content={content}
          path={file.path}
          remoteContext={remoteContext}
          fileActions={fileActions}
          onOpenFile={onOpenFile}
        />
      )}
    />
  )
}
