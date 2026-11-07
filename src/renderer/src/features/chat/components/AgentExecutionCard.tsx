import { Box, ButtonBase, Typography } from '@mui/material'
import { memo } from 'react'
import { PhiIcons } from '../../../icons'
import type { AgentExecutionItem } from '../../../types'
import { agentRunStatusText } from '../../../lib/agentExecutionControl'
import { useUiLanguage } from '../../../lib/i18n'
import { StatusIndicator } from '../../../components/ToolCallCard'
import { useAgentRunStatus } from '../hooks/useAgentRunStatus'
import { chatCopy } from '../lib/chatCopy'

const AgentIcon = PhiIcons.entity.agent
const ChevronRightIcon = PhiIcons.action.back
const StopIcon = PhiIcons.action.stop

function AgentExecutionCard({
  item,
  onOpen
}: {
  item: AgentExecutionItem
  onOpen: (item: AgentExecutionItem) => void
}): React.JSX.Element {
  useUiLanguage()
  const { lost, isRunning, elapsed } = useAgentRunStatus(item)
  const leadingIconKind = item.cancelled
    ? 'cancelled'
    : lost || item.status !== 'done'
      ? 'status'
      : 'type'

  return (
    <ButtonBase
      data-agent-card-id={item.id}
      onClick={() => onOpen(item)}
      aria-label={chatCopy.openAgentSession(item.agentName)}
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        gap: 0.75,
        minWidth: 0,
        px: 0.5,
        py: 0.75,
        borderRadius: 1,
        textAlign: 'left',
        color: 'text.secondary',
        '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
      }}
    >
      <Box
        data-phi-agent-leading-icon={leadingIconKind}
        aria-live={isRunning ? 'polite' : undefined}
        sx={{
          width: 18,
          height: 18,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {leadingIconKind === 'cancelled' ? (
          <StopIcon sx={{ fontSize: 14 }} aria-label={chatCopy.cancelled} />
        ) : leadingIconKind === 'status' ? (
          <StatusIndicator status={lost ? 'error' : item.status} />
        ) : (
          <AgentIcon aria-hidden sx={{ fontSize: 16, color: 'primary.main' }} />
        )}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="div" variant="body2" noWrap sx={{ color: 'text.primary' }}>
          {chatCopy.delegatedTo} {item.agentName}
        </Typography>
        <Typography component="div" variant="caption" noWrap>
          {agentRunStatusText(item, { lost })} · {elapsed}
        </Typography>
      </Box>
      <ChevronRightIcon
        data-phi-agent-chevron="true"
        aria-hidden
        sx={{ fontSize: 16, flexShrink: 0 }}
      />
    </ButtonBase>
  )
}

export default memo(AgentExecutionCard)
