import { formatPromptAgentReference } from '../../../lib/inputReferences'
import { agentCopy } from '../lib/agentCopy'
import { useUiLanguage } from '../../../lib/i18n'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'

import { ResourceIcon } from '../../../components/ResourceIcon'
import type { PromptAgentSummary } from '../../../types'
import { PromptAgentStatus } from '../AgentTrustPanel'

const SOURCE_LABELS: Record<string, string> = {
  get 'phi-agent'() {
    return agentCopy.phiAgent
  },
  get 'codex-prompt'() {
    return agentCopy.codexPrompt
  },
  get 'codex-agent'() {
    return agentCopy.codexAgent
  },
  get 'server-project-agent'() {
    return agentCopy.serverProject
  }
}

export function AgentReferenceDetails({ agent }: { agent: PromptAgentSummary }): React.JSX.Element {
  useUiLanguage()
  const location =
    agent.relativePath ?? (/^(?:\/|[a-z]:[\\/])/iu.test(agent.id) ? agent.id : undefined)
  return (
    <Stack spacing={2} sx={{ minWidth: 0, pt: 0.5 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <ResourceIcon kind="agent" icon={agent.icon} size={48} />
        <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>
          {agent.name}
        </Typography>
      </Stack>
      <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {agent.description || agentCopy.thisAgentHasNoDescription}
      </Typography>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">{agentCopy.referenceSyntax}</Typography>
        <Typography component="code" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {formatPromptAgentReference(agent)}
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">{agentCopy.source}</Typography>
        <Typography variant="body2" color="text.secondary">
          {SOURCE_LABELS[agent.source] ?? agent.source}
        </Typography>
      </Stack>
      {location ? (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">{agentCopy.file}</Typography>
          <Typography
            component="code"
            variant="body2"
            color="text.secondary"
            sx={{ overflowWrap: 'anywhere' }}
          >
            {location}
          </Typography>
        </Stack>
      ) : null}
      <PromptAgentStatus agent={agent} />
    </Stack>
  )
}

export function AgentReferenceDialog({
  agent,
  onClose
}: {
  agent: PromptAgentSummary
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{agentCopy.agentDetails}</DialogTitle>
      <DialogContent>
        <AgentReferenceDetails agent={agent} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{agentCopy.close}</Button>
      </DialogActions>
    </Dialog>
  )
}
