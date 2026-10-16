import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import test from 'node:test'

import AgentNameConflictDialog from '../src/renderer/src/features/agent/components/AgentNameConflictDialog'

test('startup conflict dialog presents exactly the three approved decisions', () => {
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(AgentNameConflictDialog, {
        notice: {
          id: 'conflict-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          hostAlias: 'gpu',
          filePath: '/srv/project/.omp/agents/shadow.md',
          phiAgentName: 'Research',
          requestedName: 'phi_name_0_fg',
          proposedPhiName: 'phi_name_0_fg-phi',
          proposedOtherName: 'phi_name_0_fg-project'
        },
        busy: false,
        onResolve: () => undefined
      })
    )
  )
  assert.match(markup, /Agent name conflict/u)
  assert.match(markup, /gpu.*shadow\.md/su)
  assert.equal((markup.match(/<button/g) ?? []).length, 3)
  assert.match(markup, /Not now/u)
  assert.match(markup, /Rename other to phi_name_0_fg-project/u)
  assert.match(markup, /Rename Phi to phi_name_0_fg-phi/u)
})

test('conversation conflict path uses agentInteraction and suppresses dialog/custom-answer publication', async () => {
  const [main, panel, dialogs, interaction] = await Promise.all([
    readFile('src/main/index.ts', 'utf8'),
    readFile('src/renderer/src/components/UserInteractionPanel.tsx', 'utf8'),
    readFile('src/renderer/src/AppDialogs.tsx', 'utf8'),
    readFile('src/main/agent/user-interaction.ts', 'utf8')
  ])
  assert.match(
    main,
    /resolveAgentConflicts:[\s\S]*enqueueDialogs: false[\s\S]*handleAgentInteractionRequest\([\s\S]*allowCustomAnswer: false[\s\S]*allowCancel: false/u
  )
  assert.match(main, /scheduleAgentNameConflictCheck[\s\S]*enqueueDialogs: true/u)
  assert.match(main, /beginInlineResolution\(identity\.sessionId\)[\s\S]*endInlineResolution\(\)/u)
  assert.match(
    main,
    /findActivePromptRunByPhiSessionId\(identity\.sessionId\)[\s\S]*handleAgentInteractionRequest\([\s\S]*promptRun/u
  )
  assert.match(main, /agentNameConflicts:respond[\s\S]*?requireMainWindowRenderer\(event\)/u)
  assert.match(
    main,
    /agent:interaction-response[\s\S]*?requireMainWindowRenderer\(event\)[\s\S]*?window\.webContents\.id/u
  )
  assert.match(panel, /request\.allowCancel !== false/u)
  assert.match(panel, /request\.allowCustomAnswer !== false/u)
  assert.match(interaction, /allowCustomAnswer: input\.allowCustomAnswer/u)
  assert.match(interaction, /allowCancel: input\.allowCancel/u)
  assert.match(dialogs, /<AgentNameConflictDialog/u)
})
