import { Button, Chip, Stack, Typography } from '@mui/material'
import { useState } from 'react'

import type { PromptAgentSummary } from '../../types'
import { mutateRemoteAgentTrust } from './lib/remoteAgentTrust'

export type RemoteTrustResource = Pick<
  PromptAgentSummary,
  'trustState' | 'available' | 'diagnostics' | 'relativePath' | 'contentHash'
>

function statusLabel(resource: RemoteTrustResource): string | undefined {
  if (resource.trustState === 'pending') return '未信任'
  if (resource.trustState === 'changed') return '内容已变化'
  if (resource.trustState === 'trusted') return resource.available === false ? '不可用' : '已信任'
  if (resource.trustState === 'invalid') return '无效'
  if (resource.available === false) return '不可用'
  if (resource.diagnostics?.length) return '降级'
  return undefined
}

export function RemoteProjectTrustStatus({
  resource,
  sourceLabel = '服务器项目',
  compact = false
}: {
  resource: RemoteTrustResource
  sourceLabel?: string
  compact?: boolean
}): React.JSX.Element | null {
  const label = statusLabel(resource)
  if (!label && !resource.diagnostics?.length) return null
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0, mt: compact ? 0.25 : 0.5 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {sourceLabel ? (
          <Typography component="span" variant="caption" color="text.secondary">
            {sourceLabel}
          </Typography>
        ) : null}
        {label && (
          <Chip size="small" label={label} color={label === '已信任' ? 'success' : 'default'} />
        )}
      </Stack>
      {resource.diagnostics?.map((message) => (
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

export function PromptAgentStatus({
  agent,
  compact = false
}: {
  agent: RemoteTrustResource & Pick<PromptAgentSummary, 'scope'>
  compact?: boolean
}): React.JSX.Element | null {
  if (agent.scope !== 'remote-project' && !statusLabel(agent) && !agent.diagnostics?.length)
    return null
  return (
    <RemoteProjectTrustStatus
      resource={agent}
      sourceLabel={agent.scope === 'remote-project' ? '服务器项目' : ''}
      compact={compact}
    />
  )
}

function actionLabel(resource: RemoteTrustResource): string {
  if (resource.trustState === 'trusted') return '撤销信任'
  return resource.trustState === 'changed' ? '重新信任' : '信任'
}

export function RemoteProjectTrustControl({
  resource,
  cwd,
  onMutate,
  onChanged
}: {
  resource: RemoteTrustResource
  cwd: string
  onMutate: (
    resource: RemoteTrustResource,
    cwd: string,
    onChanged?: () => void | Promise<void>
  ) => Promise<unknown>
  onChanged: () => void | Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (
    resource.trustState === 'invalid' ||
    !resource.trustState ||
    !resource.relativePath ||
    !resource.contentHash
  )
    return null
  const changeTrust = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onMutate(resource, cwd, onChanged)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1, pb: 0.75 }}>
      <Button size="small" disabled={busy} onClick={() => void changeTrust()}>
        {actionLabel(resource)}
      </Button>
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  )
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
  if (agent.scope !== 'remote-project' || agent.trustState === 'invalid') return null
  return (
    <RemoteProjectTrustControl
      resource={agent}
      cwd={cwd}
      onMutate={(resource, targetCwd, changed) =>
        mutateRemoteAgentTrust(resource as PromptAgentSummary, targetCwd, changed)
      }
      onChanged={onChanged}
    />
  )
}
