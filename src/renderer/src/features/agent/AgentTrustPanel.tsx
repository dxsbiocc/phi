import { Button, Chip, Stack, Typography } from '@mui/material'
import { useState } from 'react'

import type { PromptAgentSummary } from '../../types'
import { mutateRemoteAgentTrust } from './lib/remoteAgentTrust'

type AgentStatusValue = Pick<
  PromptAgentSummary,
  'scope' | 'trustState' | 'available' | 'diagnostics'
>

function statusLabel(agent: AgentStatusValue): string | undefined {
  if (agent.trustState === 'pending') return '未信任'
  if (agent.trustState === 'changed') return '内容已变化'
  if (agent.trustState === 'trusted') return agent.available === false ? '不可用' : '已信任'
  if (agent.trustState === 'invalid') return '无效'
  if (agent.available === false) return '不可用'
  if (agent.diagnostics?.length) return '降级'
  return undefined
}

export function PromptAgentStatus({
  agent,
  compact = false
}: {
  agent: AgentStatusValue
  compact?: boolean
}): React.JSX.Element | null {
  const label = statusLabel(agent)
  if (!label && !agent.diagnostics?.length) return null
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0, mt: compact ? 0.25 : 0.5 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {agent.scope === 'remote-project' && (
          <Typography component="span" variant="caption" color="text.secondary">
            服务器项目
          </Typography>
        )}
        {label && (
          <Chip size="small" label={label} color={label === '已信任' ? 'success' : 'default'} />
        )}
      </Stack>
      {agent.diagnostics?.map((message) => (
        <Typography
          key={message}
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', whiteSpace: compact ? 'nowrap' : 'normal', overflow: 'hidden' }}
        >
          {message}
        </Typography>
      ))}
    </Stack>
  )
}

function actionLabel(agent: PromptAgentSummary): string {
  if (agent.trustState === 'trusted') return '撤销信任'
  return agent.trustState === 'changed' ? '重新信任' : '信任'
}

export function RemoteAgentTrustControl({
  agent,
  cwd,
  onChanged
}: {
  agent: PromptAgentSummary
  cwd: string
  onChanged: () => void | Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (agent.scope !== 'remote-project' || agent.trustState === 'invalid') return null
  const changeTrust = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await mutateRemoteAgentTrust(agent, cwd, onChanged)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1, pb: 0.75 }}>
      <Button size="small" disabled={busy} onClick={() => void changeTrust()}>
        {actionLabel(agent)}
      </Button>
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  )
}
