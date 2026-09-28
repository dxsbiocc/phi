import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Link,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../icons'
import type { DbConnectorSettingsItem } from '../../types'

const RefreshIcon = PhiIcons.action.refresh

const protocolLabels: Record<DbConnectorSettingsItem['protocolFamily'], string> = {
  entrez: 'Entrez',
  'rest-json': 'REST',
  sparql: 'SPARQL',
  ontology: 'Ontology',
  'bulk-index': 'Bulk index',
  'generic-http': 'HTTP'
}

function apiKeyTooltip(auth: DbConnectorSettingsItem['auth']): string {
  if (!auth) return ''
  const name = auth.label ?? auth.envVar ?? 'API key'
  if (auth.required && !auth.configured) return `${name} 为必填，点击展开后配置。`
  if (auth.configuredFromEnv) return `${name} 已由环境变量 ${auth.envVar ?? ''} 提供。`
  if (auth.configuredInStore) return `${name} 已保存，点击展开可替换或清除。`
  return `${name} 可选，配置后可提高速率限制。`
}

function apiKeyChipColor(auth: DbConnectorSettingsItem['auth']): 'default' | 'error' | 'success' {
  if (!auth) return 'default'
  return auth.required ? 'error' : 'success'
}

export function DatabaseSettingsPanel({
  connectors,
  isLoading,
  updatingConnectorId,
  onRefresh,
  onSetEnabled,
  onSetApiKey,
  onClearApiKey
}: {
  connectors: DbConnectorSettingsItem[]
  isLoading: boolean
  updatingConnectorId: string | null
  onRefresh: () => Promise<void>
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>
  onSetApiKey: (id: string, apiKey: string) => Promise<void>
  onClearApiKey: (id: string) => Promise<void>
}): React.JSX.Element {
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({})
  const [savingKeyId, setSavingKeyId] = useState<string | null>(null)
  const [expandedConnectorId, setExpandedConnectorId] = useState<string | null>(null)
  const enabledCount = connectors.filter((connector) => connector.enabledForQuery).length
  const keyRequiredCount = connectors.filter(
    (connector) => connector.auth?.required && !connector.auth.configured
  ).length

  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          flexDirection: { xs: 'column', md: 'row' }
        }}
      >
        <Box>
          <Typography variant="h5">数据库</Typography>
          <Typography variant="body2" color="text.secondary">
            控制 Database agent 是否允许查询各个生物数据库，并为需要凭据的库配置 API key。
          </Typography>
        </Box>
        <Tooltip title="刷新数据库">
          <span>
            <IconButton
              aria-label="刷新数据库"
              disabled={isLoading}
              onClick={() => void onRefresh()}
              sx={{ width: 40, height: 40, color: 'text.secondary' }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Alert severity="info" variant="outlined">
        Database agent 可发现已安装数据库；关闭后仍可看说明但不会执行查询。API key
        使用系统加密存储，不会写入明文配置文件。
      </Alert>

      {isLoading && connectors.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          正在加载数据库...
        </Typography>
      ) : connectors.length === 0 ? (
        <Alert severity="warning" variant="outlined">
          没有找到已安装的数据库连接器。
        </Alert>
      ) : (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Chip size="small" label={`${connectors.length} 个数据库`} />
            <Chip
              size="small"
              color="success"
              variant="outlined"
              label={`${enabledCount} 个已启用`}
            />
            {keyRequiredCount > 0 ? (
              <Chip
                size="small"
                color="error"
                variant="outlined"
                label={`${keyRequiredCount} 个待配置 key`}
              />
            ) : null}
          </Stack>

          {connectors.map((connector) => {
            const updating = updatingConnectorId === connector.id || savingKeyId === connector.id
            const auth = connector.auth
            const draft = draftKeys[connector.id] ?? ''
            const expanded = expandedConnectorId === connector.id
            const toggleExpanded = (): void => {
              setExpandedConnectorId(expanded ? null : connector.id)
            }
            return (
              <Paper
                key={connector.id}
                variant="outlined"
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={toggleExpanded}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleExpanded()
                  }
                }}
                sx={{
                  p: 1.5,
                  borderRadius: 1.5,
                  cursor: 'pointer',
                  transition: 'border-color 120ms ease, background-color 120ms ease',
                  '&:hover': {
                    borderColor: 'primary.light',
                    bgcolor: 'action.hover'
                  },
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: 2
                  }
                }}
              >
                <Stack spacing={1.25}>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 2,
                      alignItems: { xs: 'flex-start', md: 'center' },
                      flexDirection: { xs: 'column', md: 'row' }
                    }}
                  >
                    <Stack spacing={0.7} sx={{ minWidth: 0, flex: 1 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}
                      >
                        <Typography variant="body1" sx={{ fontWeight: 700 }}>
                          {connector.name}
                        </Typography>
                        <Chip
                          size="small"
                          color={connector.protocolFamily === 'ontology' ? 'info' : 'default'}
                          variant="outlined"
                          label={protocolLabels[connector.protocolFamily]}
                        />
                        {auth ? (
                          <Tooltip title={apiKeyTooltip(auth)} arrow>
                            <Chip
                              size="small"
                              color={apiKeyChipColor(auth)}
                              variant="outlined"
                              label="API key"
                            />
                          </Tooltip>
                        ) : null}
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        {connector.domainCount} 个查询域
                      </Typography>
                    </Stack>

                    <Box
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      sx={{ alignSelf: { xs: 'stretch', md: 'center' } }}
                    >
                      <Tooltip
                        title={
                          connector.enabledForQuery
                            ? '已启用查询，点击可关闭'
                            : '已关闭查询，点击可启用'
                        }
                        arrow
                      >
                        <span>
                          <Switch
                            disabled={updating}
                            checked={connector.enabledForQuery}
                            slotProps={{
                              input: {
                                'aria-label': connector.enabledForQuery ? '关闭查询' : '启用查询'
                              }
                            }}
                            onChange={(event) => {
                              void onSetEnabled(connector.id, event.target.checked)
                            }}
                          />
                        </span>
                      </Tooltip>
                    </Box>
                  </Box>

                  <Collapse
                    in={expanded}
                    unmountOnExit
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Divider sx={{ my: 0.5 }} />
                    <Stack spacing={1.25} sx={{ pt: 1 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ flexWrap: 'wrap', rowGap: 0.75, alignItems: 'center' }}
                      >
                        <Chip size="small" variant="outlined" label={connector.id} />
                        <Chip
                          size="small"
                          variant="outlined"
                          label={connector.trustTier === 'bundled' ? '内置连接器' : '自定义连接器'}
                        />
                        <Chip
                          size="small"
                          variant="outlined"
                          label={protocolLabels[connector.protocolFamily]}
                        />
                      </Stack>

                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          查询域
                        </Typography>
                        <Stack
                          direction="row"
                          spacing={0.75}
                          sx={{ flexWrap: 'wrap', rowGap: 0.75, mt: 0.75 }}
                        >
                          {connector.domains.map((domain) => (
                            <Chip
                              key={domain.id}
                              size="small"
                              variant="outlined"
                              label={domain.id}
                              title={domain.summary}
                            />
                          ))}
                        </Stack>
                      </Box>

                      {auth ? (
                        <Stack spacing={1}>
                          <Typography variant="body2" color="text.secondary">
                            {auth.label ?? auth.envVar}
                            {auth.required ? '（查询前必须配置）' : '（可选，用于提高速率限制）'}
                            {auth.signupUrl ? (
                              <>
                                {' · '}
                                <Link href={auth.signupUrl} target="_blank" rel="noreferrer">
                                  申请 key
                                </Link>
                              </>
                            ) : null}
                          </Typography>
                          {!auth.storageAvailable ? (
                            <Alert severity="warning" variant="outlined">
                              当前系统无法使用加密存储，暂时不能在设置中保存 API key。可改用环境变量{' '}
                              <code>{auth.envVar}</code>。
                            </Alert>
                          ) : (
                            <Stack
                              direction={{ xs: 'column', sm: 'row' }}
                              spacing={1}
                              sx={{ alignItems: { sm: 'center' } }}
                            >
                              <TextField
                                size="small"
                                type="password"
                                fullWidth
                                disabled={updating}
                                placeholder={
                                  auth.configured ? '已保存（输入新值可覆盖）' : '粘贴 API key'
                                }
                                value={draft}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setDraftKeys((current) => ({
                                    ...current,
                                    [connector.id]: value
                                  }))
                                }}
                                autoComplete="off"
                              />
                              <Button
                                size="small"
                                variant="contained"
                                disabled={updating || !draft.trim()}
                                onClick={() => {
                                  void (async () => {
                                    setSavingKeyId(connector.id)
                                    try {
                                      await onSetApiKey(connector.id, draft.trim())
                                      setDraftKeys((current) => {
                                        const next = { ...current }
                                        delete next[connector.id]
                                        return next
                                      })
                                    } finally {
                                      setSavingKeyId(null)
                                    }
                                  })()
                                }}
                              >
                                保存
                              </Button>
                              <Button
                                size="small"
                                variant="outlined"
                                color="inherit"
                                disabled={updating || !auth.configuredInStore}
                                onClick={() => {
                                  void (async () => {
                                    setSavingKeyId(connector.id)
                                    try {
                                      await onClearApiKey(connector.id)
                                      setDraftKeys((current) => {
                                        const next = { ...current }
                                        delete next[connector.id]
                                        return next
                                      })
                                    } finally {
                                      setSavingKeyId(null)
                                    }
                                  })()
                                }}
                              >
                                清除
                              </Button>
                            </Stack>
                          )}
                        </Stack>
                      ) : null}
                    </Stack>
                  </Collapse>
                </Stack>
              </Paper>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
