import { Box, ButtonBase, Typography } from '@mui/material'
import { GoChevronRight } from 'react-icons/go'

import { fileIconForPath } from '../../../icons'
import type { PresentedFilesItem } from '../../../types'
import { formatBytes } from '../../../lib/toolOutputPresentation'
import { OfficePresentedFileDetails } from './OfficePresentedFileDetails'
import { usePresentedFileOpen } from '../hooks/usePresentedFileOpen'

const ARTIFACT_KIND_LABELS: Record<string, string> = {
  figure: '图',
  table: '表',
  structure: '结构',
  molecule: '分子',
  network: '网络',
  report: '报告'
}

function artifactKindLabel(kind: string): string {
  return ARTIFACT_KIND_LABELS[kind] ?? kind
}

export function PresentedFilesCard({
  item,
  onOpenFile
}: {
  item: PresentedFilesItem
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const { openFile, errorFor } = usePresentedFileOpen(onOpenFile)
  return (
    <Box
      role="region"
      aria-label="交付文件"
      sx={{
        mx: 1,
        my: 1,
        minWidth: 0,
        maxWidth: '100%',
        color: 'text.primary',
        '@container phi-chat (max-width: 560px)': { mx: 0, my: 0.5 }
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 0.75,
          px: 0.5,
          mb: 1,
          '@container phi-chat (max-width: 560px)': { mb: 0.5, px: 0.25 }
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 700,
            '@container phi-chat (max-width: 560px)': { fontSize: '0.78rem' }
          }}
        >
          交付文件
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {item.files.length} 个
        </Typography>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gap: 1,
          minWidth: 0,
          '@container phi-chat (max-width: 560px)': { gap: 0.5 }
        }}
      >
        {item.files.map((file) => {
          const icon = fileIconForPath(file.path)
          const FileIcon = icon.Icon
          const openError = errorFor(file.path)
          return (
            <ButtonBase
              key={file.path}
              type="button"
              data-phi-presented-file-row="true"
              aria-label={`预览交付文件 ${file.displayPath}`}
              title={file.description ? `${file.path}\n${file.description}` : file.path}
              disabled={!onOpenFile}
              onClick={onOpenFile ? () => void openFile(file) : undefined}
              sx={{
                width: '100%',
                minHeight: 84,
                minWidth: 0,
                px: 1.75,
                py: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.75,
                textAlign: 'left',
                color: 'text.primary',
                border: 1,
                borderColor: openError ? 'error.main' : 'divider',
                borderRadius: 2.5,
                bgcolor: 'background.paper',
                transition: 'border-color 150ms, background-color 150ms',
                '@container phi-chat (max-width: 560px)': {
                  minHeight: 54,
                  px: 0.75,
                  py: 0.5,
                  gap: 0.75,
                  borderRadius: 1.5
                },
                ...(onOpenFile
                  ? {
                      '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
                    }
                  : {})
              }}
            >
              <Box
                sx={{
                  width: 48,
                  height: 50,
                  flexShrink: 0,
                  borderRadius: 1.5,
                  bgcolor: 'action.hover',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  '@container phi-chat (max-width: 560px)': {
                    width: 34,
                    height: 36,
                    borderRadius: 1
                  }
                }}
              >
                <FileIcon
                  sx={{
                    color: icon.color,
                    fontSize: 33,
                    '@container phi-chat (max-width: 560px)': { fontSize: 23 }
                  }}
                />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  noWrap
                  variant="body1"
                  sx={{
                    fontWeight: 650,
                    lineHeight: 1.35,
                    color: 'text.primary',
                    '@container phi-chat (max-width: 560px)': { fontSize: '0.78rem' }
                  }}
                >
                  {file.displayPath}
                </Typography>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.75,
                    minWidth: 0,
                    mt: 0.25,
                    '@container phi-chat (max-width: 560px)': { gap: 0, mt: 0 }
                  }}
                >
                  {file.artifact?.kind ? (
                    <Typography
                      component="span"
                      variant="caption"
                      sx={{
                        flexShrink: 0,
                        color: 'text.secondary',
                        fontSize: '0.65rem',
                        '@container phi-chat (max-width: 560px)': { fontSize: '0.6rem' }
                      }}
                    >
                      {artifactKindLabel(file.artifact.kind)}
                    </Typography>
                  ) : null}
                  {file.description && (
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{
                        minWidth: 0,
                        color: 'text.secondary',
                        '@container phi-chat (max-width: 560px)': { display: 'none' }
                      }}
                    >
                      {file.description}
                    </Typography>
                  )}
                  <Typography
                    variant="body2"
                    sx={{
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                      color: 'text.secondary',
                      '@container phi-chat (max-width: 560px)': { fontSize: '0.7rem' }
                    }}
                  >
                    <Box
                      component="span"
                      sx={{ '@container phi-chat (max-width: 560px)': { display: 'none' } }}
                    >
                      {file.description ? '· ' : ''}
                    </Box>
                    {formatBytes(file.bytes)}
                  </Typography>
                </Box>
                {file.office ? <OfficePresentedFileDetails office={file.office} /> : null}
                {openError ? (
                  <Typography variant="caption" sx={{ display: 'block', color: 'error.main' }}>
                    交付文件已失效：{openError}
                  </Typography>
                ) : null}
              </Box>
              {onOpenFile && (
                <Box
                  component="span"
                  sx={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    opacity: 0.55,
                    '@container phi-chat (max-width: 560px)': { display: 'none' }
                  }}
                >
                  <GoChevronRight aria-hidden="true" size={18} />
                </Box>
              )}
            </ButtonBase>
          )
        })}
      </Box>
      <Typography
        variant="caption"
        noWrap
        title={
          item.files.some((file) => file.office)
            ? '打开的是经校验的 Office 交付版本；如文件被修改，入口会失效。'
            : '打开的是工作区中的当前文件，内容可能已更改。'
        }
        sx={{
          display: 'block',
          mt: 1,
          px: 0.5,
          color: 'text.secondary',
          '@container phi-chat (max-width: 560px)': { mt: 0.5, px: 0.25, fontSize: '0.67rem' }
        }}
      >
        {item.files.some((file) => file.office)
          ? '打开的是经校验的 Office 交付版本；如文件被修改，入口会失效。'
          : '打开的是工作区中的当前文件，内容可能已更改。'}
      </Typography>
    </Box>
  )
}
