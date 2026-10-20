import { agentCopy } from './lib/agentCopy'
import { getUiLanguage, useUiLanguage } from '../../lib/i18n'
import { Button, Chip, Stack, Typography } from '@mui/material'
import { useState } from 'react'

import { errorMessage } from '../../../../shared/errorCodes'
import type { PromptAgentSummary } from '../../types'
import { mutateRemoteAgentTrust } from './lib/remoteAgentTrust'
import { resourceTrustCopy } from '../../lib/resourceUi'

export type RemoteTrustResource = Pick<
  PromptAgentSummary,
  'trustState' | 'available' | 'diagnostics' | 'relativePath' | 'contentHash'
>

function statusLabel(
  resource: RemoteTrustResource,
  language: 'en' | 'zh-CN' = getUiLanguage()
): string | undefined {
  if (language === 'en') {
    if (resource.trustState === 'pending') return resourceTrustCopy.pending
    if (resource.trustState === 'changed') return resourceTrustCopy.changed
    if (resource.trustState === 'trusted')
      return resource.available === false
        ? resourceTrustCopy.unavailable
        : resourceTrustCopy.trusted
    if (resource.trustState === 'invalid') return resourceTrustCopy.invalid
    if (resource.available === false) return resourceTrustCopy.unavailable
    if (resource.diagnostics?.length) return resourceTrustCopy.degraded
    return undefined
  }
  if (resource.trustState === 'pending') return agentCopy.untrusted
  if (resource.trustState === 'changed') return agentCopy.contentChanged
  if (resource.trustState === 'trusted')
    return resource.available === false ? agentCopy.unavailable : agentCopy.trusted
  if (resource.trustState === 'invalid') return agentCopy.invalid
  if (resource.available === false) return agentCopy.unavailable
  if (resource.diagnostics?.length) return agentCopy.degraded
  return undefined
}

export function RemoteProjectTrustStatus({
  resource,
  language = getUiLanguage(),
  sourceLabel = language === 'en' ? resourceTrustCopy.remoteProject : agentCopy.serverProject,
  compact = false
}: {
  resource: RemoteTrustResource
  language?: 'en' | 'zh-CN'
  sourceLabel?: string
  compact?: boolean
}): React.JSX.Element | null {
  useUiLanguage()
  const label = statusLabel(resource, language)
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
          <Chip
            size="small"
            label={label}
            color={
              resource.trustState === 'trusted' && resource.available !== false
                ? 'success'
                : 'default'
            }
          />
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
  useUiLanguage()
  if (agent.scope !== 'remote-project' && !statusLabel(agent) && !agent.diagnostics?.length)
    return null
  return (
    <RemoteProjectTrustStatus
      resource={agent}
      sourceLabel={agent.scope === 'remote-project' ? agentCopy.serverProject : ''}
      compact={compact}
    />
  )
}

function actionLabel(resource: RemoteTrustResource, language: 'en' | 'zh-CN'): string {
  if (language === 'en') {
    if (resource.trustState === 'trusted') return resourceTrustCopy.revoke
    return resource.trustState === 'changed'
      ? resourceTrustCopy.trustAgain
      : resourceTrustCopy.trust
  }
  if (resource.trustState === 'trusted') return agentCopy.revokeTrust
  return resource.trustState === 'changed' ? agentCopy.trustAgain : agentCopy.trust
}

export function RemoteProjectTrustControl({
  resource,
  language = getUiLanguage(),
  cwd,
  onMutate,
  onChanged
}: {
  resource: RemoteTrustResource
  language?: 'en' | 'zh-CN'
  cwd: string
  onMutate: (
    resource: RemoteTrustResource,
    cwd: string,
    onChanged?: () => void | Promise<void>
  ) => Promise<unknown>
  onChanged: () => void | Promise<void>
}): React.JSX.Element | null {
  useUiLanguage()
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
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1, pb: 0.75 }}>
      <Button size="small" disabled={busy} onClick={() => void changeTrust()}>
        {actionLabel(resource, language)}
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
  useUiLanguage()
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
