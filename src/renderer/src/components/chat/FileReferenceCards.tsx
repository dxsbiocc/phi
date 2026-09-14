import { Box, IconButton, Typography } from '@mui/material'
import { PhiIcons, directoryIconForPath, fileIconForPath } from '../../icons'

const RemoveIcon = PhiIcons.action.close

function fileNameFromPath(path: string): string {
  return path.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? path
}

function iconMetaForPath(path: string): ReturnType<typeof fileIconForPath> {
  return path.endsWith('/') ? directoryIconForPath(path, false) : fileIconForPath(path)
}

export function FileReferenceCards({
  paths,
  variant,
  onRemove
}: {
  paths: string[]
  variant: 'composer' | 'message'
  onRemove?: (index: number) => void
}): React.JSX.Element | null {
  if (paths.length === 0) return null

  if (variant === 'message') {
    return (
      <Box
        sx={{
          alignSelf: 'flex-end',
          maxWidth: '75%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 1,
          mb: 1
        }}
      >
        {paths.map((path, index) => {
          const iconMeta = iconMetaForPath(path)
          const EntryIcon = iconMeta.Icon
          return (
            <Box
              key={`${path}-${index}`}
              title={path}
              sx={{
                width: 'min(400px, 100%)',
                minWidth: 0,
                minHeight: 74,
                px: 1.25,
                py: 1,
                border: 1,
                borderColor: 'divider',
                borderRadius: 3,
                bgcolor: 'background.paper',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25
              }}
            >
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: 2,
                  bgcolor: 'action.hover',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                <EntryIcon fontSize="large" sx={{ color: iconMeta.color }} />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  variant="body1"
                  noWrap
                  sx={{ fontWeight: 800, lineHeight: 1.35, color: 'text.primary' }}
                >
                  {fileNameFromPath(path)}
                </Typography>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.25, mb: 1.25 }}>
      {paths.map((path, index) => {
        const iconMeta = iconMetaForPath(path)
        const EntryIcon = iconMeta.Icon
        return (
          <Box
            key={`${path}-${index}`}
            title={path}
            sx={{
              width: 154,
              height: 116,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: 'background.paper',
              overflow: 'hidden',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {onRemove ? (
              <IconButton
                type="button"
                aria-label={`移除引用文件 ${fileNameFromPath(path)}`}
                onClick={() => onRemove(index)}
                sx={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  zIndex: 1,
                  width: 24,
                  height: 24,
                  bgcolor: 'rgba(15, 23, 42, 0.7)',
                  color: 'common.white',
                  '&:hover': { bgcolor: 'rgba(15, 23, 42, 0.82)' }
                }}
              >
                <RemoveIcon size={14} />
              </IconButton>
            ) : null}
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                bgcolor: 'action.hover',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <EntryIcon fontSize="large" sx={{ color: iconMeta.color }} />
            </Box>
            <Box
              sx={{
                px: 1,
                py: 0.75,
                display: 'flex',
                alignItems: 'center',
                minWidth: 0
              }}
            >
              <Typography variant="body2" noWrap sx={{ minWidth: 0, fontWeight: 700 }}>
                {fileNameFromPath(path)}
              </Typography>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
