import { chatCopy } from '../lib/chatCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Button, IconButton, Paper, Tooltip, Typography } from '@mui/material'
import { useEffect, useId, useState } from 'react'
import { GoDiff, GoInfo } from 'react-icons/go'

import type { WorkspaceChangeSummaryItem } from '../../../types'
import type { WorkspaceDiffReference } from '../../../../../shared/workspaceChangeTypes'
import { fileIconForPath } from '../../../icons'
import { getRendererApi } from '../../../lib/rendererApi'
import { WorkspaceDiffDialog } from './WorkspaceDiffDialog'

const STATUS_LABELS = {
  get added() {
    return chatCopy.added
  },
  get modified() {
    return chatCopy.modified
  },
  get deleted() {
    return chatCopy.delete
  }
} as const
const VISIBLE_FILES = 4

export function WorkspaceChangesCard({
  item,
  onOpenFile
}: {
  item: WorkspaceChangeSummaryItem
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  useUiLanguage()
  const [selection, setSelection] = useState<{ path: string; ref: WorkspaceDiffReference } | null>(
    null
  )
  const [loaded, setLoaded] = useState<{ id: string; patch?: string; error?: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const hiddenCount = Math.max(0, item.files.length - VISIBLE_FILES)
  const visibleFiles = expanded ? item.files : item.files.slice(0, VISIBLE_FILES)

  useEffect(() => {
    if (!selection) return
    let active = true
    void getRendererApi()
      .readWorkspaceDiff(selection.ref)
      .then((patch) => {
        if (active) setLoaded({ id: selection.ref.id, patch })
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded({
            id: selection.ref.id,
            error: error instanceof Error ? error.message : chatCopy.unableToReadDiffFile
          })
      })
    return () => {
      active = false
    }
  }, [selection])

  return (
    <>
      <Paper
        variant="outlined"
        aria-label={chatCopy.fileChangesDuringThisRun}
        sx={{
          mx: 1,
          my: 0.75,
          p: 1.25,
          borderRadius: 2.5,
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
          '@container phi-chat (max-width: 560px)': {
            mx: 0,
            my: 0.5,
            p: 0.75,
            borderRadius: 1.5
          }
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 0.5,
            minWidth: 0,
            '@container phi-chat (max-width: 560px)': { gap: 0.5, px: 0.25 }
          }}
        >
          <Typography
            variant="subtitle2"
            noWrap
            sx={{
              fontWeight: 700,
              color: 'text.primary',
              minWidth: 0,
              '@container phi-chat (max-width: 560px)': { fontSize: '0.78rem' }
            }}
          >
            {item.truncated
              ? chatCopy.valueFileChangesFound(item.totalChanged)
              : chatCopy.valueFileChanges(item.totalChanged)}
          </Typography>
          <Tooltip title={chatCopy.showsNetChangesToGitVisibleFilesOnlyIgnoredOutput}>
            <Box
              component="span"
              tabIndex={0}
              aria-label={chatCopy.aboutFileChanges}
              sx={{ color: 'text.secondary', display: 'inline-flex', cursor: 'help' }}
            >
              <GoInfo size={15} />
            </Box>
          </Tooltip>
          {item.truncated && (
            <Typography variant="caption" sx={{ ml: 'auto', color: 'warning.main' }}>
              {chatCopy.listTruncated}
            </Typography>
          )}
        </Box>
        <Box
          id={listId}
          sx={{
            mt: 0.75,
            maxHeight: expanded ? 300 : 'none',
            overflowY: expanded ? 'auto' : 'visible',
            minWidth: 0,
            '@container phi-chat (max-width: 560px)': {
              mt: 0.4,
              maxHeight: expanded ? 220 : 'none'
            }
          }}
        >
          {visibleFiles.map((file) => {
            const icon = fileIconForPath(file.path)
            const FileIcon = icon.Icon
            return (
              <Box
                key={file.path}
                data-phi-workspace-change-row="true"
                sx={{
                  minHeight: 36,
                  px: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  borderRadius: 1,
                  '&:hover': { bgcolor: 'action.hover' },
                  '@container phi-chat (max-width: 560px)': {
                    minHeight: 28,
                    px: 0.25,
                    gap: 0.5
                  }
                }}
              >
                <FileIcon
                  sx={{
                    color: icon.color,
                    fontSize: 19,
                    flexShrink: 0,
                    '@container phi-chat (max-width: 560px)': { fontSize: 15 }
                  }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    color: 'text.secondary',
                    flexShrink: 0,
                    '@container phi-chat (max-width: 560px)': { fontSize: '0.68rem' }
                  }}
                >
                  {STATUS_LABELS[file.status]}
                </Typography>
                {file.status !== 'deleted' && onOpenFile ? (
                  <Button
                    size="small"
                    onClick={() => onOpenFile(file.path)}
                    aria-label={chatCopy.previewChangedFileValue(file.displayPath)}
                    title={file.path}
                    sx={{
                      minWidth: 0,
                      flex: '1 1 0',
                      p: 0,
                      overflow: 'hidden',
                      textTransform: 'none',
                      justifyContent: 'flex-start',
                      color: 'text.primary',
                      '&:hover': { color: 'primary.main', bgcolor: 'transparent' }
                    }}
                  >
                    <Typography
                      noWrap
                      variant="body2"
                      sx={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontFamily: 'var(--font-mono)',
                        '@container phi-chat (max-width: 560px)': { fontSize: '0.72rem' }
                      }}
                    >
                      {file.displayPath}
                    </Typography>
                  </Button>
                ) : (
                  <Typography
                    variant="body2"
                    noWrap
                    title={file.path}
                    sx={{
                      minWidth: 0,
                      flex: 1,
                      color: 'text.secondary',
                      fontFamily: 'var(--font-mono)',
                      '@container phi-chat (max-width: 560px)': { fontSize: '0.72rem' }
                    }}
                  >
                    {file.displayPath}
                  </Typography>
                )}
                <Box
                  title={
                    file.added === null || file.deleted === null
                      ? chatCopy.lineCountsUnavailable
                      : undefined
                  }
                  sx={{
                    flexShrink: 0,
                    display: 'flex',
                    gap: 0.75,
                    fontSize: '0.8rem',
                    '@container phi-chat (max-width: 560px)': { gap: 0.4, fontSize: '0.7rem' }
                  }}
                >
                  {file.added === null || file.deleted === null ? (
                    <Box component="span" sx={{ color: 'text.secondary' }}>
                      —
                    </Box>
                  ) : (
                    <>
                      <Box component="span" sx={{ color: 'success.main' }}>
                        +{file.added}
                      </Box>
                      {file.deleted > 0 && (
                        <Box component="span" sx={{ color: 'error.main' }}>
                          −{file.deleted}
                        </Box>
                      )}
                    </>
                  )}
                </Box>
                {file.diff && (
                  <Tooltip title={chatCopy.viewDiff}>
                    <IconButton
                      size="small"
                      aria-label={chatCopy.viewThisRunSDiffForValue(file.displayPath)}
                      onClick={() => {
                        if (file.diff) setSelection({ path: file.displayPath, ref: file.diff })
                      }}
                      sx={{
                        flexShrink: 0,
                        width: 28,
                        height: 28,
                        color: 'text.secondary',
                        '@container phi-chat (max-width: 560px)': {
                          width: 24,
                          height: 24,
                          '& svg': { width: 14, height: 14 }
                        }
                      }}
                    >
                      <GoDiff size={16} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            )
          })}
        </Box>
        {hiddenCount > 0 && (
          <Button
            size="small"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
            sx={{
              mt: 0.5,
              px: 0.5,
              color: 'text.secondary',
              textTransform: 'none',
              '@container phi-chat (max-width: 560px)': { mt: 0.25, px: 0.25, fontSize: '0.72rem' }
            }}
          >
            {expanded ? chatCopy.collapse : chatCopy.showValueMore(hiddenCount)}
          </Button>
        )}
        {item.truncated && expanded && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
            {chatCopy.theFileListWasTruncated}
          </Typography>
        )}
      </Paper>
      <WorkspaceDiffDialog
        path={selection?.path ?? null}
        patch={loaded?.id === selection?.ref.id ? (loaded?.patch ?? null) : null}
        error={loaded?.id === selection?.ref.id ? (loaded?.error ?? null) : null}
        onClose={() => setSelection(null)}
      />
    </>
  )
}
