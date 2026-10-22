import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useRef } from 'react'
import { Box, IconButton, Paper } from '@mui/material'
import { GoPaperAirplane } from 'react-icons/go'
import {
  ModelSelectorControl,
  PermissionModeControl
} from '../../../components/chat/ChatComposerControls'
import {
  ComposerTextEditor,
  type ComposerTextEditorHandle
} from '../../../components/chat/ComposerTextEditor'
import {
  COMPOSER_ICON_SIZE,
  REGULAR_COMPOSER_ACTION_SIZE,
  composerSurfaceSx
} from '../../../components/chat/composerControlStyles'
import type { ModelOption, PermissionMode, Project, ThinkingLevel } from '../../../types'
import { HomeProjectMenu } from './HomeProjectMenu'

type HomePromptComposerProps = {
  projects: Project[]
  selectedProject: Project | null
  draft: string
  permissionMode: PermissionMode
  disabled: boolean
  canSend: boolean
  models: ModelOption[]
  selectedModel: ModelOption | null
  thinkingLevel: ThinkingLevel
  onDraftChange: (value: string) => void
  onSelectProject: (projectId: string | null) => void
  onSelectPermissionMode: (mode: PermissionMode) => void
  onSelectModel: (model: ModelOption | null) => void
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onNewProject: () => void
  onSubmit: () => void
}

function HomePromptActions({
  permissionMode,
  disabled,
  canSend,
  models,
  selectedModel,
  thinkingLevel,
  onSelectPermissionMode,
  onSelectModel,
  onSelectThinkingLevel
}: Pick<
  HomePromptComposerProps,
  | 'permissionMode'
  | 'disabled'
  | 'canSend'
  | 'models'
  | 'selectedModel'
  | 'thinkingLevel'
  | 'onSelectPermissionMode'
  | 'onSelectModel'
  | 'onSelectThinkingLevel'
>): React.JSX.Element {
  useUiLanguage()
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mt: 1 }}
    >
      <PermissionModeControl
        permissionMode={permissionMode}
        disabled={disabled}
        onSelectPermissionMode={onSelectPermissionMode}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <ModelSelectorControl
          models={models}
          selectedModel={selectedModel}
          disabled={disabled}
          onSelectModel={onSelectModel}
          thinkingLevel={thinkingLevel}
          supportedThinkingLevels={selectedModel?.thinkingLevels ?? null}
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
        <IconButton
          type="submit"
          disabled={!canSend}
          aria-label={homeCopy.sendPrompt}
          data-phi-home-send="true"
          sx={{
            boxSizing: 'border-box',
            width: REGULAR_COMPOSER_ACTION_SIZE,
            height: REGULAR_COMPOSER_ACTION_SIZE,
            minWidth: REGULAR_COMPOSER_ACTION_SIZE,
            minHeight: REGULAR_COMPOSER_ACTION_SIZE,
            p: 0,
            flexShrink: 0,
            color: 'primary.main',
            transition: 'background-color 200ms',
            '&:hover': { bgcolor: 'action.hover' },
            '&.Mui-disabled': { bgcolor: 'transparent', color: 'action.disabled' }
          }}
        >
          <GoPaperAirplane size={COMPOSER_ICON_SIZE} aria-hidden="true" />
        </IconButton>
      </Box>
    </Box>
  )
}

export function HomePromptComposer(props: HomePromptComposerProps): React.JSX.Element {
  useUiLanguage()
  const inputRef = useRef<ComposerTextEditorHandle | null>(null)
  const {
    projects,
    selectedProject,
    draft,
    permissionMode,
    disabled,
    canSend,
    models,
    selectedModel,
    thinkingLevel,
    onDraftChange,
    onSelectProject,
    onSelectPermissionMode,
    onSelectModel,
    onSelectThinkingLevel,
    onNewProject,
    onSubmit
  } = props

  return (
    <Box>
      <Box data-phi-home-project="true" sx={{ display: 'flex', mb: 1 }}>
        <HomeProjectMenu
          projects={projects}
          selectedProject={selectedProject}
          disabled={disabled}
          onSelectProject={onSelectProject}
          onNewProject={onNewProject}
        />
      </Box>
      <Paper
        component="form"
        variant="outlined"
        aria-label={homeCopy.promptPlaceholder}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
        sx={composerSurfaceSx({ compact: false, dragActive: false })}
      >
        <Box sx={{ minHeight: 48 }}>
          <ComposerTextEditor
            inputRef={inputRef}
            value={draft}
            resources={[]}
            disabled={disabled}
            ariaLabel={homeCopy.promptPlaceholder}
            placeholder={homeCopy.promptPlaceholder}
            onChange={(value) => onDraftChange(value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
              event.preventDefault()
              if (event.target instanceof Element) event.target.closest('form')?.requestSubmit()
              return true
            }}
          />
        </Box>
        <HomePromptActions
          permissionMode={permissionMode}
          disabled={disabled}
          canSend={canSend}
          models={models}
          selectedModel={selectedModel}
          thinkingLevel={thinkingLevel}
          onSelectPermissionMode={onSelectPermissionMode}
          onSelectModel={onSelectModel}
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </Paper>
    </Box>
  )
}
