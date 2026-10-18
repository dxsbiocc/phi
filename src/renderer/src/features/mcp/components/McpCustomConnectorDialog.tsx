import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import { useEffect, useId, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Tab,
  Tabs,
  TextField
} from '@mui/material'
import type {
  LocalMcpConnectorRequest,
  RemoteMcpConnectorOptions
} from '../../../../../shared/mcpConnectorCatalog'
import { PhiIcons } from '../../../icons'
import {
  buildLocalConnectorRequest,
  draftToFormState,
  emptyLocalConnectorDraft,
  localConnectorDraftError,
  type LocalConnectorDraft,
  type LocalConnectorInitialDraft
} from '../lib/localConnectorDraft'
import { resolveCustomConnectorTab, type ConnectorTab } from '../lib/customConnectorTabs'
import { McpLocalConnectConfirmDialog } from './McpLocalConnectConfirmDialog'
import { McpLocalConnectorForm, type LocalMcpRuntimeOption } from './McpLocalConnectorForm'

export interface McpCustomConnectorDialogProps {
  open: boolean
  busy: boolean
  authorizing?: boolean
  error: string | null
  localAvailable?: boolean
  initialDraft?: LocalConnectorInitialDraft
  onClose: () => void
  onSubmit: (name: string, url: string, options?: RemoteMcpConnectorOptions) => void
  onSubmitLocal?: (request: LocalMcpConnectorRequest) => void | Promise<void>
}

export function McpCustomConnectorDialog({
  open,
  busy,
  authorizing = false,
  error,
  localAvailable = true,
  initialDraft,
  onClose,
  onSubmit,
  onSubmitLocal
}: McpCustomConnectorDialogProps): React.JSX.Element {
  useUiLanguage()

  const [tab, setTab] = useState<ConnectorTab>(initialDraft?.tab ?? 'remote')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [localDraft, setLocalDraft] = useState<LocalConnectorDraft>(() =>
    initialDraft ? draftToFormState(initialDraft, []) : emptyLocalConnectorDraft()
  )
  const [localConfirmRequest, setLocalConfirmRequest] = useState<LocalMcpConnectorRequest | null>(
    null
  )
  const [localSubmitting, setLocalSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [runtimes, setRuntimes] = useState<LocalMcpRuntimeOption[]>([])
  const [runtimesLoading, setRuntimesLoading] = useState(localAvailable)
  const authenticationId = useId()
  const missingClientId = Boolean(clientSecret.trim() && !clientId.trim())
  const remoteCanSubmit = Boolean(name.trim() && url.trim() && !missingClientId)
  const localCanSubmit = localConnectorDraftError(localDraft) === null

  useEffect(() => {
    if (!open || !localAvailable) return undefined
    let active = true
    void window.api
      .listLocalMcpRuntimes()
      .then((entries) => {
        if (!active) return
        setRuntimes(entries)
        setLocalDraft((current) => {
          if (initialDraft) {
            return { ...current, runtime: draftToFormState(initialDraft, entries).runtime }
          }
          return current.runtime.kind === 'environment' && !current.runtime.ref && entries[0]
            ? { ...current, runtime: { kind: 'environment', ref: entries[0].ref } }
            : current
        })
      })
      .catch((cause: unknown) => {
        if (active) setLocalError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setRuntimesLoading(false)
      })
    return () => {
      active = false
    }
  }, [initialDraft, localAvailable, open])
  function submitRemote(): void {
    if (!remoteCanSubmit || busy) return
    const oauth = {
      ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {})
    }
    onSubmit(name.trim(), url.trim(), Object.keys(oauth).length ? { oauth } : undefined)
  }
  function submitLocal(): void {
    if (busy || !onSubmitLocal) return
    setLocalError(null)
    try {
      const request = buildLocalConnectorRequest(localDraft)
      setLocalConfirmRequest(request)
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  async function confirmLocal(): Promise<void> {
    if (!localConfirmRequest || localSubmitting || !onSubmitLocal) return
    setLocalSubmitting(true)
    try {
      await onSubmitLocal(localConfirmRequest)
    } finally {
      setLocalSubmitting(false)
      setLocalConfirmRequest(null)
    }
  }

  function cancelLocalConfirm(): void {
    if (!localSubmitting) setLocalConfirmRequest(null)
  }

  function updateLocalDraft(next: LocalConnectorDraft): void {
    setLocalDraft(next)
    setLocalConfirmRequest(null)
    setLocalError(null)
  }

  const resolvedTab = resolveCustomConnectorTab(tab, localAvailable)
  const localTab = resolvedTab === 'local'
  const currentError = localTab ? (localError ?? error) : error

  return (
    <Dialog
      open={open}
      onClose={busy && !authorizing ? undefined : onClose}
      maxWidth={localTab ? 'sm' : 'xs'}
      fullWidth
    >
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault()
          if (localTab) submitLocal()
          else submitRemote()
        }}
      >
        <DialogTitle>{connectorCopy.addCustomConnector}</DialogTitle>
        <Tabs
          value={resolvedTab}
          onChange={(_event, value: ConnectorTab) => {
            setTab(resolveCustomConnectorTab(value, localAvailable))
            setLocalConfirmRequest(null)
            setLocalError(null)
          }}
          aria-label={connectorCopy.connectorType}
          sx={{ px: 3 }}
        >
          <Tab value="remote" label={connectorCopy.remoteHttps} disabled={busy} />
          {localAvailable ? (
            <Tab value="local" label={connectorCopy.localStdio} disabled={busy} />
          ) : null}
        </Tabs>
        <DialogContent>
          {localTab ? (
            <McpLocalConnectorForm
              busy={busy}
              runtimes={runtimes}
              runtimesLoading={runtimesLoading}
              draft={localDraft}
              onDraftChange={updateLocalDraft}
              runtimeHelperText={
                initialDraft &&
                !runtimesLoading &&
                localDraft.runtime.kind === 'environment' &&
                !localDraft.runtime.ref
                  ? initialDraft.runtimeHint === 'bun'
                    ? connectorCopy.bunMissing
                    : connectorCopy.chooseReadyRuntime
                  : undefined
              }
            />
          ) : (
            <>
              <TextField
                autoFocus
                disabled={busy}
                fullWidth
                label={resourceUi.name}
                value={name}
                onChange={(event) => setName(event.target.value)}
                helperText={connectorCopy.remoteNameHint}
                sx={{ mt: 1, mb: 2 }}
              />
              <TextField
                fullWidth
                disabled={busy}
                label={connectorCopy.serverUrl}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/mcp"
              />
              <Button
                type="button"
                disabled={busy}
                aria-expanded={advancedOpen}
                aria-controls={authenticationId}
                onClick={() => setAdvancedOpen((value) => !value)}
                startIcon={
                  <Box
                    sx={{ display: 'flex', transform: advancedOpen ? 'rotate(180deg)' : undefined }}
                  >
                    <PhiIcons.action.expand size={16} />
                  </Box>
                }
                sx={{ mt: 2, mb: advancedOpen ? 1 : 0, color: 'text.primary' }}
              >
                {connectorCopy.advancedSettings}
              </Button>
              <Collapse in={advancedOpen} id={authenticationId}>
                <TextField
                  fullWidth
                  disabled={busy}
                  label={connectorCopy.optionalClientId}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  autoComplete="off"
                  error={missingClientId}
                  helperText={missingClientId ? connectorCopy.clientIdRequired : undefined}
                  sx={{ mt: 1, mb: 2 }}
                />
                <TextField
                  fullWidth
                  disabled={busy}
                  label={connectorCopy.optionalClientSecret}
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  autoComplete="new-password"
                />
              </Collapse>
            </>
          )}
          {currentError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {currentError}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button type="button" onClick={onClose} disabled={busy && !authorizing}>
            {authorizing ? connectorCopy.cancelAuthorization : resourceUi.cancel}
          </Button>
          <Button
            variant="contained"
            type="submit"
            disabled={
              busy ||
              (localTab ? !localCanSubmit || runtimesLoading || !onSubmitLocal : !remoteCanSubmit)
            }
          >
            {localTab
              ? busy
                ? connectorCopy.starting
                : connectorCopy.add
              : authorizing
                ? connectorCopy.authorizing
                : busy
                  ? connectorCopy.adding
                  : connectorCopy.add}
          </Button>
        </DialogActions>
      </Box>
      {localConfirmRequest ? (
        <McpLocalConnectConfirmDialog
          open
          submitting={localSubmitting}
          request={localConfirmRequest}
          runtimes={runtimes}
          onCancel={cancelLocalConfirm}
          onConfirm={() => void confirmLocal()}
        />
      ) : null}
    </Dialog>
  )
}
