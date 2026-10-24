import { homeCopy } from '../lib/homeCopy'
import { BRAND_FONT_STACK } from '../../../minimalTheme/tokens'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Typography } from '@mui/material'
import type { ChatResourceMention } from '../../../lib/chatResourceMentions'
import type {
  ModelOption,
  Project,
  PromptAgentSummary,
  SkillSummary,
  ThinkingLevel
} from '../../../types'
import { useHomePrompt, type HomeProjectSelection } from '../hooks/useHomePrompt'
import type { SessionMode } from '../../../../../shared/sessionMode'
import { HomePromptComposer } from './HomePromptComposer'
import { PhiMark } from './PhiMark'
import { HOME_COLUMN_MAX_WIDTH } from '../lib/homeColumn'

export type HomePromptRequest = {
  text: string
  projectId: string | null
  mode: SessionMode
}

export type HomeComposerResources = {
  skills: SkillSummary[]
  promptAgents: PromptAgentSummary[]
  resources: readonly ChatResourceMention[]
  cwd: string
  onPickFiles?: () => Promise<string[]>
  onOpenAddMenu?: () => void
  onRefreshPromptAgents?: () => Promise<void>
}

type HomePromptProps = {
  projects: Project[]
  models: ModelOption[]
  selectedModel: ModelOption | null
  thinkingLevel: ThinkingLevel
  busy: boolean
  onSelectModel: (model: ModelOption | null) => void
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  projectSelection: HomeProjectSelection | null
  onNewProject: () => void
  onStart: (request: HomePromptRequest) => Promise<void>
  composerResources?: HomeComposerResources
}

export function HomePrompt(props: HomePromptProps): React.JSX.Element {
  useUiLanguage()
  const prompt = useHomePrompt(props.projects, props.busy, props.projectSelection, props.onStart)

  return (
    <Box
      data-phi-home-prompt="true"
      sx={{ width: '100%', maxWidth: HOME_COLUMN_MAX_WIDTH, mx: 'auto', mb: { xs: 4, sm: 5 } }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          mb: 5
        }}
      >
        <PhiMark />
        <Typography
          id="home-heading"
          component="h1"
          variant="h4"
          sx={{ fontFamily: BRAND_FONT_STACK, letterSpacing: '-0.025em' }}
        >
          {homeCopy.continueYourWork}
        </Typography>
      </Box>
      <HomePromptComposer
        projects={props.projects}
        selectedProject={prompt.selectedProject}
        draft={prompt.draft}
        mode={prompt.mode}
        remote={prompt.remote}
        disabled={prompt.disabled}
        canSend={prompt.canSend}
        models={props.models}
        selectedModel={props.selectedModel}
        thinkingLevel={props.thinkingLevel}
        onDraftChange={prompt.setDraft}
        onSelectProject={prompt.setProjectId}
        onSelectMode={prompt.selectMode}
        onSelectModel={props.onSelectModel}
        onSelectThinkingLevel={props.onSelectThinkingLevel}
        onNewProject={props.onNewProject}
        onSubmit={prompt.submit}
        composerResources={props.composerResources}
      />
    </Box>
  )
}
