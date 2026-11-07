import { Box, ButtonBase, Typography } from '@mui/material'
import { memo } from 'react'
import { PhiIcons } from '../../../icons'
import type { AgentExecutionItem } from '../../../types'
import { agentRunStatusText } from '../../../lib/agentExecutionControl'
import { useUiLanguage } from '../../../lib/i18n'
import { AgentAvatar } from '../../../components/AgentAvatar'
import { StatusIndicator } from '../../../components/ToolCallCard'
import { agentDisplayLabel } from '../../../lib/agentAvatar'
import { useAgentRunStatus } from '../hooks/useAgentRunStatus'
import { chatCopy } from '../lib/chatCopy'

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
  const displayName = agentDisplayLabel(item.agentName)
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
          position: 'relative',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <AgentAvatar displayName={item.agentName} decorative size={18} />
        {leadingIconKind !== 'type' ? (
          <Box
            sx={{
              position: 'absolute',
              right: -5,
              bottom: -5,
              width: 14,
              height: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              bgcolor: 'background.paper'
            }}
          >
            {leadingIconKind === 'cancelled' ? (
              <StopIcon sx={{ fontSize: 12 }} aria-label={chatCopy.cancelled} />
            ) : (
              <StatusIndicator status={lost ? 'error' : item.status} />
            )}
          </Box>
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          component="div"
          variant="body2"
          noWrap
          title={item.agentName}
          sx={{ color: 'text.primary' }}
        >
          {chatCopy.delegatedTo} {displayName}
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
