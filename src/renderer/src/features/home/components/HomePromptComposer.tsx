import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useRef } from 'react'
import { Box } from '@mui/material'
import { ChatComposer } from '../../../components/chat/ChatComposer'
import { type ComposerTextEditorHandle } from '../../../components/chat/ComposerTextEditor'
import type { SessionMode } from '../../../../../shared/sessionMode'
import type { ModelOption, Project, ThinkingLevel } from '../../../types'
import { HomeProjectMenu } from './HomeProjectMenu'
import type { HomeComposerResources } from './HomePrompt'

type HomePromptComposerProps = {
  projects: Project[]
  selectedProject: Project | null
  draft: string
  mode: SessionMode
  remote: boolean
  disabled: boolean
  canSend: boolean
  models: ModelOption[]
  selectedModel: ModelOption | null
  thinkingLevel: ThinkingLevel
  onDraftChange: (value: string) => void
  onSelectProject: (projectId: string | null) => void
  onSelectMode: (mode: SessionMode) => void
  onSelectModel: (model: ModelOption | null) => void
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onNewProject: () => void
  onSubmit: () => void
  composerResources?: HomeComposerResources
}

function submitPrompt(event: React.FormEvent, onSubmit: () => void): void {
  event.preventDefault()
  onSubmit()
}

function submitPromptOnEnter(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
  event.preventDefault()
  if (event.target instanceof Element) event.target.closest('form')?.requestSubmit()
  return true
}

export function HomePromptComposer({
  projects,
  selectedProject,
  draft,
  mode,
  remote,
  disabled,
  canSend,
  models,
  selectedModel,
  thinkingLevel,
  onDraftChange,
  onSelectProject,
  onSelectMode,
  onSelectModel,
  onSelectThinkingLevel,
  onNewProject,
  onSubmit,
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
      <Box component="form" onSubmit={(event) => submitPrompt(event, onSubmit)}>
        <ChatComposer
          inputRef={inputRef}
          value={draft}
          placeholder={homeCopy.promptPlaceholder}
          ariaLabel={homeCopy.promptPlaceholder}
          editorDisabled={disabled}
          editorMinHeight={48}
          markHomeSend
          sendDisabled={!canSend}
          sessionMode={mode}
          onSelectSessionMode={onSelectMode}
          disableSessionModeSelect={disabled}
          remoteSession={remote}
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
          onChange={(value) => onDraftChange(value)}
          onKeyDown={submitPromptOnEnter}
          sendLabel={homeCopy.sendPrompt}
        />
      </Box>
    </Box>
  )
}
