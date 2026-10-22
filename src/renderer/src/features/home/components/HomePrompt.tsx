import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Typography } from '@mui/material'
import type { ModelOption, PermissionMode, Project, ThinkingLevel } from '../../../types'
import { useHomePrompt } from '../hooks/useHomePrompt'
import { HomePromptComposer } from './HomePromptComposer'
import { PhiMark } from './PhiMark'
import { HOME_COLUMN_MAX_WIDTH } from '../lib/homeColumn'

export type HomePromptRequest = {
  text: string
  projectId: string | null
  permissionMode: PermissionMode
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
  createdProjectId: string | null
  onNewProject: () => void
  onStart: (request: HomePromptRequest) => Promise<void>
}

export function HomePrompt(props: HomePromptProps): React.JSX.Element {
  useUiLanguage()
  const prompt = useHomePrompt(
    props.projects,
    props.busy,
    props.createdProjectId,
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
      />
    </Box>
  )
}
