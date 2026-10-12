import { Box, Button, Link, Paper, Stack, Typography } from '@mui/material'

import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { buildConnectorSetupPrompt } from '../../mcp/lib/connectorSetupPrompt'

export function ConnectorJobSetupGuide({
  setup,
  retrying,
  onOpenAgent,
  onCopyCommand,
  onOpenTerminal,
  onRetry
}: {
  setup: McpConnectorSetupProgress
  retrying: boolean
  onOpenAgent: (prompt: string) => void
  onCopyCommand: (command: string) => void
  onOpenTerminal: (command: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const commands = setup.setupHint?.commands ?? []
  const agentLabel = setup.failureKind === 'needs-setup' ? '交给 Agent 处理' : '交给 Agent 排查'

  return (
    <Stack spacing={1.25} aria-label="连接器处理指南">
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        怎么处理
      </Typography>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
          <Button variant="contained" onClick={() => onOpenAgent(buildConnectorSetupPrompt(setup))}>
            {agentLabel}
          </Button>
          <Typography variant="body2" color="text.secondary">
            新建对话并把排查信息放进输入框。内容不会自动发送，你可以先检查再发送。
          </Typography>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 700 }}>
          自己手动处理
        </Typography>
        <Box component="ol" sx={{ pl: 2.5, my: 0 }}>
          <Typography component="li" variant="body2" sx={{ mb: 1 }}>
            看上面的“进程输出”，确认服务自己的说明。
          </Typography>
          <Box component="li" sx={{ mb: 1 }}>
            <Typography variant="body2" sx={{ mb: commands.length ? 0.75 : 0 }}>
              {commands.length ? '在终端里完成它要求的初始化：' : '运行服务文档里的初始化命令。'}
              {setup.setupHint?.readmeUrl ? (
                <>
                  {' '}
                  <Link href={setup.setupHint.readmeUrl} target="_blank" rel="noreferrer">
                    查看 README
                  </Link>
                </>
              ) : null}
            </Typography>
            {commands.map((command) => (
              <Box key={command} sx={{ mb: 0.75 }}>
                <Box
                  component="code"
                  sx={{ display: 'block', p: 1, overflowWrap: 'anywhere', bgcolor: 'action.hover' }}
                >
                  {command}
                </Box>
                <Stack direction="row" spacing={0.75} sx={{ mt: 0.5 }}>
                  <Button size="small" onClick={() => onCopyCommand(command)}>
                    复制命令
                  </Button>
                  <Button size="small" onClick={() => onOpenTerminal(command)}>
                    在终端打开
                  </Button>
                </Stack>
              </Box>
            ))}
          </Box>
          <Typography component="li" variant="body2">
            完成后回到这里重试。
          </Typography>
        </Box>
        <Button sx={{ mt: 1 }} disabled={retrying} onClick={onRetry}>
          我已完成，重试
        </Button>
      </Paper>
    </Stack>
  )
}
