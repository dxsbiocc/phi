import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import type { ToolApprovalRequest } from '../types'
import { toolApprovalLabel } from '../lib/toolActions'

const TOOL_LABELS: Record<string, string> = {
  bash: '执行终端命令',
  powershell: '执行 PowerShell 命令',
  write: '写入文件',
  edit: '修改文件',
  office_apply: '修改 Office 文档',
  office_deliver: '交付 Office 文件',
  browser: '浏览器操作'
}

type ToolApprovalDialogProps = {
  request: ToolApprovalRequest | null
  onRespond: (requestId: string, approved: boolean) => void
  onOpenSession: (path: string) => void
}

function ToolApprovalDialog({
  request,
  onRespond,
  onOpenSession
}: ToolApprovalDialogProps): React.JSX.Element {
  if (!request) {
    return <></>
  }

  return (
    <Paper
      variant="outlined"
      role="alert"
      aria-label="权限审批"
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        p: 2,
        borderColor: 'warning.main',
        bgcolor: 'background.paper',
        boxShadow: (theme) =>
          theme.palette.mode === 'dark'
            ? '0 18px 48px rgba(0, 0, 0, 0.42)'
            : '0 18px 48px rgba(15, 42, 48, 0.14)'
      }}
    >
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {toolApprovalLabel(request.toolName, request.summary) ??
              TOOL_LABELS[request.toolName] ??
              request.toolName}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
            {request.projectName && (
              <Typography variant="caption" color="text.secondary">
                {request.projectName}
              </Typography>
            )}
            {request.cwd && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  fontFamily: 'var(--font-mono)',
                  minWidth: 0,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={request.cwd}
              >
                {request.cwd}
              </Typography>
            )}
          </Stack>
        </Box>
        <Typography
          variant="body2"
          sx={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxHeight: 132,
            overflow: 'auto',
            bgcolor: 'action.hover',
            borderRadius: 1,
            p: 1.5
          }}
        >
          {request.summary}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1 }}>
            {request.sessionPath && (
              <Button
                size="small"
                onClick={() => onOpenSession(request.sessionPath as string)}
                sx={{ minHeight: 36 }}
              >
                打开会话
              </Button>
            )}
          </Box>
          <Button color="error" onClick={() => onRespond(request.requestId, false)}>
            拒绝
          </Button>
          <Button variant="contained" onClick={() => onRespond(request.requestId, true)}>
            {request.toolName === 'browser' ? '仅允许这一次' : '批准'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}

export default ToolApprovalDialog
