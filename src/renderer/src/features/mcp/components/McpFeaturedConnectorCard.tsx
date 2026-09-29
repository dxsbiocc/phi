import { Box, Chip, IconButton, Stack, Typography } from '@mui/material'
import { GoCheck, GoLock, GoPlus } from 'react-icons/go'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { ConnectorIcon } from './ConnectorIcon'

export type ConnectorAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'

export function McpFeaturedConnectorCard({
  connector,
  installed,
  authStatus,
  busy,
  onOpen,
  onAdd,
  onAuthorize
}: {
  connector: FeaturedMcpConnector
  installed: boolean
  authStatus: ConnectorAuthStatus
  busy: boolean
  onOpen: () => void
  onAdd: () => void
  onAuthorize: () => void
}): React.JSX.Element {
  const requiresSignIn = connector.signIn !== '无需登录'
  const supportsAuthorization = Boolean(connector.oauthAuthorizationOrigin || connector.apiKey)
  const authorized = !requiresSignIn || (supportsAuthorization && authStatus === 'authenticated')
  const loginLabel = !requiresSignIn
    ? null
    : !supportsAuthorization
      ? installed
        ? '授权未验证'
        : '授权暂不可用'
      : authStatus === 'authenticated'
        ? connector.apiKey
          ? '已验证'
          : '已登录'
        : authStatus === 'checking'
          ? '检查中'
          : authStatus === 'unavailable'
            ? '状态不可用'
            : connector.apiKey
              ? '需填写 API key'
              : '需登录'

  return (
    <Box
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      onClick={onOpen}
      sx={{
        minWidth: 0,
        p: 1.75,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <ConnectorIcon connectorId={connector.id} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 700 }}>{connector.name}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {connector.description}
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">
            {connector.publisher}
          </Typography>
          {loginLabel && (
            <Chip
              size="small"
              variant="outlined"
              color={!supportsAuthorization ? 'warning' : 'default'}
              label={loginLabel}
            />
          )}
        </Stack>
      </Box>
      {installed && authorized ? (
        <Box
          role="img"
          aria-label={`已添加 ${connector.name}`}
          sx={{ width: 34, height: 34, display: 'grid', placeItems: 'center', flexShrink: 0 }}
        >
          <GoCheck size={21} aria-hidden="true" />
        </Box>
      ) : requiresSignIn && !supportsAuthorization ? (
        <Box
          role="img"
          aria-label={
            installed ? `已配置但未验证授权 ${connector.name}` : `暂不能授权 ${connector.name}`
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
          aria-label={
            authorized
              ? `添加 ${connector.name}`
              : connector.apiKey
                ? `配置 ${connector.name}`
                : `授权登录 ${connector.name}`
          }
          size="small"
          disabled={busy || (requiresSignIn && !connector.apiKey && authStatus === 'checking')}
          onClick={(event) => {
            event.stopPropagation()
            if (authorized) onAdd()
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
            borderRadius: 1.5
          }}
        >
          {authorized || connector.apiKey ? (
            <GoPlus size={18} aria-hidden="true" />
          ) : (
            <GoLock size={18} aria-hidden="true" />
          )}
        </IconButton>
      )}
    </Box>
  )
}
