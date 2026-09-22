import { Typography } from '@mui/material'
import { memo, useMemo, useState, type ReactNode } from 'react'
import type { AgentExecutionStep } from '../types'
import {
  AGENT_STEP_DETAIL_MAX_HEIGHT_PX,
  agentStepExpanded,
  stepAsToolCall
} from '../lib/agentStepPresentation'
import ToolCallCard from './ToolCallCard'
import { type ChatContentResizeHandler } from './chat/useCollapseResizeNotifier'

type AgentStepRowProps = {
  step: AgentExecutionStep
  cwd?: string
  onContentResize?: ChatContentResizeHandler
}

/**
 * One tool step of a delegated agent, shown like any tool call in the chat: a single line that
 * opens to its arguments and output. A running step is open while it streams and folds when it
 * finishes; a failed one stays open; whatever the user opens or closes stays that way.
 */
function AgentStepRow({ step, cwd, onContentResize }: AgentStepRowProps): ReactNode {
  const item = useMemo(() => stepAsToolCall(step), [step])
  const [userChoice, setUserChoice] = useState<boolean | null>(null)

  return (
    <>
      <ToolCallCard
        item={item}
        cwd={cwd}
        expanded={agentStepExpanded(step, userChoice)}
        onExpandedChange={setUserChoice}
        detailMaxHeight={AGENT_STEP_DETAIL_MAX_HEIGHT_PX}
        onContentResize={onContentResize}
      />
      {step.error ? (
        <Typography
          variant="caption"
          component="div"
          sx={{
            px: 0.5,
            pb: 0.5,
            color: 'error.main',
            fontFamily: 'var(--font-mono)',
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap'
          }}
        >
          {step.error}
        </Typography>
      ) : null}
    </>
  )
}

export default memo(AgentStepRow)
