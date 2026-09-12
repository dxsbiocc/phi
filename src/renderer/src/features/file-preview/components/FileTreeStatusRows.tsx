import { Alert, Box, Typography } from '@mui/material'

export function FileTreeLoadingRow({ path }: { path: string }): React.JSX.Element {
  return (
    <Box key={`${path}-loading`} sx={{ px: 1.5, py: 0.75, color: 'text.secondary' }}>
      <Typography variant="caption">正在读取目录</Typography>
    </Box>
  )
}

export function FileTreeErrorRow({
  path,
  message
}: {
  path: string
  message: string
}): React.JSX.Element {
  return (
    <Box key={`${path}-error`} sx={{ px: 1.5, py: 0.75 }}>
      <Alert severity="error" variant="outlined">
        {message}
      </Alert>
    </Box>
  )
}

export function FileTreeEmptyRow({
  path,
  depth,
  isEmpty
}: {
  path: string
  depth: number
  isEmpty: boolean
}): React.JSX.Element {
  return (
    <Typography
      key={`${path}-empty`}
      data-phi-file-tree-empty="true"
      variant="caption"
      color="text.secondary"
      sx={{
        display: 'block',
        px: 1,
        py: 0.75,
        pl: 1 + depth * 1.75 + 2.5
      }}
    >
      {isEmpty ? '文件夹为空' : '没有匹配文件'}
    </Typography>
  )
}

export function FileTreeTruncatedRow({ path }: { path: string }): React.JSX.Element {
  return (
    <Typography
      key={`${path}-truncated`}
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', px: 1.5, py: 0.75 }}
    >
      已显示前 400 项
    </Typography>
  )
}
