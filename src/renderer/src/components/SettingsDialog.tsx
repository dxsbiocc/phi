import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  FormControlLabel,
  FormControl,
  FormLabel,
  IconButton,
  ListItemButton,
  ListItemText,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { GoPlus, GoSync } from 'react-icons/go'
import { PhiIcons } from '../icons'
import type { ModelOption, PhiAppSettingsPatch, ProviderAuthStatus } from '../types'
import type { FileOpenConversationLayout } from '../../../shared/appSettingsTypes'
import type { PermissionMode, Project, ThinkingLevel, ToolApprovalRequest } from '../types'
import type { ThemeMode } from '../theme'
import { accentAt } from '../theme'
import type { ThemeFamily } from '../useThemeMode'
import { RemoteHostSettingsSection } from '../features/wrapper/components/RemoteHostSettings'
import { EnvironmentSettingsPanel } from '../features/environment/components/EnvironmentSettingsPanel'
import { WebSearchSettingsPanel } from '../features/settings/WebSearchSettingsPanel'
import { AppearanceSettingsSection } from '../features/settings/components/AppearanceSettingsSection'
import { PermissionSettingsSection } from './PermissionView'
import type { EnvironmentSnapshot, EnvironmentToolId } from '../types'
import type { ManualCompactionTarget } from '../../../shared/contextUsageTypes'
import { AutoCompactionSettingsSection } from '../features/chat/components/AutoCompactionSettingsSection'

const AddIcon = PhiIcons.action.add
const CloseIcon = PhiIcons.action.close
const KeyIcon = PhiIcons.entity.apiKey
const LogoutIcon = PhiIcons.action.logout
const RefreshIcon = GoSync
const AddToolbarIcon = GoPlus
const PaletteIcon = PhiIcons.settings.appearance
const ProviderIcon = PhiIcons.settings.providers
const SearchIcon = PhiIcons.action.search
const PsychologyIcon = PhiIcons.settings.persona
const ShieldIcon = PhiIcons.settings.permissions
const RemoteExecutionIcon = PhiIcons.settings.remoteExecution
const GeneralIcon = PhiIcons.nav.settings

export type SettingsCategory =
  | 'general'
  | 'environment'
  | 'persona'
  | 'providers'
  | 'web-search'
  | 'permissions'
  | 'remote'
  | 'appearance'

const CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: React.JSX.Element }> = [
  { id: 'general', label: '通用', icon: <GeneralIcon fontSize="small" /> },
  { id: 'environment', label: '环境', icon: <RemoteExecutionIcon fontSize="small" /> },
  { id: 'persona', label: '助手', icon: <PsychologyIcon fontSize="small" /> },
  { id: 'providers', label: 'Provider', icon: <ProviderIcon fontSize="small" /> },
  { id: 'web-search', label: '网页搜索', icon: <SearchIcon fontSize="small" /> },
  { id: 'permissions', label: '权限', icon: <ShieldIcon fontSize="small" /> },
  { id: 'remote', label: '远程', icon: <RemoteExecutionIcon fontSize="small" /> },
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
        <Typography variant="h5">助手</Typography>
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
        placeholder={'# 助手\n\n性格：……\n说话风格：……\n回答偏好：……'}
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
  onLogout
}: {
  provider: ProviderAuthStatus
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
    </Paper>
  )
}

function ProvidersSection({
  providers,
  onRefresh,
  onOpenAddProvider,
  onLogout
}: {
  providers: ProviderAuthStatus[]
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
        <Typography variant="h5">Provider</Typography>
        <Stack direction="row" spacing={1}>
          <Tooltip title="刷新状态">
            <IconButton
              aria-label="刷新状态"
              onClick={() => void onRefresh()}
              sx={{ width: 40, height: 40, color: 'text.secondary' }}
            >
              <RefreshIcon size={19} />
            </IconButton>
          </Tooltip>
          <Tooltip title="添加 Provider">
            <IconButton
              aria-label="添加 Provider"
              color="primary"
              onClick={onOpenAddProvider}
              sx={{ width: 40, height: 40 }}
            >
              <AddToolbarIcon size={28} />
            </IconButton>
          </Tooltip>
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
              <ProviderCard provider={provider} onLogout={onLogout} />
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function GeneralSection({
  noProjectTaskFolder,
  allowExternalFileRead,
  preventSleepDuringRuns,
  nextActionSuggestionsEnabled,
  fileOpenConversationLayout,
  isSavingAppSettings,
  onUpdateAppSettings,
  onPickNoProjectTaskFolder,
  autoCompactionTarget,
  autoCompactionDisabled,
  contextCompacting,
  compactDisabled,
  onCompactContext
}: {
  noProjectTaskFolder: string
  allowExternalFileRead: boolean
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  fileOpenConversationLayout: FileOpenConversationLayout
  isSavingAppSettings: boolean
  onUpdateAppSettings: (patch: PhiAppSettingsPatch) => void
  onPickNoProjectTaskFolder: () => void
  autoCompactionTarget?: ManualCompactionTarget | null
  autoCompactionDisabled?: boolean
  contextCompacting?: boolean
  compactDisabled?: boolean
  onCompactContext?: () => void
}): React.JSX.Element {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">通用</Typography>
        <Typography variant="body2" color="text.secondary">
          调整应用行为和当前会话设置。
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          flexDirection: { xs: 'column', md: 'row' }
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            无项目任务文件夹
          </Typography>
          <Typography variant="body2" color="text.secondary">
            在项目外启动的任务默认存储数据的位置。
          </Typography>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            minWidth: 0,
            maxWidth: { xs: '100%', md: '58%' },
            alignItems: 'center',
            alignSelf: { xs: 'stretch', md: 'center' }
          }}
        >
          <Typography
            variant="body2"
            title={noProjectTaskFolder}
            sx={{
              minWidth: 0,
              flex: 1,
              fontFamily: 'var(--font-mono)',
              color: 'text.secondary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {noProjectTaskFolder}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={isSavingAppSettings}
            onClick={onPickNoProjectTaskFolder}
          >
            更改
          </Button>
        </Stack>
      </Box>

      <Box>
        <FormControl disabled={isSavingAppSettings}>
          <FormLabel id="file-open-conversation-layout-label">打开文件时的对话布局</FormLabel>
          <RadioGroup
            row
            aria-labelledby="file-open-conversation-layout-label"
            value={fileOpenConversationLayout}
            onChange={(event) =>
              onUpdateAppSettings({
                fileOpenConversationLayout: event.target.value as FileOpenConversationLayout
              })
            }
          >
            <FormControlLabel value="sidebar" control={<Radio />} label="并排显示对话" />
            <FormControlLabel value="tab" control={<Radio />} label="对话保留在标签区" />
          </RadioGroup>
          <Typography variant="caption" color="text.secondary">
            打开文件或 Notebook 后仍可通过布局按钮随时切换。
          </Typography>
        </FormControl>
      </Box>

      <Box>
        <FormControlLabel
          disabled={isSavingAppSettings}
          control={
            <Switch
              checked={allowExternalFileRead}
              onChange={(event) =>
                onUpdateAppSettings({ allowExternalFileRead: event.target.checked })
              }
            />
          }
          label="允许读取项目外文件"
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
          仅用于文件悬停预览；不会授予写入、执行或删除权限。默认关闭。
        </Typography>
      </Box>

      <Box>
        <FormControlLabel
          disabled={isSavingAppSettings}
          control={
            <Switch
              checked={preventSleepDuringRuns}
              onChange={(event) =>
                onUpdateAppSettings({ preventSleepDuringRuns: event.target.checked })
              }
            />
          }
          label="运行任务时防止系统休眠"
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
          仅在有会话运行、等待审批或等待输入时保持唤醒。
        </Typography>
      </Box>

      <Box>
        <FormControlLabel
          disabled={isSavingAppSettings}
          control={
            <Switch
              checked={nextActionSuggestionsEnabled}
              onChange={(event) =>
                onUpdateAppSettings({ nextActionSuggestionsEnabled: event.target.checked })
              }
            />
          }
          label="提示词建议"
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
          允许助手在合适时给出一句可直接继续的下一步建议。
        </Typography>
      </Box>

      <AutoCompactionSettingsSection
        target={autoCompactionTarget ?? null}
        disabled={autoCompactionDisabled}
        compacting={contextCompacting}
        compactDisabled={compactDisabled}
        onCompact={onCompactContext}
      />
    </Stack>
  )
}

type SettingsDialogProps = {
  open: boolean
  onClose: () => void
  providers: ProviderAuthStatus[]
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
  noProjectTaskFolder: string
  allowExternalFileRead: boolean
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  fileOpenConversationLayout: FileOpenConversationLayout
  isSavingAppSettings: boolean
  onUpdateAppSettings: (patch: PhiAppSettingsPatch) => void
  onPickNoProjectTaskFolder: () => void
  autoCompactionTarget?: ManualCompactionTarget | null
  autoCompactionDisabled?: boolean
  contextCompacting?: boolean
  compactDisabled?: boolean
  onCompactContext?: () => void
  environmentSnapshot: EnvironmentSnapshot | null
  isLoadingEnvironment: boolean
  isRedetectingEnvironment: boolean
  onRedetectEnvironment: () => Promise<void>
  onSetEnvironmentToolPath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
  themeMode: ThemeMode
  onSelectThemeMode: (mode: ThemeMode) => void
  themeFamily: ThemeFamily
  onSelectThemeFamily: (family: ThemeFamily) => void
  category: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
}

function SettingsDialog({
  open,
  onClose,
  providers,
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
  noProjectTaskFolder,
  allowExternalFileRead,
  preventSleepDuringRuns,
  nextActionSuggestionsEnabled,
  fileOpenConversationLayout,
  isSavingAppSettings,
  onUpdateAppSettings,
  onPickNoProjectTaskFolder,
  autoCompactionTarget,
  autoCompactionDisabled,
  contextCompacting,
  compactDisabled,
  onCompactContext,
  environmentSnapshot,
  isLoadingEnvironment,
  isRedetectingEnvironment,
  onRedetectEnvironment,
  onSetEnvironmentToolPath,
  themeMode,
  onSelectThemeMode,
  themeFamily,
  onSelectThemeFamily,
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
          {category === 'general' && (
            <GeneralSection
              noProjectTaskFolder={noProjectTaskFolder}
              allowExternalFileRead={allowExternalFileRead}
              preventSleepDuringRuns={preventSleepDuringRuns}
              nextActionSuggestionsEnabled={nextActionSuggestionsEnabled}
              fileOpenConversationLayout={fileOpenConversationLayout}
              isSavingAppSettings={isSavingAppSettings}
              onUpdateAppSettings={onUpdateAppSettings}
              onPickNoProjectTaskFolder={onPickNoProjectTaskFolder}
              autoCompactionTarget={autoCompactionTarget}
              autoCompactionDisabled={autoCompactionDisabled}
              contextCompacting={contextCompacting}
              compactDisabled={compactDisabled}
              onCompactContext={onCompactContext}
            />
          )}
          {category === 'environment' && (
            <EnvironmentSettingsPanel
              snapshot={environmentSnapshot}
              loading={isLoadingEnvironment}
              redetecting={isRedetectingEnvironment}
              onRedetect={onRedetectEnvironment}
              onSavePath={onSetEnvironmentToolPath}
            />
          )}
          {category === 'persona' && (
            <PersonaSection
              personaMarkdown={personaMarkdown}
              onSavePersonaMarkdown={onSavePersonaMarkdown}
            />
          )}
          {category === 'providers' && (
            <ProvidersSection
              providers={providers}
              onRefresh={onRefresh}
              onOpenAddProvider={onOpenAddProvider}
              onLogout={onLogout}
            />
          )}
          {category === 'web-search' && (
            <WebSearchSettingsPanel onOpenProviderSettings={() => onCategoryChange('providers')} />
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
          {category === 'remote' && <RemoteHostSettingsSection />}
          {category === 'appearance' && (
            <AppearanceSettingsSection
              mode={themeMode}
              onSelectMode={onSelectThemeMode}
              family={themeFamily}
              onSelectFamily={onSelectThemeFamily}
            />
          )}
        </Box>
      </Box>
    </Dialog>
  )
}

export default SettingsDialog
