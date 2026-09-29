import { Alert, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'

export function McpToolList({
  requiresSignIn,
  signInMessage,
  loading,
  names,
  error,
  onRetry
}: {
  requiresSignIn: boolean
  signInMessage?: string
  loading: boolean
  names: string[] | null
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  return (
    <>
      <Stack direction="row" sx={{ mb: 1, alignItems: 'center' }}>
        <Typography variant="h6" sx={{ flex: 1, fontWeight: 700 }}>
          服务端工具{names ? ` · ${names.length}` : ''}
        </Typography>
        {names !== null && (
          <Button size="small" disabled={loading} onClick={onRetry}>
            刷新工具
          </Button>
        )}
      </Stack>
      {requiresSignIn ? (
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          {signInMessage ?? '尚未验证授权，无法读取此服务当前提供的工具。'}
        </Typography>
      ) : loading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 4 }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">正在读取服务端工具…</Typography>
        </Stack>
      ) : error ? (
        <Alert severity="warning" action={<Button onClick={onRetry}>重试</Button>} sx={{ mb: 4 }}>
          无法读取当前工具列表：{error}
        </Alert>
      ) : (
        <Stack direction="row" sx={{ mb: 4, flexWrap: 'wrap', gap: 1 }}>
          {names === null ? (
            <Typography color="text.secondary">尚未读取服务端工具。</Typography>
          ) : names.length ? (
            names.map((name) => <Chip key={name} label={name} size="small" variant="outlined" />)
          ) : (
            <Typography color="text.secondary">服务端当前未公开工具。</Typography>
          )}
        </Stack>
      )}
    </>
  )
}
