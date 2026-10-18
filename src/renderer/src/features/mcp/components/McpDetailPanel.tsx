import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { PhiIcons } from '../../../icons'
import type { McpServerSummary } from '../../../types'
import { featuredAuthFailureNotice, featuredOAuthStatusFromError } from '../lib/featuredAuthStatus'
import {
  cacheFeaturedToolNames,
  cachedFeaturedToolNames,
  clearFeaturedToolNames
} from '../lib/featuredToolCache'
import { ConnectorIcon } from './ConnectorIcon'
import { McpApiKeyDialog } from './McpApiKeyDialog'
import type { ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpFeaturedConnectorDetails } from './McpFeaturedConnectorDetails'
import { isRemoteProjectMcpServer } from '../lib/remoteProjectMcpTrust'
import { RemoteProjectMcpTrustPanel } from './RemoteProjectMcpTrustPanel'

export interface McpDetailPanelProps {
  selectedServer: McpServerSummary | null
  onRemoveServer?: (server: McpServerSummary) => Promise<void>
  onRefreshServers?: () => Promise<void>
  initialCatalog?: readonly FeaturedMcpConnector[]
}

function commandLine(server: McpServerSummary): string {
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(
    /^Error invoking remote method ['"]mcp:setFeaturedApiKey['"]: (?:McpApiKeyValidationError|Error): /,
    ''
  )
}

export function McpDetailPanel({
  selectedServer,
  onRemoveServer,
  onRefreshServers,
  initialCatalog = []
}: McpDetailPanelProps): React.JSX.Element {
  useUiLanguage()

  const [catalog, setCatalog] = useState<FeaturedMcpConnector[]>(() => [...initialCatalog])
  useEffect(() => {
    let active = true
    void window.api
      .listMcpConnectorCatalog()
      .then((entries) => {
        if (active) setCatalog(entries)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [selectedServer?.id])
  const connector = selectedServer
    ? catalog.find(
        (entry) =>
          entry.id === selectedServer.packageId ||
          entry.id === selectedServer.connectorId ||
          (entry.url === selectedServer.url && (!entry.apiKey || entry.id === selectedServer.name))
      )
    : undefined
  const remoteProjectServer =
    selectedServer && isRemoteProjectMcpServer(selectedServer) ? selectedServer : null
  const [authStatusById, setAuthStatusById] = useState<Record<string, ConnectorAuthStatus>>({})
  const authStatus =
    connector && !connector.apiKey && !connector.oauthAuthorizationOrigin
      ? 'unauthenticated'
      : connector
        ? (authStatusById[connector.id] ?? 'checking')
        : 'checking'
  const [toolSnapshot, setToolSnapshot] = useState<{
    connectorId: string
    refresh: number
    names: string[] | null
    error: string | null
  } | null>(null)
  const [toolRefresh, setToolRefresh] = useState(0)
  const canReadTools = Boolean(
    connector &&
    (!remoteProjectServer ||
      (remoteProjectServer.trustState === 'trusted' && remoteProjectServer.available)) &&
    !(connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin) &&
    (!(connector.apiKey || connector.oauthAuthorizationOrigin) || authStatus === 'authenticated')
  )
  const currentToolSnapshot =
    connector && toolSnapshot?.connectorId === connector.id && toolSnapshot.refresh === toolRefresh
      ? toolSnapshot
      : null
  const toolNames =
    canReadTools && connector
      ? (currentToolSnapshot?.names ?? cachedFeaturedToolNames(connector.id))
      : null
  const toolsError = canReadTools ? (currentToolSnapshot?.error ?? null) : null
  const toolsLoading = canReadTools && toolNames === null && toolsError === null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removeConfirmationServerId, setRemoveConfirmationServerId] = useState<string | null>(null)
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const toolRequestRef = useRef(0)

  useEffect(() => {
    if (!connector) return
    if (remoteProjectServer && !remoteProjectServer.available) return
    if (!connector.apiKey && !connector.oauthAuthorizationOrigin) return
    let active = true
    const status = connector.apiKey
      ? window.api.getFeaturedMcpApiKeyStatus(connector.id)
      : window.api.getFeaturedMcpAuthStatus(connector.id)
    void status
      .then((authenticated) => {
        if (active) {
          setAuthStatusById((current) => ({
            ...current,
            [connector.id]: authenticated ? 'authenticated' : 'unauthenticated'
          }))
        }
      })
      .catch((cause: unknown) => {
        if (!active) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setAuthStatusById((current) => ({
          ...current,
          [connector.id]: connector.oauthAuthorizationOrigin
            ? featuredOAuthStatusFromError(message, connector.name)
            : 'unavailable'
        }))
      })
    return () => {
      active = false
    }
  }, [connector, remoteProjectServer, selectedServer])

  useEffect(() => {
    const request = ++toolRequestRef.current
    if (!connector || !canReadTools || cachedFeaturedToolNames(connector.id) !== null) return
    void window.api
      .listFeaturedMcpTools(connector.id)
      .then((names) => {
        cacheFeaturedToolNames(connector.id, names)
        if (request === toolRequestRef.current) {
          setToolSnapshot({ connectorId: connector.id, refresh: toolRefresh, names, error: null })
        }
      })
      .catch((cause: unknown) => {
        if (request === toolRequestRef.current) {
          setToolSnapshot({
            connectorId: connector.id,
            refresh: toolRefresh,
            names: null,
            error: errorMessage(cause)
          })
        }
      })
    return () => {
      toolRequestRef.current += 1
    }
  }, [connector, canReadTools, toolRefresh])

  function refreshTools(): void {
    if (!connector) return
    clearFeaturedToolNames(connector.id)
    setToolRefresh((current) => current + 1)
  }

  async function remove(): Promise<void> {
    if (!selectedServer || !onRemoveServer) return
    setBusy(true)
    setError(null)
    try {
      await onRemoveServer(selectedServer)
      setRemoveConfirmationServerId(null)
      if (connector) clearFeaturedToolNames(connector.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function authorize(): Promise<void> {
    if (!connector?.oauthAuthorizationOrigin) return
    setBusy(true)
    setError(null)
    try {
      await window.api.authorizeFeaturedMcp(connector.id)
      setAuthStatusById((current) => ({ ...current, [connector.id]: 'authenticated' }))
      refreshTools()
    } catch (cause) {
      const message = errorMessage(cause)
      setError(featuredAuthFailureNotice(message))
      setAuthStatusById((current) => ({
        ...current,
        [connector.id]: featuredOAuthStatusFromError(message, connector.name)
      }))
    } finally {
      setBusy(false)
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    if (!selectedServer || !onRefreshServers) return
    setBusy(true)
    setError(null)
    try {
      await window.api.setMcpConnectorEnabled(
        selectedServer.name,
        enabled,
        selectedServer.sourcePath
      )
      await onRefreshServers()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function replaceApiKey(): Promise<void> {
    if (!connector?.apiKey || !apiKeyInput.trim()) return
    setBusy(true)
    setApiKeyError(null)
    try {
      await window.api.setFeaturedMcpApiKey(connector.id, apiKeyInput.trim())
      setAuthStatusById((current) => ({ ...current, [connector.id]: 'authenticated' }))
      setApiKeyInput('')
      setApiKeyDialogOpen(false)
      refreshTools()
    } catch (cause) {
      setApiKeyError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
      {selectedServer ? (
        <Box sx={{ width: '100%', maxWidth: 1000, mx: 'auto', px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
          {connector ? (
            <McpFeaturedConnectorDetails
              connector={connector}
              server={selectedServer}
              authStatus={authStatus}
              busy={busy || Boolean(remoteProjectServer && !remoteProjectServer.available)}
              toolNames={toolNames}
              toolsLoading={toolsLoading}
              toolsError={toolsError}
              iconSize={72}
              onAdd={() => undefined}
              onRemove={onRemoveServer && !remoteProjectServer ? () => void remove() : undefined}
              onAuthorize={() => void authorize()}
              onApiKey={() => setApiKeyDialogOpen(true)}
              onEnabledChange={
                onRefreshServers && !remoteProjectServer
                  ? (enabled) => void setEnabled(enabled)
                  : undefined
              }
              onRetry={refreshTools}
            />
          ) : (
            <>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
                <ConnectorIcon icon={selectedServer.icon} size={72} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                    {selectedServer.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {selectedServer.sourcePath ?? connectorCopy.localConfiguration}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={
                      remoteProjectServer
                        ? connectorCopy.serverProject
                        : selectedServer.enabled === false
                          ? resourceUi.disabled
                          : connectorCopy.configured
                    }
                    sx={{ mt: 1.5 }}
                  />
                  {selectedServer.userStdio ? (
                    <Chip
                      size="small"
                      color="primary"
                      variant="outlined"
                      label={connectorCopy.customLocal}
                      sx={{ ml: 1 }}
                    />
                  ) : null}
                  {onRefreshServers && !remoteProjectServer && (
                    <Button
                      variant="outlined"
                      disabled={busy}
                      onClick={() => void setEnabled(selectedServer.enabled === false)}
                    >
                      {selectedServer.enabled === false ? resourceUi.enable : resourceUi.disable}
                    </Button>
                  )}
                </Box>
                {(selectedServer.userStdio || (selectedServer.managed && selectedServer.url)) &&
                  onRemoveServer && (
                    <Button
                      color="error"
                      variant="outlined"
                      disabled={busy}
                      onClick={() => {
                        if (selectedServer.userStdio) {
                          setRemoveConfirmationServerId(selectedServer.id)
                        } else void remove()
                      }}
                    >
                      {resourceUi.remove}
                    </Button>
                  )}
              </Stack>
              {selectedServer.userStdio && removeConfirmationServerId === selectedServer.id ? (
                <Alert
                  severity="warning"
                  sx={{ mt: 2 }}
                  action={
                    <Stack direction="row" spacing={1}>
                      <Button disabled={busy} onClick={() => setRemoveConfirmationServerId(null)}>
                        {resourceUi.cancel}
                      </Button>
                      <Button color="error" disabled={busy} onClick={() => void remove()}>
                        {connectorCopy.confirmRemove}
                      </Button>
                    </Stack>
                  }
                >
                  {connectorCopy.removeLocalConfirm}
                </Alert>
              ) : null}
              <Divider sx={{ my: 4 }} />
              <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
                {selectedServer.url ? connectorCopy.mcpUrl : connectorCopy.command}
              </Typography>
              <Typography
                component="code"
                sx={{ display: 'block', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
              >
                {selectedServer.url ||
                  commandLine(selectedServer) ||
                  connectorCopy.commandNotConfigured}
              </Typography>
              {selectedServer.envKeys?.length ? (
                <Stack direction="row" spacing={1} sx={{ mt: 3, flexWrap: 'wrap' }}>
                  {selectedServer.envKeys.map((key) => (
                    <Chip key={key} size="small" variant="outlined" label={key} />
                  ))}
                </Stack>
              ) : null}
            </>
          )}
          {remoteProjectServer ? (
            <RemoteProjectMcpTrustPanel server={remoteProjectServer} onChanged={onRefreshServers} />
          ) : null}
          {error && (
            <Alert severity="error" sx={{ mt: 3 }}>
              {error}
            </Alert>
          )}
        </Box>
      ) : (
        <Stack spacing={1} sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
          <PhiIcons.entity.mcp color="disabled" />
          <Typography color="text.secondary">{connectorCopy.noServer}</Typography>
        </Stack>
      )}
      <McpApiKeyDialog
        connector={apiKeyDialogOpen && connector?.apiKey ? connector : null}
        value={apiKeyInput}
        verified={authStatus === 'authenticated'}
        installed={Boolean(selectedServer)}
        busy={busy}
        error={apiKeyError}
        onChange={setApiKeyInput}
        onClose={() => {
          setApiKeyDialogOpen(false)
          setApiKeyInput('')
          setApiKeyError(null)
        }}
        onSubmit={() => void replaceApiKey()}
      />
    </Box>
  )
}
