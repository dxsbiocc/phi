import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import { Box, Chip, CircularProgress, IconButton, Stack, Typography } from '@mui/material'
import { GoKey, GoLock, GoPlay, GoPlus, GoSync } from 'react-icons/go'
import { ConnectorAddedMark, ConnectorCatalogCardFrame } from './ConnectorCatalogCardFrame'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { ConnectorIcon } from './ConnectorIcon'
import { connectorSetupActive, connectorSetupLabel } from '../lib/connectorSetupPresentation'
import { McpConnectorSourceBadges } from './McpConnectorSourceBadges'

export type ConnectorAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'

export function McpFeaturedConnectorCard({
  connector,
  installed,
  enabled = true,
  updateAvailable = false,
  authStatus,
  busy,
  authorizing = false,
  onOpen,
  onRetry,
  onAdd,
  onAuthorize,
  onCancel,
  onEnable,
  onBuildEnvironment
}: {
  connector: FeaturedMcpConnector
  installed: boolean
  enabled?: boolean
  updateAvailable?: boolean
  authStatus: ConnectorAuthStatus
  busy: boolean
  authorizing?: boolean
  onOpen: () => void
  onRetry?: () => void
  onAdd: () => void
  onAuthorize: () => void
  onCancel?: () => void
  onEnable?: () => void
  onBuildEnvironment?: () => void
}): React.JSX.Element {
  useUiLanguage()

  const requiresSignIn = connector.signIn !== '无需登录' && connector.signIn !== '本地服务'
  const supportsAuthorization = Boolean(connector.oauthAuthorizationOrigin || connector.apiKey)
  const authorized = !requiresSignIn || (supportsAuthorization && authStatus === 'authenticated')
  const needsEnvironment = connector.environmentState === 'not-built'
  const settingUp = connectorSetupActive(connector.setup)
  const localUnchecked =
    connector.transport === 'stdio' && installed && connector.setup?.phase !== 'ready'
  const loginLabel = !requiresSignIn
    ? null
    : !supportsAuthorization
      ? installed
        ? connectorCopy.configuredAuthUnverified
        : connectorCopy.authorizationUnavailable
      : authorizing
        ? connectorCopy.waitingAuthorization
        : authStatus === 'authenticated'
          ? connector.apiKey
            ? connectorCopy.verified
            : connectorCopy.signedIn
          : authStatus === 'checking'
            ? connectorCopy.checking
            : authStatus === 'unavailable'
              ? installed
                ? connectorCopy.configuredStatusUnavailable
                : connectorCopy.statusUnavailable
              : connector.apiKey
                ? installed
                  ? connectorCopy.configuredKeyUnverified
                  : connectorCopy.apiKeyRequired
                : installed
                  ? connectorCopy.configuredSignInRequired
                  : connectorCopy.signInRequired
  const actionLabel =
    localUnchecked && !needsEnvironment
      ? connectorCopy.checkNamedConnection(connector.name, connector.setup?.phase === 'failed')
      : authorizing
        ? connectorCopy.cancelAuthorizationNamed(connector.name)
        : updateAvailable
          ? connectorCopy.updateNamed(connector.name)
          : needsEnvironment
            ? connectorCopy.buildNamedEnvironment(connector.name)
            : installed && authorized && !enabled
              ? connectorCopy.enableNamed(connector.name)
              : authorized
                ? connectorCopy.addNamed(connector.name)
                : connector.apiKey
                  ? installed
                    ? connectorCopy.verifyNamedKey(connector.name)
                    : connectorCopy.configureNamed(connector.name)
                  : connectorCopy.signInNamed(connector.name)

  return (
    <ConnectorCatalogCardFrame
      icon={<ConnectorIcon icon={connector.icon} />}
      title={connector.name}
      description={connector.description}
      onOpen={onOpen}
      configured={installed}
      trailing={
        settingUp ? (
          <Box
            role="status"
            aria-label={connectorSetupLabel(connector.setup!.phase)}
            sx={{ width: 34, height: 34, display: 'grid', placeItems: 'center', flexShrink: 0 }}
          >
            <CircularProgress size={18} />
          </Box>
        ) : installed &&
          authorized &&
          enabled &&
          !authorizing &&
          !updateAvailable &&
          !localUnchecked &&
          !needsEnvironment ? (
          <ConnectorAddedMark label={connectorCopy.addedNamed(connector.name)} />
        ) : requiresSignIn && !supportsAuthorization && !authorizing ? (
          <Box
            role="img"
            aria-label={
              installed
                ? connectorCopy.unverifiedNamedAuthorization(connector.name)
                : connectorCopy.unavailableNamedAuthorization(connector.name)
            }
            sx={{
              width: 34,
              height: 34,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              color: 'warning.main'
            }}
          >
            <GoLock size={20} aria-hidden="true" />
          </Box>
        ) : (
          <IconButton
            aria-label={actionLabel}
            title={actionLabel}
            size="small"
            disabled={
              !authorizing &&
              ((Boolean(connector.unavailableReason) && (!installed || updateAvailable)) || busy)
            }
            onClick={(event) => {
              event.stopPropagation()
              if (authorizing) onCancel?.()
              else if (needsEnvironment) onBuildEnvironment?.()
              else if (localUnchecked) onRetry?.()
              else if (installed && authorized && !enabled && !updateAvailable) onEnable?.()
              else if (authorized) onAdd()
              else onAuthorize()
            }}
            sx={{
              width: 34,
              height: 34,
              p: 0,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1.5,
              color: authorizing
                ? 'primary.main'
                : installed && !authorized
                  ? 'warning.main'
                  : installed && authorized && !enabled
                    ? 'primary.main'
                    : undefined
            }}
          >
            {authorizing ? (
              <CircularProgress
                size={18}
                color="inherit"
                aria-label={connectorCopy.waitingAuthorization}
              />
            ) : updateAvailable || localUnchecked ? (
              <GoSync size={18} aria-hidden="true" />
            ) : installed && authorized && !enabled ? (
              <GoPlay size={18} aria-hidden="true" />
            ) : installed && !authorized ? (
              connector.apiKey ? (
                <GoKey size={18} aria-hidden="true" />
              ) : (
                <GoLock size={18} aria-hidden="true" />
              )
            ) : (
              <GoPlus size={18} aria-hidden="true" />
            )}
          </IconButton>
        )
      }
    >
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          mt: 0.75,
          minWidth: 0,
          minHeight: 24,
          alignItems: 'center',
          '& .MuiChip-root': { minWidth: 0, flexShrink: 0 }
        }}
      >
        <Typography
          noWrap
          title={connector.publisher}
          variant="caption"
          color="text.secondary"
          sx={{ minWidth: 0 }}
        >
          {connector.publisher}
        </Typography>
        {loginLabel && (
          <Chip
            size="small"
            variant="outlined"
            color={!supportsAuthorization || (installed && !authorized) ? 'warning' : 'default'}
            label={loginLabel}
          />
        )}
        {installed && authorized && !enabled && (
          <Chip size="small" variant="outlined" label={resourceUi.disabled} />
        )}
        {connector.unavailableReason &&
          (!installed || updateAvailable) &&
          (connector.unavailableKind !== 'authorization' ||
            loginLabel !== connectorCopy.authorizationUnavailable) && (
            <Chip
              size="small"
              variant="outlined"
              label={
                connector.unavailableKind === 'authorization'
                  ? connectorCopy.authorizationUnavailable
                  : connectorCopy.newerPhiRequired
              }
            />
          )}
        {connector.transport === 'stdio' &&
          connector.setup &&
          connector.setup.phase !== 'removed' && (
            <Chip
              size="small"
              variant="outlined"
              color={connector.setup.phase === 'failed' ? 'error' : 'default'}
              label={connectorSetupLabel(connector.setup.phase)}
            />
          )}
        {needsEnvironment && !settingUp && (
          <Chip size="small" variant="outlined" label={connectorCopy.environmentNotBuilt} />
        )}
      </Stack>
      {connector.source && (
        <Box sx={{ mt: 0.75 }}>
          <McpConnectorSourceBadges connector={connector} />
        </Box>
      )}
    </ConnectorCatalogCardFrame>
  )
}
