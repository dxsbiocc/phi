import { chatCopy } from '../features/chat/lib/chatCopy'
import { useUiLanguage } from '../lib/i18n'
import { Box, Button, Paper, Stack, Typography } from '@mui/material'
import type { ToolApprovalRequest } from '../types'
import { resourceCatalogCopy } from '../lib/resourceUi'

const TOOL_LABELS: Record<string, string> = {
  get bash() {
    return chatCopy.executeTerminalCommand
  },
  get powershell() {
    return chatCopy.executePowerShellCommand
  },
  get write() {
    return chatCopy.writeFile
  },
  get edit() {
    return chatCopy.editFile
  },
  get browser() {
    return chatCopy.browserAction
  },
  get capability_install() {
    return resourceCatalogCopy.capabilityInstall
  }
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
  useUiLanguage()
  if (!request) {
    return <></>
  }
  const resourceApproval = request.toolName === 'capability_install'

  return (
    <Paper
      variant="outlined"
      role="alert"
      aria-label={
        resourceApproval ? resourceCatalogCopy.permissionApproval : chatCopy.permissionApproval
      }
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
            {TOOL_LABELS[request.toolName] ?? request.toolName}
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
                {resourceApproval ? resourceCatalogCopy.openSession : chatCopy.openConversation}
              </Button>
            )}
          </Box>
          <Button color="error" onClick={() => onRespond(request.requestId, false)}>
            {resourceApproval ? resourceCatalogCopy.reject : chatCopy.reject}
          </Button>
          <Button variant="contained" onClick={() => onRespond(request.requestId, true)}>
            {resourceApproval
              ? resourceCatalogCopy.approve
              : request.toolName === 'browser'
                ? chatCopy.allowOnce
                : chatCopy.approve}
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}

export default ToolApprovalDialog
