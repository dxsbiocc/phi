import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  IconButton,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { PhiIcons } from '../icons'
import type { ModelOption, ProviderAuthStatus } from '../types'
import type { PermissionMode, Project, ThinkingLevel, ToolApprovalRequest } from '../types'
import type { ThemeMode } from '../theme'
import { accentAt, ACCENT_PALETTE } from '../theme'
import { PermissionSettingsSection } from './PermissionView'

const AddIcon = PhiIcons.action.add
const CloseIcon = PhiIcons.action.close
const ContentCopyIcon = PhiIcons.action.copy
const KeyIcon = PhiIcons.entity.apiKey
const LogoutIcon = PhiIcons.action.logout
const PaletteIcon = PhiIcons.settings.appearance
const ProviderIcon = PhiIcons.settings.providers
const PsychologyIcon = PhiIcons.settings.persona
const ShieldIcon = PhiIcons.settings.permissions
const DiagnosticsIcon = PhiIcons.settings.diagnostics
const CheckIcon = PhiIcons.state.check

export type SettingsCategory =
  'persona' | 'providers' | 'permissions' | 'diagnostics' | 'appearance'

const CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: React.JSX.Element }> = [
  { id: 'persona', label: '助手人设', icon: <PsychologyIcon fontSize="small" /> },
  { id: 'providers', label: 'Provider 配置', icon: <ProviderIcon fontSize="small" /> },
  { id: 'permissions', label: '权限', icon: <ShieldIcon fontSize="small" /> },
  { id: 'diagnostics', label: '诊断', icon: <ContentCopyIcon fontSize="small" /> },
  { id: 'appearance', label: '外观', icon: <PaletteIcon fontSize="small" /> }
]

function CategoryIcon({
  index,
  selected,
  children
}: {
  index: number
  selected: boolean
  children: React.JSX.Element
}): React.JSX.Element {
  const accent = accentAt(index)
  return (
    <Box
      sx={{
        width: 32,
        height: 32,
        borderRadius: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        mr: 1.5,
        flexShrink: 0,
        bgcolor: selected ? 'rgba(255,255,255,0.22)' : `${accent}26`,
        color: selected ? '#FFFFFF' : accent
      }}
    >
      {children}
    </Box>
  )
}

function PersonaSection({
  personaMarkdown,
  onSavePersonaMarkdown
}: {
  personaMarkdown: string | null
  onSavePersonaMarkdown: (markdown: string) => Promise<void>
}): React.JSX.Element {
  const [markdown, setMarkdown] = useState(personaMarkdown ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    try {
      await onSavePersonaMarkdown(markdown)
      setSaved(true)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">助手人设</Typography>
        <Typography variant="body2" color="text.secondary">
          以 Markdown 形式描述助手的性格、说话风格与回答偏好，留空则使用默认设置。
        </Typography>
      </Box>

      <TextField
        value={markdown}
        onChange={(event) => {
          setSaved(false)
          setMarkdown(event.target.value)
        }}
        fullWidth
        multiline
        minRows={14}
        placeholder={'# 助手人设\n\n性格：……\n说话风格：……\n回答偏好：……'}
        sx={{ '& textarea': { fontFamily: 'var(--font-mono)', fontSize: '0.9rem' } }}
      />

      {saved ? <Alert severity="success">已保存</Alert> : null}

      <Box>
        <Button variant="contained" disabled={isSaving} onClick={handleSave} sx={{ minHeight: 44 }}>
          保存
        </Button>
      </Box>
    </Stack>
  )
}

function ProviderCard({
  provider,
  hint,
  onLogout
}: {
  provider: ProviderAuthStatus
  hint?: string
  onLogout: (providerId: string) => void
}): React.JSX.Element {
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1.25, borderRadius: 1 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.25}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'baseline', minWidth: 0, flexWrap: 'wrap', rowGap: 0.25 }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.35 }}>
              {provider.name}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.82rem',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {provider.providerId}
            </Typography>
          </Stack>

          <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
            {provider.hasApiKey && <Chip size="small" icon={<KeyIcon />} label="API Key" />}
            {provider.hasOAuth && <Chip size="small" icon={<ShieldIcon />} label="OAuth" />}
            {provider.statusText && (
              <Chip size="small" label={provider.statusText} variant="outlined" />
            )}
          </Stack>
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'center',
            justifyContent: { xs: 'space-between', sm: 'flex-end' },
            flexShrink: 0
          }}
        >
          <Chip
            size="small"
            color={provider.configured ? 'success' : 'default'}
            label={provider.configured ? '已配置' : '未配置'}
          />
          {provider.configured && (
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => onLogout(provider.providerId)}
              startIcon={<LogoutIcon />}
              sx={{ minHeight: 34, px: 1.25 }}
            >
              登出
            </Button>
          )}
        </Stack>
      </Stack>

      {hint ? (
        <Alert severity="info" variant="outlined" sx={{ mt: 1.25, py: 0.5 }}>
          <Typography variant="body2">{hint}</Typography>
        </Alert>
      ) : null}
    </Paper>
  )
}

function ProvidersSection({
  providers,
  providerHints,
  onRefresh,
  onOpenAddProvider,
  onLogout
}: {
  providers: ProviderAuthStatus[]
  providerHints: Record<string, string>
  onRefresh: () => Promise<void>
  onOpenAddProvider: () => void
  onLogout: (providerId: string) => void
}): React.JSX.Element {
  const configuredProviders = providers.filter((item) => item.configured)

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1
        }}
      >
        <Typography variant="h5">Provider 配置</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={onRefresh} sx={{ minHeight: 44 }}>
            刷新状态
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={onOpenAddProvider}
            sx={{ minHeight: 44 }}
          >
            添加 Provider
          </Button>
        </Stack>
      </Box>

      {configuredProviders.length === 0 ? (
        <Paper sx={{ p: 3, borderRadius: 1 }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            <Typography variant="body1">尚未配置任何 Provider</Typography>
          </Alert>
          <Button
            variant="contained"
            onClick={onOpenAddProvider}
            startIcon={<AddIcon />}
            sx={{ minHeight: 44 }}
          >
            先添加 Provider
          </Button>
        </Paper>
      ) : (
        <Stack spacing={1}>
          {configuredProviders.map((provider) => (
            <Box key={provider.providerId}>
              <ProviderCard
                provider={provider}
                hint={providerHints[provider.providerId]}
                onLogout={onLogout}
              />
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function AppearanceSection({
  mode,
  onSelectMode
}: {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
}): React.JSX.Element {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">外观</Typography>
        <Typography variant="body2" color="text.secondary">
          选择界面主题。
        </Typography>
      </Box>

      <ToggleButtonGroup
        exclusive
        value={mode}
        onChange={(_, next: ThemeMode | null) => {
          if (next) onSelectMode(next)
        }}
      >
        <ToggleButton value="light" sx={{ minHeight: 44, px: 2 }}>
          浅色
        </ToggleButton>
        <ToggleButton value="dark" sx={{ minHeight: 44, px: 2 }}>
          深色
        </ToggleButton>
        <ToggleButton value="system" sx={{ minHeight: 44, px: 2 }}>
          跟随系统
        </ToggleButton>
      </ToggleButtonGroup>

      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          配色
        </Typography>
        <Stack direction="row" spacing={1}>
          {ACCENT_PALETTE.map((color) => (
            <Box key={color} sx={{ width: 28, height: 28, borderRadius: 1, bgcolor: color }} />
          ))}
        </Stack>
      </Box>
    </Stack>
  )
}

function DiagnosticsSection({
  onCopyDiagnostics
}: {
  onCopyDiagnostics: () => Promise<string>
}): React.JSX.Element {
  const [isCopying, setIsCopying] = useState(false)
  const [copiedAt, setCopiedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleCopy = async (): Promise<void> => {
    setIsCopying(true)
    setError(null)
    try {
      await onCopyDiagnostics()
      setCopiedAt(new Date().toLocaleTimeString())
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError))
    } finally {
      setIsCopying(false)
    }
  }

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h5">诊断</Typography>
        <Typography variant="body2" color="text.secondary">
          给内部 beta 排查问题用的支持摘要，会自动过滤敏感信息和大段运行内容。
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 1 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Box
            sx={{
              width: 42,
              height: 42,
              borderRadius: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'secondary.light',
              color: 'secondary.dark',
              flexShrink: 0
            }}
          >
            <DiagnosticsIcon fontSize="small" />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              复制支持摘要
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              包含应用版本、平台、当前会话、项目权限、模型、Provider、Skills、MCP、插件和最近错误。
            </Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<ContentCopyIcon />}
            disabled={isCopying}
            onClick={handleCopy}
            sx={{ minHeight: 44, flexShrink: 0 }}
          >
            {isCopying ? '复制中' : '复制诊断'}
          </Button>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" icon={<CheckIcon />} label="密钥脱敏" />
          <Chip size="small" icon={<CheckIcon />} label="不含聊天全文" />
          <Chip size="small" icon={<CheckIcon />} label="不含工具完整输出" />
          <Chip size="small" icon={<CheckIcon />} label="不含 thinking" />
        </Stack>
      </Paper>

      {copiedAt ? <Alert severity="success">已复制 · {copiedAt}</Alert> : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
    </Stack>
  )
}

type SettingsDialogProps = {
  open: boolean
  onClose: () => void
  providers: ProviderAuthStatus[]
  providerHints: Record<string, string>
  personaMarkdown: string | null
  onSavePersonaMarkdown: (markdown: string) => Promise<void>
  onRefresh: () => Promise<void>
  onOpenAddProvider: () => void
  onLogout: (providerId: string) => void
  projects: Project[]
  models: ModelOption[]
  pendingApproval: ToolApprovalRequest | null
  updatingProjectId: string | null
  onUpdateProjectPermissionMode: (projectId: string, mode: PermissionMode) => void
  onUpdateProjectDefaults: (
    projectId: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => void
  onOpenApprovalSession: (path: string) => void
  onRespondApproval: (requestId: string, approved: boolean) => void
  onCopyDiagnostics: () => Promise<string>
  themeMode: ThemeMode
  onSelectThemeMode: (mode: ThemeMode) => void
  category: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
}

function SettingsDialog({
  open,
  onClose,
  providers,
  providerHints,
  personaMarkdown,
  onSavePersonaMarkdown,
  onRefresh,
  onOpenAddProvider,
  onLogout,
  projects,
  models,
  pendingApproval,
  updatingProjectId,
  onUpdateProjectPermissionMode,
  onUpdateProjectDefaults,
  onOpenApprovalSession,
  onRespondApproval,
  onCopyDiagnostics,
  themeMode,
  onSelectThemeMode,
  category,
  onCategoryChange
}: SettingsDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 'min(1120px, calc(100vw - 96px))',
            height: 'min(720px, calc(100vh - 96px))',
            maxHeight: 'calc(100vh - 96px)',
            borderRadius: 2,
            overflow: 'hidden',
            position: 'relative'
          }
        }
      }}
    >
      <IconButton
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: 18,
          right: 18,
          zIndex: 3,
          width: 36,
          height: 36,
          color: 'text.secondary',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          '&:hover': {
            bgcolor: 'action.hover',
            color: 'text.primary'
          }
        }}
        aria-label="关闭设置"
      >
        <CloseIcon fontSize="small" />
      </IconButton>

      <Box sx={{ display: 'flex', height: '100%', minHeight: 0, bgcolor: 'background.paper' }}>
        <Box
          sx={{
            width: 248,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            px: 1.5,
            py: 2,
            bgcolor: 'background.default',
            overflowY: 'auto'
          }}
        >
          <Stack spacing={0.75}>
            {CATEGORIES.map((item, index) => {
              const selected = category === item.id
              return (
                <ListItemButton
                  key={item.id}
                  selected={selected}
                  onClick={() => onCategoryChange(item.id)}
                  sx={{
                    minHeight: 48,
                    borderRadius: 1,
                    px: 1.5,
                    '&.Mui-selected': {
                      bgcolor: 'primary.main',
                      color: 'primary.contrastText'
                    },
                    '&.Mui-selected:hover': {
                      bgcolor: 'primary.dark'
                    }
                  }}
                >
                  <CategoryIcon index={index} selected={selected}>
                    {item.icon}
                  </CategoryIcon>
                  <ListItemText primary={item.label} />
                </ListItemButton>
              )
            })}
          </Stack>
        </Box>

        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            px: { xs: 3, md: 4 },
            py: 3,
            pr: { xs: 8, md: 9 },
            overflowY: 'auto',
            position: 'relative'
          }}
        >
          {category === 'persona' && (
            <PersonaSection
              personaMarkdown={personaMarkdown}
              onSavePersonaMarkdown={onSavePersonaMarkdown}
            />
          )}
          {category === 'providers' && (
            <ProvidersSection
              providers={providers}
              providerHints={providerHints}
              onRefresh={onRefresh}
              onOpenAddProvider={onOpenAddProvider}
              onLogout={onLogout}
            />
          )}
          {category === 'permissions' && (
            <PermissionSettingsSection
              projects={projects}
              models={models}
              pendingApproval={pendingApproval}
              updatingProjectId={updatingProjectId}
              onUpdateProjectPermissionMode={onUpdateProjectPermissionMode}
              onUpdateProjectDefaults={onUpdateProjectDefaults}
              onOpenApprovalSession={onOpenApprovalSession}
              onRespondApproval={onRespondApproval}
            />
          )}
          {category === 'diagnostics' && (
            <DiagnosticsSection onCopyDiagnostics={onCopyDiagnostics} />
          )}
          {category === 'appearance' && (
            <AppearanceSection mode={themeMode} onSelectMode={onSelectThemeMode} />
          )}
        </Box>
      </Box>
    </Dialog>
  )
}

export default SettingsDialog
