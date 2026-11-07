import { Box, Typography } from '@mui/material'
import { useMemo, useState, type FormEvent } from 'react'
import type { LocalPathKind } from '../../components/MarkdownContent'
import { agentRunStatusText, isAgentRunGoneError } from '../../lib/agentExecutionControl'
import { useUiLanguage } from '../../lib/i18n'
import type { AgentExecutionItem } from '../../types'
import ChatView from './ChatView'
import { SavedFinalReportBlock } from './components/SavedFinalReportBlock'
import { useAgentRunStatus } from './hooks/useAgentRunStatus'
import { chatCopy } from './lib/chatCopy'
import { subagentSessionMessages, agentControlErrorText } from './lib/subagentSession'
import { AgentAvatar } from '../../components/AgentAvatar'
import { AgentRunLoader } from '../../components/AgentRunLoader'
import { agentDisplayLabel } from '../../lib/agentAvatar'

export type SubagentSessionViewProps = {
  item: AgentExecutionItem
  cwd?: string
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
}

const unchanged = (): void => undefined

/** The ordinary conversation surface, backed by a parent's child-run record instead of a new session. */
export default function SubagentSessionView({
  item,
  cwd = '',
  onOpenLocalPath
}: SubagentSessionViewProps): React.JSX.Element {
  const language = useUiLanguage()
  const { lost, isRunning, elapsed, controlTarget, markLost } = useAgentRunStatus(item)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [controlError, setControlError] = useState('')
  const statusText = agentRunStatusText(item, { lost })
  const messages = useMemo(() => {
    void language // Output preview markers follow live interface-language changes.
    return subagentSessionMessages(item)
  }, [item, language])

  const control = async (action: 'steer' | 'stop'): Promise<void> => {
    if (!controlTarget || pending || (action === 'steer' && !input.trim())) return
    setPending(true)
    setControlError('')
    try {
      if (action === 'steer') {
        await window.api.steerAgentRun(
          controlTarget.agentSessionId,
          controlTarget.agentRunId,
          input.trim(),
          item.id
        )
        setInput('')
      } else {
        await window.api.stopAgentRun(controlTarget.agentSessionId, controlTarget.agentRunId)
      }
    } catch (error) {
      if (isAgentRunGoneError(error)) markLost()
      else setControlError(agentControlErrorText(error))
    } finally {
      setPending(false)
    }
  }
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    await control('steer')
  }

  return (
    <Box
      data-phi-subagent-session={item.id}
      sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Box sx={{ px: 4, pt: 1.5, pb: 0.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <AgentAvatar displayName={item.agentName} decorative />
        <Typography
          variant="caption"
          color="text.secondary"
          aria-live="polite"
          title={item.agentName}
        >
          {agentDisplayLabel(item.agentName)}
          {isRunning ? (
            <>
              {' '}
              <AgentRunLoader label={statusText} sx={{ mx: 0.5 }} />
              {elapsed}
            </>
          ) : (
            ` · ${statusText} · ${elapsed}`
          )}
          {' · '}
          {chatCopy.temporaryAgentSession}
        </Typography>
      </Box>
      <ChatView
        messages={messages}
        input={input}
        onInputChange={controlTarget && !pending ? setInput : unchanged}
        inputDisabled={!controlTarget || pending}
        scrollResetKey={`subagent:${item.agentSessionId ?? ''}:${item.id}`}
        canSend={Boolean(controlTarget) && !pending}
        isGenerating={isRunning}
        showStopControl={Boolean(controlTarget) && !input.trim()}
        currentRunStartedAt={item.createdAt}
        models={[]}
        selectedModel={null}
        onSelectModel={unchanged}
        thinkingLevel="minimal"
        onSelectThinkingLevel={unchanged}
        disableModelControls
        sessionMode="auto"
        onSelectSessionMode={unchanged}
        disableSessionModeSelect
        onChatSubmit={submit}
        onStopGeneration={() => control('stop')}
        onGoSettings={unchanged}
        onOpenBackgroundJobs={unchanged}
        pendingApproval={null}
        pendingUserInteraction={null}
        onRespondApproval={unchanged}
        onRespondUserInteraction={unchanged}
        onOpenLocalPath={onOpenLocalPath}
        cwd={cwd}
        planRunPanel={
          <>
            <SavedFinalReportBlock item={item} />
            {lost ? (
              <Typography variant="body2" color="text.secondary">
                {chatCopy.thisAgentIsNoLongerRunningPhiMayHaveRestarted}
              </Typography>
            ) : null}
            {controlError ? (
              <Typography role="alert" variant="body2" color="error">
                {controlError}
              </Typography>
            ) : null}
          </>
        }
      />
    </Box>
  )
}
