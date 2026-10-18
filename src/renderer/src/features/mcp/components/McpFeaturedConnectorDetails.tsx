import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { resourceCategoryLabel } from '../../../lib/resourceUi'
import { connectorCopy, connectorSignInLabel } from '../lib/connectorCopy'
import { Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../../../types'
import { ConnectorIcon } from './ConnectorIcon'
import type { ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpToolList } from './McpToolList'
import { McpConnectorSetupStatus } from './McpConnectorSetupStatus'
import { localConnectorToolsPrerequisite } from '../lib/connectorSetupPresentation'
import { McpConnectorSourceBadges } from './McpConnectorSourceBadges'

export function McpFeaturedConnectorDetails({
  connector,
  server,
  authStatus,
  busy,
  toolNames,
  toolsLoading,
  toolsError,
  iconSize = 48,
  onAdd,
  onRemove,
  onAuthorize,
  onCancelAuthorize,
  authorizing = false,
  updateAvailable = false,
  onApiKey,
  onBuildEnvironment,
  onEnabledChange,
  onRetry
}: {
  connector: FeaturedMcpConnector
  server?: McpServerSummary
  authStatus: ConnectorAuthStatus
  busy: boolean
  toolNames: string[] | null
  toolsLoading: boolean
  toolsError: string | null
  iconSize?: number
  onAdd: () => void
  onRemove?: () => void
  onAuthorize: () => void
  onCancelAuthorize?: () => void
  authorizing?: boolean
  updateAvailable?: boolean
  onApiKey: () => void
  onBuildEnvironment?: () => void
  onEnabledChange?: (enabled: boolean) => void
  onRetry: () => void
}): React.JSX.Element {
  useUiLanguage()

  const localPrerequisite = localConnectorToolsPrerequisite(connector)
  const removeButton =
    server?.managed && onRemove ? (
      <Button color="error" variant="outlined" disabled={busy} onClick={onRemove}>
        {resourceUi.remove}
      </Button>
    ) : null
  let actions: React.JSX.Element
  if (connector.unavailableReason && !server) {
    // Catalog restrictions stop a new install; already configured connectors remain usable.
    actions = (
      <Button variant="outlined" disabled title={connector.unavailableReason}>
        {connector.unavailableKind === 'authorization'
          ? connectorCopy.authorizationUnavailable
          : connectorCopy.newerPhiRequired}
      </Button>
    )
  } else if (connector.environmentState === 'not-built') {
    actions = (
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy} onClick={onBuildEnvironment}>
          {connectorCopy.buildEnvironment}
        </Button>
        {removeButton}
      </Stack>
    )
  } else if (updateAvailable) {
    actions = (
      <Stack direction="row" spacing={1}>
        {connector.unavailableReason ? (
          <Button variant="outlined" disabled title={connector.unavailableReason}>
            {connector.unavailableKind === 'authorization'
              ? connectorCopy.authorizationUnavailable
              : connectorCopy.updateNewerPhiRequired}
          </Button>
        ) : (
          <Button variant="contained" disabled={busy} onClick={onAdd}>
            {resourceUi.update}
          </Button>
        )}
        {removeButton}
      </Stack>
    )
  } else if (
    connector.transport === 'stdio' &&
    connector.setup?.phase === 'failed' &&
    connector.added
  ) {
    actions = (
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy} onClick={onRetry}>
          {connectorCopy.retryConnection}
        </Button>
        {removeButton}
      </Stack>
    )
  } else if (connector.apiKey) {
    actions = (
      <Stack direction="row" spacing={1}>
        <Button variant={server ? 'outlined' : 'contained'} disabled={busy} onClick={onApiKey}>
          {server
            ? authStatus === 'authenticated'
              ? connectorCopy.replaceKey
              : connectorCopy.verifyApiKey
            : connectorCopy.addConnector}
        </Button>
        {removeButton}
      </Stack>
    )
  } else if (connector.oauthAuthorizationOrigin) {
    actions = (
      <Stack direction="row" spacing={1}>
        {authorizing ? (
          <Button variant="contained" onClick={onCancelAuthorize}>
            {connectorCopy.cancelAuthorization}
          </Button>
        ) : authStatus === 'authenticated' && !server ? (
          <Button variant="contained" disabled={busy} onClick={onAdd}>
            {connectorCopy.addConnector}
          </Button>
        ) : (
          <Button variant="contained" disabled={busy} onClick={onAuthorize}>
            {authStatus === 'authenticated'
              ? connectorCopy.reauthorize
              : connectorCopy.authorizeSignIn}
          </Button>
        )}
        {removeButton}
      </Stack>
    )
  } else if (removeButton) {
    actions = removeButton
  } else if (connector.signIn === '需要登录' && !server) {
    actions = (
      <Button variant="outlined" disabled>
        {connectorCopy.signInUnavailable}
      </Button>
    )
  } else {
    actions = (
      <Button variant="contained" disabled={Boolean(server) || busy} onClick={onAdd}>
        {server ? connectorCopy.configured : connectorCopy.addConnector}
      </Button>
    )
  }

  return (
    <>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: 'center', mb: 4 }}
      >
        <ConnectorIcon icon={server?.icon ?? connector.icon} size={iconSize} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {connector.name}
          </Typography>
          <Typography color="text.secondary">{connector.description}</Typography>
          {connector.source && (
            <Box sx={{ mt: 1 }}>
              <McpConnectorSourceBadges connector={connector} />
            </Box>
          )}
          {server && (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Chip size="small" variant="outlined" label={connectorCopy.configured} />
              <Chip
                size="small"
                variant="outlined"
                label={server.enabled === false ? resourceUi.disabled : resourceUi.enabled}
              />
            </Stack>
          )}
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {server && onEnabledChange && (
            <Button
              variant={server.enabled === false ? 'contained' : 'outlined'}
              disabled={
                busy ||
                authorizing ||
                (server.enabled === false &&
                  (connector.environmentState === 'not-built' ||
                    ((connector.apiKey || connector.signIn === '需要登录') &&
                      authStatus !== 'authenticated')))
              }
              onClick={() => onEnabledChange(server.enabled === false)}
            >
              {server.enabled === false ? resourceUi.enable : resourceUi.disable}
            </Button>
          )}
          {actions}
        </Stack>
      </Stack>
      {connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {connector.id === 'gmail'
            ? connectorCopy.gmailAuthUnavailable
            : connector.id === 'slack'
              ? connectorCopy.slackAuthUnavailable
              : connectorCopy.oauthUnavailable}
        </Alert>
      )}
      {connector.id === 'composio' && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {connectorCopy.composioAuthHint}
        </Alert>
      )}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
          {connectorCopy.serviceOverview}
        </Typography>
        <Typography color="text.secondary">
          {connector.overview ?? connector.description}
        </Typography>
      </Box>
      {connector.apiKey && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {authStatus === 'authenticated'
            ? server
              ? connectorCopy.verifiedKeyReplaceHint
              : connectorCopy.verifiedKeyAddHint
            : authStatus === 'checking'
              ? connectorCopy.checkingKey
              : authStatus === 'unavailable'
                ? connectorCopy.keyStatusUnavailable
                : server
                  ? connectorCopy.unverifiedKeyHint
                  : connectorCopy.keyNeededHint}
        </Alert>
      )}
      <McpConnectorSetupStatus setup={connector.setup} />
      {connector.transport === 'stdio' && !connector.added && !connector.setup && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {connectorCopy.localStartHint}
        </Alert>
      )}
      <McpToolList
        requiresSignIn={
          Boolean(localPrerequisite) ||
          (connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin) ||
          Boolean(connector.oauthAuthorizationOrigin && authStatus !== 'authenticated') ||
          Boolean(connector.apiKey && authStatus !== 'authenticated')
        }
        signInMessage={
          localPrerequisite ??
          (connector.apiKey
            ? connectorCopy.toolsAfterKey
            : connector.oauthAuthorizationOrigin
              ? connectorCopy.toolsAfterSignIn
              : undefined)
        }
        loading={toolsLoading}
        names={toolNames}
        error={toolsError}
        onRetry={onRetry}
      />
      <Divider sx={{ mb: 3 }} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <Box>
          <Typography variant="overline" color="text.secondary">
            {connectorCopy.publisher}
          </Typography>
          <Typography>{connector.publisher}</Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            {connector.transport === 'stdio' ? connectorCopy.launchCommand : connectorCopy.mcpUrl}
          </Typography>
          <Typography sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
            {connector.url ??
              [connector.command, ...(connector.args ?? [])].filter(Boolean).join(' ')}
          </Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            {connectorCopy.category}
          </Typography>
          <Typography>{resourceCategoryLabel(connector.category)}</Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            {connectorCopy.signIn}
          </Typography>
          <Typography>
            {connector.apiKey && authStatus === 'authenticated'
              ? connectorCopy.apiKeyVerified
              : connector.apiKey
                ? authStatus === 'checking'
                  ? connectorCopy.checking
                  : authStatus === 'unavailable'
                    ? connectorCopy.statusUnavailable
                    : connectorCopy.apiKeyUnverified
                : authorizing
                  ? connectorCopy.waitingAuthorization
                  : connector.oauthAuthorizationOrigin && authStatus === 'authenticated'
                    ? connectorCopy.signedIn
                    : connectorSignInLabel(connector.signIn)}
          </Typography>
        </Box>
        {server?.sourcePath && (
          <Box>
            <Typography variant="overline" color="text.secondary">
              {connectorCopy.configurationLocation}
            </Typography>
            <Typography sx={{ overflowWrap: 'anywhere' }}>{server.sourcePath}</Typography>
          </Box>
        )}
        {connector.homepageUrl && (
          <Box>
            <Typography variant="overline" color="text.secondary">
              {connectorCopy.moreInformation}
            </Typography>
            <Button
              component="a"
              href={connector.homepageUrl}
              target="_blank"
              rel="noreferrer"
              size="small"
              sx={{ pl: 0 }}
            >
              {connectorCopy.connectorDocs}
            </Button>
          </Box>
        )}
      </Box>
    </>
  )
}
