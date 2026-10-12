import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import type {
  LocalMcpConnectorRequest,
  LocalMcpRuntimeOption
} from '../../../../../shared/mcpConnectorCatalog'

export interface McpLocalConnectConfirmDialogProps {
  open: boolean
  submitting: boolean
  request: LocalMcpConnectorRequest
  runtimes: readonly LocalMcpRuntimeOption[]
  disablePortal?: boolean
  onCancel: () => void
  onConfirm: () => void
}

function runtimeLabel(
  request: LocalMcpConnectorRequest,
  runtimes: readonly LocalMcpRuntimeOption[]
): string {
  if (request.runtime.kind === 'bun') return 'Phi 内置 Bun'
  if (request.runtime.kind === 'host') return '本机命令（不隔离）'
  const runtimeRef = request.runtime.ref
  return runtimes.find((runtime) => runtime.ref === runtimeRef)?.label ?? runtimeRef
}

function connectorArgv(request: LocalMcpConnectorRequest): string[] {
  return request.runtime.kind === 'bun'
    ? ['bun', request.command, ...request.args]
    : [request.command, ...request.args]
}

export function McpLocalConnectConfirmDialog({
  open,
  submitting,
  request,
  runtimes,
  disablePortal = false,
  onCancel,
  onConfirm
}: McpLocalConnectConfirmDialogProps): React.JSX.Element {
  const argv = connectorArgv(request)
  const environmentNames = Object.keys(request.env)

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onCancel}
      maxWidth="sm"
      fullWidth
      disablePortal={disablePortal}
      aria-labelledby="mcp-local-connect-confirm-title"
      aria-describedby="mcp-local-connect-confirm-description"
    >
      <DialogTitle id="mcp-local-connect-confirm-title">确认添加本地连接器</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">运行位置</Typography>
            <Typography>{runtimeLabel(request, runtimes)}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">启动参数</Typography>
            {argv.map((arg, index) => (
              <Typography
                key={`${index}:${arg}`}
                component="code"
                sx={{ overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
              >
                argv[{index}] = {JSON.stringify(arg)}
              </Typography>
            ))}
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">环境变量</Typography>
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {environmentNames.length > 0 ? environmentNames.join('、') : '无'}
            </Typography>
          </Stack>
          {request.cwd ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">工作目录</Typography>
              <Typography component="code" sx={{ overflowWrap: 'anywhere' }}>
                {request.cwd}
              </Typography>
            </Stack>
          ) : null}
          {request.runtime.kind === 'host' ? (
            <Alert severity="warning">将直接在本机运行，不使用 Phi 隔离环境</Alert>
          ) : null}
          {request.runtime.kind === 'bun' ? (
            <Alert severity="warning">
              由 Phi 内置 Bun 以 Node 兼容模式运行；个别依赖可能不兼容。x
              方式每次启动会联网解析依赖，版本不锁定。
            </Alert>
          ) : null}
          <Typography id="mcp-local-connect-confirm-description" color="text.secondary">
            确认后将在后台启动并验证，界面不会被锁住；进度见后台任务。
            首次运行需要下载依赖，可能需要几分钟。
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={submitting} onClick={onCancel}>
          取消
        </Button>
        <Button variant="contained" disabled={submitting} onClick={onConfirm}>
          {submitting ? '正在提交…' : '确认并在后台添加'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
