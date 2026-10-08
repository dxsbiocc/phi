import { Box, Chip, CircularProgress, IconButton, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoCheck, GoKey, GoLock, GoPlay, GoPlus, GoSync } from 'react-icons/go'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { ConnectorIcon } from './ConnectorIcon'

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
  onAdd: () => void
  onAuthorize: () => void
  onCancel?: () => void
  onEnable?: () => void
  onBuildEnvironment?: () => void
}): React.JSX.Element {
  const requiresSignIn = connector.signIn !== '无需登录' && connector.signIn !== '本地服务'
  const supportsAuthorization = Boolean(connector.oauthAuthorizationOrigin || connector.apiKey)
  const authorized = !requiresSignIn || (supportsAuthorization && authStatus === 'authenticated')
  const needsEnvironment = connector.environmentState === 'not-built'
  const loginLabel = !requiresSignIn
    ? null
    : !supportsAuthorization
      ? installed
        ? '已配置 · 授权未验证'
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
              ? installed
                ? '已配置 · 状态不可用'
                : '状态不可用'
              : connector.apiKey
                ? installed
                  ? '已配置 · API key 未验证'
                  : '需填写 API key'
                : installed
                  ? '已配置 · 需登录'
                  : '需登录'
  const actionLabel = authorizing
    ? `取消授权 ${connector.name}`
    : updateAvailable
      ? `更新 ${connector.name}`
      : needsEnvironment
        ? `构建 ${connector.name} 环境`
        : installed && authorized && !enabled
          ? `启用 ${connector.name}`
          : authorized
            ? `添加 ${connector.name}`
            : connector.apiKey
              ? installed
                ? `验证 API key ${connector.name}`
                : `配置 ${connector.name}`
              : `授权登录 ${connector.name}`

  return (
    <Box
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen()
        }
      }}
      onClick={onOpen}
      data-phi-connector-configured={installed}
      sx={{
        minWidth: 0,
        minHeight: 108,
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
        <Typography noWrap title={connector.name} sx={{ fontWeight: 700 }}>
          {connector.name}
        </Typography>
        <Typography
          noWrap
          title={connector.description}
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.25 }}
        >
          {connector.description}
        </Typography>
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
            <Chip size="small" variant="outlined" label="已停用" />
          )}
          {connector.unavailableReason && (
            <Chip size="small" variant="outlined" label="需要新版 Phi" />
          )}
          {needsEnvironment && <Chip size="small" variant="outlined" label="环境未构建" />}
        </Stack>
      </Box>
      {installed &&
      authorized &&
      enabled &&
      !authorizing &&
      !updateAvailable &&
      !needsEnvironment ? (
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
      ) : requiresSignIn && !supportsAuthorization && !authorizing ? (
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
          aria-label={actionLabel}
          title={actionLabel}
          size="small"
          disabled={!authorizing && (Boolean(connector.unavailableReason) || busy)}
          onClick={(event) => {
            event.stopPropagation()
            if (authorizing) onCancel?.()
            else if (needsEnvironment) onBuildEnvironment?.()
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
            <CircularProgress size={18} color="inherit" aria-label="等待授权" />
          ) : updateAvailable ? (
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
      )}
    </Box>
  )
}
