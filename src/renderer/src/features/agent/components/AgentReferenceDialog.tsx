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
  'phi-agent': 'Phi 智能体',
  'codex-prompt': 'Codex 提示词',
  'codex-agent': 'Codex 智能体',
  'server-project-agent': '服务器项目'
}

export function AgentReferenceDetails({ agent }: { agent: PromptAgentSummary }): React.JSX.Element {
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
        {agent.description || '这个智能体没有提供说明。'}
      </Typography>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">引用方式</Typography>
        <Typography component="code" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {agent.trigger || `/agent:${agent.name}`}
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">来源</Typography>
        <Typography variant="body2" color="text.secondary">
          {SOURCE_LABELS[agent.source] ?? agent.source}
        </Typography>
      </Stack>
      {location ? (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">文件</Typography>
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
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>智能体详情</DialogTitle>
      <DialogContent>
        <AgentReferenceDetails agent={agent} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  )
}
