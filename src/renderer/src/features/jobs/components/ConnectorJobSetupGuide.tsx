import { useUiLanguage } from '../../../lib/i18n'
import { connectorJobCopy } from '../lib/connectorJobCopy'
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
  useUiLanguage()
  const commands = setup.setupHint?.commands ?? []
  const agentLabel =
    setup.failureKind === 'needs-setup'
      ? connectorJobCopy.askAgentSetup
      : connectorJobCopy.askAgentInvestigate

  return (
    <Stack spacing={1.25} aria-label={connectorJobCopy.guide}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {connectorJobCopy.nextSteps}
      </Typography>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
          <Button variant="contained" onClick={() => onOpenAgent(buildConnectorSetupPrompt(setup))}>
            {agentLabel}
          </Button>
          <Typography variant="body2" color="text.secondary">
            {connectorJobCopy.agentDraft}
          </Typography>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 700 }}>
          {connectorJobCopy.manualSetup}
        </Typography>
        <Box component="ol" sx={{ pl: 2.5, my: 0 }}>
          <Typography component="li" variant="body2" sx={{ mb: 1 }}>
            {connectorJobCopy.checkOutput}
          </Typography>
          <Box component="li" sx={{ mb: 1 }}>
            <Typography variant="body2" sx={{ mb: commands.length ? 0.75 : 0 }}>
              {commands.length
                ? connectorJobCopy.initializeCommands
                : connectorJobCopy.initializeDocs}
              {setup.setupHint?.readmeUrl ? (
                <>
                  {' '}
                  <Link href={setup.setupHint.readmeUrl} target="_blank" rel="noreferrer">
                    {connectorJobCopy.viewReadme}
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
                    {connectorJobCopy.copyCommand}
                  </Button>
                  <Button size="small" onClick={() => onOpenTerminal(command)}>
                    {connectorJobCopy.openTerminal}
                  </Button>
                </Stack>
              </Box>
            ))}
          </Box>
          <Typography component="li" variant="body2">
            {connectorJobCopy.retryAfterSetup}
          </Typography>
        </Box>
        <Button sx={{ mt: 1 }} disabled={retrying} onClick={onRetry}>
          {connectorJobCopy.setupDoneRetry}
        </Button>
      </Paper>
    </Stack>
  )
}
