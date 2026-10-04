import { Box, Button, Typography } from '@mui/material'

export type TerminalStatusKind =
  'starting' | 'exited' | 'failed' | 'remote' | 'unsupported' | 'limit' | 'unavailable'

export interface TerminalStatusPaneProps {
  kind: TerminalStatusKind
  exitCode?: number
  message?: string
  terminalCount?: number
  compact?: boolean
  onCreate?(): void
}

function statusCopy(props: TerminalStatusPaneProps): {
  title: string
  detail?: string
  alert?: boolean
  canCreate?: boolean
} {
  switch (props.kind) {
    case 'starting':
      return { title: '正在启动 Shell…' }
    case 'exited':
      return {
        title: `Shell 已退出（代码 ${props.exitCode ?? '—'}）`,
        canCreate: true
      }
    case 'failed':
      return {
        title: props.message || 'Shell 启动失败',
        detail: '可以新建一个终端后重试。',
        alert: true,
        canCreate: true
      }
    case 'remote':
      return { title: '远程终端将在后续版本支持' }
    case 'unsupported':
      return { title: '当前平台暂不支持终端', alert: true }
    case 'limit':
      return {
        title: `已达到终端数量上限（当前 ${props.terminalCount ?? 0} 个）`,
        detail: '请先结束一个终端后再新建。',
        alert: true
      }
    case 'unavailable':
      return {
        title: '终端需要重启 Phi',
        detail:
          '当前窗口的后台程序版本较旧，请完全退出并重新打开 Phi（开发模式下请重新启动开发服务器）后再使用终端。',
        alert: true
      }
  }
}

export function TerminalStatusPane(props: TerminalStatusPaneProps): React.JSX.Element {
  const copy = statusCopy(props)
  return (
    <Box
      data-phi-terminal-status={props.kind}
      role={copy.alert ? 'alert' : 'status'}
      sx={{
        width: props.compact ? 'auto' : '100%',
        minHeight: props.compact ? 'auto' : 112,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
        py: props.compact ? 1 : 2.5,
        textAlign: 'center',
        color: 'text.primary',
        bgcolor: props.compact ? 'background.paper' : 'transparent',
        borderTop: props.compact ? 1 : 0,
        borderColor: 'divider',
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ minWidth: 0, maxWidth: 320 }}>
        <Typography variant="body2" sx={{ fontWeight: props.kind === 'starting' ? 500 : 750 }}>
          {copy.title}
        </Typography>
        {copy.detail ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {copy.detail}
          </Typography>
        ) : null}
        {copy.canCreate && props.onCreate ? (
          <Button size="small" variant="outlined" onClick={props.onCreate} sx={{ mt: 1.25 }}>
            新建终端
          </Button>
        ) : null}
      </Box>
    </Box>
  )
}
