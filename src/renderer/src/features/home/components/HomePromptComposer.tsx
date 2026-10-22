import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useRef } from 'react'
import { Box } from '@mui/material'
import { ChatComposer } from '../../../components/chat/ChatComposer'
import { type ComposerTextEditorHandle } from '../../../components/chat/ComposerTextEditor'
import type { ModelOption, PermissionMode, Project, ThinkingLevel } from '../../../types'
import { HomeProjectMenu } from './HomeProjectMenu'
import type { HomeComposerResources } from './HomePrompt'

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
  planReviewEnabled: boolean
  disablePlanReview: boolean
  onTogglePlanReview: () => void
  composerResources?: HomeComposerResources
}

export function HomePromptComposer({
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
  onSubmit,
  planReviewEnabled,
  disablePlanReview,
  onTogglePlanReview,
  composerResources
}: HomePromptComposerProps): React.JSX.Element {
  useUiLanguage()
  const inputRef = useRef<ComposerTextEditorHandle | null>(null)

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
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <ChatComposer
          inputRef={inputRef}
          value={draft}
          placeholder={homeCopy.promptPlaceholder}
          ariaLabel={homeCopy.promptPlaceholder}
          editorDisabled={disabled}
          editorMinHeight={48}
          markHomeSend
          sendDisabled={!canSend}
          permissionMode={permissionMode}
          onSelectPermissionMode={onSelectPermissionMode}
          disablePermissionModeSelect={disabled}
          models={models}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
          disableModelControls={disabled}
          thinkingLevel={thinkingLevel}
          onSelectThinkingLevel={onSelectThinkingLevel}
          skills={composerResources?.skills}
          promptAgents={composerResources?.promptAgents}
          resources={composerResources?.resources}
          cwd={selectedProject?.workingDirectory ?? composerResources?.cwd}
          onPickFiles={composerResources?.onPickFiles}
          onOpenAddMenu={composerResources?.onOpenAddMenu}
          onRefreshPromptAgents={composerResources?.onRefreshPromptAgents}
          planReviewEnabled={planReviewEnabled}
          onTogglePlanReview={onTogglePlanReview}
          disablePlanReview={disablePlanReview || disabled}
          onChange={(value) => onDraftChange(value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
            event.preventDefault()
            if (event.target instanceof Element) event.target.closest('form')?.requestSubmit()
            return true
          }}
          sendLabel={homeCopy.sendPrompt}
        />
      </Box>
    </Box>
  )
}
