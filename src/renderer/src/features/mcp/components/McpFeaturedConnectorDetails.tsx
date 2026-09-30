import { Alert, Box, Button, Divider, Stack, Typography } from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../../../types'
import { ConnectorIcon } from './ConnectorIcon'
import type { ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpToolList } from './McpToolList'

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
  onApiKey,
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
  onApiKey: () => void
  onRetry: () => void
}): React.JSX.Element {
  const removeButton =
    server?.managed && onRemove ? (
      <Button color="error" variant="outlined" disabled={busy} onClick={onRemove}>
        移除
      </Button>
    ) : null
  let actions: React.JSX.Element
  if (connector.apiKey) {
    actions = (
      <Stack direction="row" spacing={1}>
        <Button variant={server ? 'outlined' : 'contained'} disabled={busy} onClick={onApiKey}>
          {server ? '更换密钥' : '添加连接器'}
        </Button>
        {removeButton}
      </Stack>
    )
  } else if (connector.oauthAuthorizationOrigin) {
    actions = (
      <Stack direction="row" spacing={1}>
        {authorizing ? (
          <Button variant="contained" onClick={onCancelAuthorize}>
            取消授权
          </Button>
        ) : authStatus === 'authenticated' && !server ? (
          <Button variant="contained" disabled={busy} onClick={onAdd}>
            添加连接器
          </Button>
        ) : (
          <Button variant="contained" disabled={busy} onClick={onAuthorize}>
            {authStatus === 'authenticated' ? '重新授权' : '授权登录'}
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
        授权登录暂不可用
      </Button>
    )
  } else {
    actions = (
      <Button variant="contained" disabled={Boolean(server) || busy} onClick={onAdd}>
        {server ? '已配置' : '添加连接器'}
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
        <ConnectorIcon connectorId={connector.id} size={iconSize} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {connector.name}
          </Typography>
          <Typography color="text.secondary">{connector.description}</Typography>
        </Box>
        {actions}
      </Stack>
      {connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {connector.id === 'gmail'
            ? 'Gmail MCP 需要先在 Google Cloud 启用服务并为 Phi 配置 OAuth 客户端。Phi 目前尚未提供该配置，暂不能从目录授权或添加。'
            : connector.id === 'slack'
              ? 'Slack MCP 需要预先注册 Slack 应用并配置 OAuth 客户端。Phi 目前尚未提供该流程，暂不能从目录授权或添加。'
              : '此服务需要 OAuth 登录。Phi 尚未接入该授权流程，暂不能从目录添加使用。'}
        </Alert>
      )}
      {connector.id === 'composio' && (
        <Alert severity="info" sx={{ mb: 3 }}>
          登录 Composio 后，可在使用具体应用时逐个授权。第三方账号由 Composio 管理。
        </Alert>
      )}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
          服务介绍
        </Typography>
        <Typography color="text.secondary">{connector.overview}</Typography>
      </Box>
      {connector.apiKey && (
        <Alert severity="info" sx={{ mb: 3 }}>
          {authStatus === 'authenticated'
            ? 'API key 已通过验证并加密保存在本机。需要更换时，点击右上角的「更换密钥」。'
            : server
              ? 'API key 尚未通过验证。点击右上角的「更换密钥」重新验证。'
              : '此连接器需要 API key。点击右上角的「添加连接器」进行验证和保存。'}
        </Alert>
      )}
      <McpToolList
        requiresSignIn={
          (connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin) ||
          Boolean(connector.oauthAuthorizationOrigin && authStatus !== 'authenticated') ||
          Boolean(connector.apiKey && authStatus !== 'authenticated')
        }
        signInMessage={
          connector.apiKey
            ? '验证 API key 后可读取服务端工具。'
            : connector.oauthAuthorizationOrigin
              ? '登录后可读取服务端工具。'
              : undefined
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
            提供方
          </Typography>
          <Typography>{connector.publisher}</Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            MCP 地址
          </Typography>
          <Typography sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
            {connector.url}
          </Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            类别
          </Typography>
          <Typography>{connector.category}</Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            登录
          </Typography>
          <Typography>
            {connector.apiKey && authStatus === 'authenticated'
              ? 'API key 已验证'
              : authorizing
                ? '等待授权'
                : connector.oauthAuthorizationOrigin && authStatus === 'authenticated'
                  ? '已登录'
                  : connector.signIn}
          </Typography>
        </Box>
        {server?.sourcePath && (
          <Box>
            <Typography variant="overline" color="text.secondary">
              配置位置
            </Typography>
            <Typography sx={{ overflowWrap: 'anywhere' }}>{server.sourcePath}</Typography>
          </Box>
        )}
        <Box>
          <Typography variant="overline" color="text.secondary">
            更多信息
          </Typography>
          <Button
            component="a"
            href={connector.homepageUrl}
            target="_blank"
            rel="noreferrer"
            size="small"
            sx={{ pl: 0 }}
          >
            连接器说明 ↗
          </Button>
        </Box>
      </Box>
    </>
  )
}
