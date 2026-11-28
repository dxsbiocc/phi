import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { useState } from 'react'

import { useUiLanguage } from '../../../lib/i18n'
import type { AgentUserInteractionResponse } from '../../../types'
import {
  classifyMcpAuthError,
  formatMcpAuthError,
  mcpAuthPromptDraftForRequest,
  mcpAuthPromptResponse,
  reduceMcpAuthPromptDraft,
  type McpAuthChoice,
  type McpAuthPromptDraft,
  type McpAuthPromptDraftAction,
  type McpAuthPromptRequest
} from '../lib/mcpAuthPrompt'
import { mcpAuthPromptCopy } from '../lib/mcpAuthPromptCopy'

export interface McpAuthPromptApi {
  authorizeFeaturedMcp?: (id: string) => Promise<void>
  cancelFeaturedMcpAuth?: (id: string) => Promise<void>
  setFeaturedMcpApiKey?: (id: string, key: string) => Promise<void>
}

type McpAuthPromptCardProps = {
  request: McpAuthPromptRequest
  onRespond: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => void
  authApi?: McpAuthPromptApi
}

function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(96px, auto) minmax(0, 1fr)', gap: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Box>
  )
}

function McpAuthPromptLinks({ request }: { request: McpAuthPromptRequest }): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
      {request.kind === 'api-key' ? (
        <Button
          component="a"
          href={request.connector.obtainUrl}
          target="_blank"
          rel="noreferrer"
          size="small"
          sx={{ px: 0, minWidth: 0 }}
        >
          {mcpAuthPromptCopy.obtainApiKey(request.connector.title)}
        </Button>
      ) : (
        <Button
          component="a"
          href={request.connector.authorizationOrigin}
          target="_blank"
          rel="noreferrer"
          size="small"
          sx={{ px: 0, minWidth: 0 }}
        >
          {mcpAuthPromptCopy.openSignInSite}
        </Button>
      )}
      {request.connector.homepageUrl && (
        <Button
          component="a"
          href={request.connector.homepageUrl}
          target="_blank"
          rel="noreferrer"
          size="small"
          color="inherit"
          sx={{ px: 0, minWidth: 0 }}
        >
          {mcpAuthPromptCopy.openDocs}
        </Button>
      )}
    </Stack>
  )
}

function McpAuthPromptNotices({
  request,
  draft
}: {
  request: McpAuthPromptRequest
  draft: McpAuthPromptDraft
}): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      {request.kind === 'oauth' && request.connector.id === 'composio' && (
        <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
          {mcpAuthPromptCopy.composioHint}
        </Alert>
      )}
      {request.kind === 'api-key' && request.connector.id === 'serpapi' && (
        <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
          {mcpAuthPromptCopy.serpApiDisclosure}
        </Alert>
      )}
      {request.kind === 'oauth' && draft.busy && (
        <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
          {mcpAuthPromptCopy.waitingBrowserSignIn}
        </Alert>
      )}
      {draft.error && (
        <Alert severity="error" variant="outlined" sx={{ py: 0 }}>
          {formatMcpAuthError(draft.error)}
        </Alert>
      )}
    </>
  )
}

function defaultAuthApi(): McpAuthPromptApi | undefined {
  return typeof window !== 'undefined' ? (window.api as McpAuthPromptApi | undefined) : undefined
}

// Cohesive inline authentication card for OAuth browser sign-in and encrypted API-key verification.
// eslint-disable-next-line max-lines-per-function
export function McpAuthPromptCard({
  request,
  onRespond,
  authApi
}: McpAuthPromptCardProps): React.JSX.Element {
  useUiLanguage()
  const [savedDraft, setSavedDraft] = useState<McpAuthPromptDraft | null>(null)
  const draft = mcpAuthPromptDraftForRequest(request.requestId, savedDraft)
  const trimmedKey = draft.apiKey.trim()

  const updateDraft = (action: McpAuthPromptDraftAction): void => {
    setSavedDraft((current) =>
      reduceMcpAuthPromptDraft(mcpAuthPromptDraftForRequest(request.requestId, current), action)
    )
  }

  const respond = (choice: McpAuthChoice): void => {
    const response = mcpAuthPromptResponse(request.requestId, request.connector.id, choice)
    onRespond(request.requestId, response, choice.action === 'cancel')
  }

  const startOAuth = async (): Promise<void> => {
    const api = authApi ?? defaultAuthApi()
    if (typeof api?.authorizeFeaturedMcp !== 'function') {
      updateDraft({ type: 'set-error', error: { kind: 'api-missing' } })
      return
    }
    updateDraft({ type: 'start-busy' })
    try {
      await api.authorizeFeaturedMcp(request.connector.id)
      respond({ action: 'authenticated' })
    } catch (cause) {
      updateDraft({ type: 'set-error', error: classifyMcpAuthError(cause) })
    }
  }

  const cancelOAuth = (): void => {
    const api = authApi ?? defaultAuthApi()
    if (typeof api?.cancelFeaturedMcpAuth === 'function') {
      void api.cancelFeaturedMcpAuth(request.connector.id).catch(() => undefined)
    }
  }

  const submitApiKey = async (): Promise<void> => {
    if (!trimmedKey || draft.busy) return
    const api = authApi ?? defaultAuthApi()
    if (typeof api?.setFeaturedMcpApiKey !== 'function') {
      updateDraft({ type: 'set-error', error: { kind: 'api-missing' } })
      return
    }
    updateDraft({ type: 'start-busy' })
    try {
      await api.setFeaturedMcpApiKey(request.connector.id, trimmedKey)
      updateDraft({ type: 'set-api-key', apiKey: '' })
      respond({ action: 'authenticated' })
    } catch (cause) {
      updateDraft({ type: 'set-error', error: classifyMcpAuthError(cause) })
    }
  }

  const isOAuth = request.kind === 'oauth'
  const skip = (): void => {
    if (isOAuth && draft.busy) cancelOAuth()
    respond({ action: 'cancel' })
  }

  return (
    <Paper
      variant="outlined"
      role="alert"
      aria-label={mcpAuthPromptCopy.ariaLabel(request.connector.title)}
      data-phi-mcp-auth-prompt={request.connector.id}
      sx={{
        width: '100%',
        mb: 1,
        borderRadius: 2,
        p: 1.5,
        borderColor: 'warning.main',
        bgcolor: 'background.paper'
      }}
    >
      <Stack spacing={1.25}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {isOAuth ? mcpAuthPromptCopy.oauthTitle : mcpAuthPromptCopy.apiKeyTitle}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {isOAuth ? mcpAuthPromptCopy.oauthSubtitle : mcpAuthPromptCopy.apiKeySubtitle}
            </Typography>
          </Box>
          <Button color="inherit" size="small" disabled={!isOAuth && draft.busy} onClick={skip}>
            {mcpAuthPromptCopy.skipForNow}
          </Button>
        </Box>

        <Stack spacing={0.5}>
          <SummaryRow label={mcpAuthPromptCopy.connectorLabel} value={request.connector.title} />
          <SummaryRow
            label={mcpAuthPromptCopy.publisherLabel}
            value={request.connector.publisher}
          />
          {request.kind === 'oauth' && (
            <SummaryRow
              label={mcpAuthPromptCopy.authOriginLabel}
              value={request.connector.authorizationOrigin}
            />
          )}
        </Stack>

        <McpAuthPromptLinks request={request} />

        {request.kind === 'api-key' && (
          <TextField
            fullWidth
            size="small"
            type="password"
            label={mcpAuthPromptCopy.apiKeyLabel}
            placeholder={mcpAuthPromptCopy.apiKeyPlaceholder}
            value={draft.apiKey}
            disabled={draft.busy}
            autoComplete="off"
            onChange={(event) => updateDraft({ type: 'set-api-key', apiKey: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmedKey && !draft.busy) {
                event.preventDefault()
                void submitApiKey()
              }
            }}
          />
        )}

        <McpAuthPromptNotices request={request} draft={draft} />

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          {isOAuth ? (
            draft.busy ? (
              <Button size="small" variant="outlined" onClick={cancelOAuth}>
                {mcpAuthPromptCopy.cancelSignIn}
              </Button>
            ) : (
              <Button size="small" variant="contained" onClick={() => void startOAuth()}>
                {mcpAuthPromptCopy.signInWithBrowser}
              </Button>
            )
          ) : (
            <Button
              size="small"
              variant="contained"
              disabled={draft.busy || !trimmedKey}
              onClick={() => void submitApiKey()}
            >
              {draft.busy ? mcpAuthPromptCopy.verifying : mcpAuthPromptCopy.verifyAndConnect}
            </Button>
          )}
        </Box>
      </Stack>
    </Paper>
  )
}
