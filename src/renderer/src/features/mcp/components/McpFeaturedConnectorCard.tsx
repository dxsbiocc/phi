import { Box, Chip, IconButton, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoCheck, GoLock, GoPlus } from 'react-icons/go'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { ConnectorIcon } from './ConnectorIcon'

export type ConnectorAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'

export function McpFeaturedConnectorCard({
  connector,
  installed,
  authStatus,
  busy,
  authorizing = false,
  onOpen,
  onAdd,
  onAuthorize,
  onCancel
}: {
  connector: FeaturedMcpConnector
  installed: boolean
  authStatus: ConnectorAuthStatus
  busy: boolean
  authorizing?: boolean
  onOpen: () => void
  onAdd: () => void
  onAuthorize: () => void
  onCancel?: () => void
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
      : authorizing
        ? '等待授权'
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
          data-phi-connector-state="added"
          sx={{
            width: 34,
            height: 34,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            borderRadius: 1.5,
            color: 'success.dark',
            bgcolor: (theme) =>
              alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.28 : 0.16)
          }}
        >
          <GoCheck size={20} aria-hidden="true" />
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
            authorizing
              ? `取消授权 ${connector.name}`
              : authorized
                ? `添加 ${connector.name}`
                : connector.apiKey
                  ? `配置 ${connector.name}`
                  : `授权登录 ${connector.name}`
          }
          size="small"
          disabled={!authorizing && busy}
          onClick={(event) => {
            event.stopPropagation()
            if (authorizing) onCancel?.()
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
            borderRadius: 1.5
          }}
        >
          <GoPlus size={18} aria-hidden="true" />
        </IconButton>
      )}
    </Box>
  )
}
