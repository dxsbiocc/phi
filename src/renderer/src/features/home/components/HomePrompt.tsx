import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Typography } from '@mui/material'
import type { ChatResourceMention } from '../../../lib/chatResourceMentions'
import type {
  ModelOption,
  PermissionMode,
  Project,
  PromptAgentSummary,
  SkillSummary,
  ThinkingLevel
} from '../../../types'
import { useHomePrompt, type HomeProjectSelection } from '../hooks/useHomePrompt'
import { HomePromptComposer } from './HomePromptComposer'
import { PhiMark } from './PhiMark'
import { HOME_COLUMN_MAX_WIDTH } from '../lib/homeColumn'

export type HomePromptRequest = {
  text: string
  projectId: string | null
  permissionMode: PermissionMode
  planMode: boolean
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
  onUpdateProjectPermissionMode: (
    projectId: string,
    permissionMode: PermissionMode
  ) => Promise<void>
  projectSelection: HomeProjectSelection | null
  onNewProject: () => void
  onStart: (request: HomePromptRequest) => Promise<void>
  composerResources?: HomeComposerResources
}

export function HomePrompt(props: HomePromptProps): React.JSX.Element {
  useUiLanguage()
  const prompt = useHomePrompt(
    props.projects,
    props.busy,
    props.projectSelection,
    props.onUpdateProjectPermissionMode,
    props.onStart
  )

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
          sx={{ letterSpacing: '-0.025em' }}
        >
          {homeCopy.continueYourWork}
        </Typography>
      </Box>
      <HomePromptComposer
        projects={props.projects}
        selectedProject={prompt.selectedProject}
        draft={prompt.draft}
        permissionMode={prompt.permissionMode}
        disabled={prompt.disabled}
        canSend={prompt.canSend}
        models={props.models}
        selectedModel={props.selectedModel}
        thinkingLevel={props.thinkingLevel}
        onDraftChange={prompt.setDraft}
        onSelectProject={prompt.setProjectId}
        onSelectPermissionMode={prompt.selectPermission}
        onSelectModel={props.onSelectModel}
        onSelectThinkingLevel={props.onSelectThinkingLevel}
        onNewProject={props.onNewProject}
        onSubmit={prompt.submit}
        planReviewEnabled={prompt.planReviewEnabled}
        disablePlanReview={prompt.disablePlanReview}
        onTogglePlanReview={prompt.togglePlanReview}
        composerResources={props.composerResources}
      />
    </Box>
  )
}
