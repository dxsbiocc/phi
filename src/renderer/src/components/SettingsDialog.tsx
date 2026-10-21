import { settingsUi } from '../features/settings/lib/settingsUi'
import { useUiLanguage } from '../lib/i18n'
import { useState } from 'react'
import {
  alpha,
  Alert,
  Box,
  Button,
  Dialog,
  FormControlLabel,
  FormControl,
  FormLabel,
  IconButton,
  ListItemButton,
  ListItemText,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import { PhiIcons } from '../icons'
import type { ModelOption, PhiAppSettingsPatch, ProviderAuthStatus } from '../types'
import type { FileOpenConversationLayout } from '../../../shared/appSettingsTypes'
import type { PermissionMode, Project, ThinkingLevel, ToolApprovalRequest } from '../types'
import type { ThemeMode } from '../theme'
import { accentAt } from '../theme'
import type { ThemePaletteId } from '../themePalettes'
import { RemoteHostSettingsSection } from '../features/wrapper/components/RemoteHostSettings'
import { EnvironmentSettingsPanel } from '../features/environment/EnvironmentSettingsPanel'
import { WebSearchSettingsPanel } from '../features/settings/WebSearchSettingsPanel'
import { ProvidersSection } from '../features/settings/components/ProvidersSection'
import { AppearanceSettingsSection } from '../features/settings/components/AppearanceSettingsSection'
import { AppUpdateSection } from '../features/settings/components/AppUpdateSection'
import { PermissionSettingsSection } from './PermissionView'
import { MemorySettingsPanel } from '../features/memory/MemorySettingsPanel'
import type { EnvironmentSnapshot, EnvironmentToolId } from '../types'
import type { ManualCompactionTarget } from '../../../shared/contextUsageTypes'
import { AutoCompactionSettingsSection } from '../features/chat/components/AutoCompactionSettingsSection'

const CloseIcon = PhiIcons.action.close
const PaletteIcon = PhiIcons.settings.appearance
const ProviderIcon = PhiIcons.settings.providers
const SearchIcon = PhiIcons.action.search
const PsychologyIcon = PhiIcons.settings.persona
const ShieldIcon = PhiIcons.settings.permissions
const MemoryIcon = PhiIcons.settings.memory
const RemoteExecutionIcon = PhiIcons.settings.remoteExecution
const GeneralIcon = PhiIcons.nav.settings

export type SettingsCategory =
  | 'general'
  | 'environment'
  | 'persona'
  | 'providers'
  | 'web-search'
  | 'permissions'
  | 'memory'
  | 'remote'
  | 'appearance'

const CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: React.JSX.Element }> = [
  {
    id: 'general',
    get label() {
      return settingsUi.general
    },
    icon: <GeneralIcon fontSize="small" />
  },
  {
    id: 'environment',
    get label() {
      return settingsUi.environments
    },
    icon: <RemoteExecutionIcon fontSize="small" />
  },
  {
    id: 'persona',
    get label() {
      return settingsUi.assistant
    },
    icon: <PsychologyIcon fontSize="small" />
  },
  {
    id: 'providers',
    get label() {
      return settingsUi.providers
    },
    icon: <ProviderIcon fontSize="small" />
  },
  {
    id: 'web-search',
    get label() {
      return settingsUi.webSearch
    },
    icon: <SearchIcon fontSize="small" />
  },
  {
    id: 'permissions',
    get label() {
      return settingsUi.permissions
    },
    icon: <ShieldIcon fontSize="small" />
  },
  {
    id: 'memory',
    get label() {
      return settingsUi.memory
    },
    icon: <MemoryIcon fontSize="small" />
  },
  {
    id: 'remote',
    get label() {
      return settingsUi.remote
    },
    icon: <RemoteExecutionIcon fontSize="small" />
  },
  {
    id: 'appearance',
    get label() {
      return settingsUi.appearance
    },
    icon: <PaletteIcon fontSize="small" />
  }
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
  useUiLanguage()
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
        bgcolor: (theme) => (selected ? alpha(theme.palette.primary.main, 0.12) : `${accent}26`),
        color: selected ? 'inherit' : accent
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
  useUiLanguage()
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
        <Typography variant="h5">{settingsUi.assistant}</Typography>
        <Typography variant="body2" color="text.secondary">
          {settingsUi.describeYourAssistantSPersonalityToneAndResponse}
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
        placeholder={settingsUi.assistantPersonalityToneResponsePreferences}
        sx={{ '& textarea': { fontFamily: 'var(--font-mono)', fontSize: '0.9rem' } }}
      />

      {saved ? <Alert severity="success">{settingsUi.saved}</Alert> : null}

      <Box>
        <Button variant="contained" disabled={isSaving} onClick={handleSave} sx={{ minHeight: 44 }}>
          {settingsUi.save}
        </Button>
      </Box>
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
  useUiLanguage()
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5">{settingsUi.general}</Typography>
        <Typography variant="body2" color="text.secondary">
          {settingsUi.adjustApplicationBehaviorAndCurrentSessionSettings}
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
            {settingsUi.folderForTasksWithoutAProject}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {settingsUi.defaultDataLocationForTasksStartedOutsideA}
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
            {settingsUi.change}
          </Button>
        </Stack>
      </Box>

      <Box>
        <FormControl disabled={isSavingAppSettings}>
          <FormLabel id="file-open-conversation-layout-label">
            {settingsUi.conversationLayoutWhenOpeningFiles}
          </FormLabel>
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
            <FormControlLabel
              value="sidebar"
              control={<Radio />}
              label={settingsUi.showConversationAlongsideFiles}
            />
            <FormControlLabel
              value="tab"
              control={<Radio />}
              label={settingsUi.keepConversationInTabs}
            />
          </RadioGroup>
          <Typography variant="caption" color="text.secondary">
            {settingsUi.youCanSwitchLayoutsAtAnyTimeAfter}
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
          label={settingsUi.allowReadingFilesOutsideTheProject}
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
          {settingsUi.appliesOnlyToFileHoverPreviewsItDoes}
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
          label={settingsUi.preventSleepWhileTasksRun}
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
          {settingsUi.keepTheSystemAwakeOnlyWhileSessionsRun}
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
          label={settingsUi.promptSuggestions}
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
          {settingsUi.allowTheAssistantToSuggestANextStep}
        </Typography>
      </Box>

      <AutoCompactionSettingsSection
        target={autoCompactionTarget ?? null}
        disabled={autoCompactionDisabled}
        compacting={contextCompacting}
        compactDisabled={compactDisabled}
        onCompact={onCompactContext}
      />

      <AppUpdateSection />
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
  onProjectUpdated: (project: Project) => void
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
  themePalette: ThemePaletteId
  onSelectThemePalette: (palette: ThemePaletteId) => void
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
  onProjectUpdated,
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
  themePalette,
  onSelectThemePalette,
  category,
  onCategoryChange
}: SettingsDialogProps): React.JSX.Element {
  useUiLanguage()
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
        aria-label={settingsUi.closeSettings}
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
                      bgcolor: (theme) => alpha(theme.palette.primary.main, 0.14),
                      color: 'text.primary'
                    },
                    '&.Mui-selected:hover': {
                      bgcolor: (theme) => alpha(theme.palette.primary.main, 0.2)
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
          {category === 'memory' && (
            <MemorySettingsPanel projects={projects} onProjectUpdated={onProjectUpdated} />
          )}
          {category === 'remote' && <RemoteHostSettingsSection />}
          {category === 'appearance' && (
            <AppearanceSettingsSection
              mode={themeMode}
              onSelectMode={onSelectThemeMode}
              palette={themePalette}
              onSelectPalette={onSelectThemePalette}
              onSelectLanguage={(uiLanguage) => onUpdateAppSettings({ uiLanguage })}
              savingLanguage={isSavingAppSettings}
            />
          )}
        </Box>
      </Box>
    </Dialog>
  )
}

export default SettingsDialog
