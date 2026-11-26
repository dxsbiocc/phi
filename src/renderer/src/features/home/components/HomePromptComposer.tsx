import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useCallback, useMemo, useRef } from 'react'
import { Box } from '@mui/material'
import { ChatComposer } from '../../../components/chat/ChatComposer'
import { type ComposerTextEditorHandle } from '../../../components/chat/ComposerTextEditor'
import { InputInvocationReferenceMenu } from '../../../components/chat/InputInvocationReferenceMenu'
import { useInputInvocationReferenceMenu } from '../../../components/chat/useInputInvocationReferenceMenu'
import type { ChatResourceMention } from '../../../lib/chatResourceMentions'
import { inlineReferenceInsertion } from '../../../lib/composerReferences'
import { findActiveInputInvocationReference } from '../../../lib/inputReferences'
import type { SessionMode } from '../../../../../shared/sessionMode'
import type { ModelOption, Project, ThinkingLevel } from '../../../types'
import { HomeProjectMenu } from './HomeProjectMenu'
import type { HomeComposerResources } from './HomePrompt'

type HomePromptComposerProps = {
  projects: Project[]
  selectedProject: Project | null
  draft: string
  mode: SessionMode
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

function useHomeInvocationMenu(
  inputRef: React.RefObject<ComposerTextEditorHandle | null>,
  draft: string,
  composerResources?: HomeComposerResources
): ReturnType<typeof useInputInvocationReferenceMenu> & {
  handleKeyDown: (event: KeyboardEvent) => boolean
} {
  const applyInvocationReferenceInput = useCallback(
    (_nextBody: string, referenceText: string): void => {
      const editor = inputRef.current
      if (!editor) return
      const query = findActiveInputInvocationReference(editor.value, editor.selectionStart)
      const insertion = inlineReferenceInsertion(
        editor.value,
        query?.start ?? editor.selectionStart,
        query?.end ?? editor.selectionEnd,
        referenceText
      )
      editor.replaceRange(insertion.from, insertion.to, insertion.insert)
      editor.setSelectionRange(insertion.cursor, insertion.cursor)
      editor.focus({ preventScroll: true })
    },
    [inputRef]
  )

  const menu = useInputInvocationReferenceMenu({
    input: draft,
    skills: composerResources?.skills ?? [],
    promptAgents: composerResources?.promptAgents ?? [],
    onInsertReference: applyInvocationReferenceInput
  })

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean =>
      menu.onKeyDown({
        key: event.key,
        nativeEvent: event,
        preventDefault: () => event.preventDefault()
      }) || submitPromptOnEnter(event),
    [menu]
  )

  return { ...menu, handleKeyDown }
}

function useHomeComposerResources(
  composerResources?: HomeComposerResources
): readonly ChatResourceMention[] {
  const resources = composerResources?.resources
  const promptAgents = composerResources?.promptAgents
  return useMemo(() => {
    const base = resources ?? []
    if (!promptAgents?.length) return base
    const agentMentions: ChatResourceMention[] = promptAgents
      .filter(
        (agent) => !base.some((resource) => resource.kind === 'agent' && resource.id === agent.id)
      )
      .map((agent) => ({
        kind: 'agent',
        id: agent.id,
        name: agent.name,
        icon: agent.icon,
        available: agent.available
      }))
    return agentMentions.length ? [...base, ...agentMentions] : base
  }, [promptAgents, resources])
}

export function HomePromptComposer(props: HomePromptComposerProps): React.JSX.Element {
  useUiLanguage()
  const inputRef = useRef<ComposerTextEditorHandle | null>(null)
  const { composerResources, selectedProject } = props
  const cwd = selectedProject?.workingDirectory ?? composerResources?.cwd ?? ''
  const menu = useHomeInvocationMenu(inputRef, props.draft, composerResources)
  const editorResources = useHomeComposerResources(composerResources)

  return (
    <Box>
      <Box
        data-phi-home-project="true"
        data-phi-home-project-id={selectedProject?.id ?? ''}
        sx={{ display: 'flex', mb: 1 }}
      >
        <HomeProjectMenu
          projects={props.projects}
          selectedProject={selectedProject}
          disabled={props.disabled}
          onSelectProject={props.onSelectProject}
          onNewProject={props.onNewProject}
        />
      </Box>
      <Box component="form" onSubmit={(event) => submitPrompt(event, props.onSubmit)}>
        {menu.menuState ? (
          <InputInvocationReferenceMenu
            state={menu.menuState}
            cwd={cwd}
            highlightedIndex={menu.highlightedIndex}
            onHighlight={menu.onHighlight}
            onSelect={menu.onSelect}
            onTrustChanged={composerResources?.onRefreshPromptAgents}
          />
        ) : null}
        <ChatComposer
          inputRef={inputRef}
          value={props.draft}
          placeholder={homeCopy.promptPlaceholder}
          ariaLabel={homeCopy.promptPlaceholder}
          editorDisabled={props.disabled}
          editorMinHeight={48}
          markHomeSend
          sendDisabled={!props.canSend}
          sessionMode={props.mode}
          onSelectSessionMode={props.onSelectMode}
          disableSessionModeSelect={props.disabled}
          models={props.models}
          selectedModel={props.selectedModel}
          onSelectModel={props.onSelectModel}
          disableModelControls={props.disabled}
          thinkingLevel={props.thinkingLevel}
          onSelectThinkingLevel={props.onSelectThinkingLevel}
          skills={composerResources?.skills}
          promptAgents={composerResources?.promptAgents}
          resources={editorResources}
          cwd={cwd}
          onPickFiles={composerResources?.onPickFiles}
          onOpenAddMenu={composerResources?.onOpenAddMenu}
          onRefreshPromptAgents={composerResources?.onRefreshPromptAgents}
          onChange={(value, cursor) => {
            menu.onInputChanged({ selectionStart: cursor })
            props.onDraftChange(value)
          }}
          onCursorChange={(cursor) => menu.onInputCursorChanged({ selectionStart: cursor })}
          onKeyDown={menu.handleKeyDown}
          sendLabel={homeCopy.sendPrompt}
        />
      </Box>
    </Box>
  )
}
