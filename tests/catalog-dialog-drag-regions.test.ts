import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import test from 'node:test'
import { SkillCatalogDialog } from '../src/renderer/src/features/skill/components/SkillCatalogDialog'
import { WrapperCatalogDialog } from '../src/renderer/src/features/wrapper/components/WrapperCatalogDialog'
import { PhiPluginCatalogDialog } from '../src/renderer/src/features/phi-plugin/components/PhiPluginCatalogDialog'
import { createMinimalTheme } from '../src/renderer/src/minimalTheme'
import { createAppTheme } from '../src/renderer/src/theme'

const dialogs = [
  [
    'skills',
    createElement(SkillCatalogDialog, { open: true, skills: [], onClose: () => undefined })
  ],
  [
    'wrappers',
    createElement(WrapperCatalogDialog, {
      open: true,
      catalog: [],
      onClose: () => undefined,
      onRefresh: () => undefined
    })
  ],
  [
    'plugins',
    createElement(PhiPluginCatalogDialog, {
      open: true,
      plugins: [],
      installWorking: false,
      feedbackError: null,
      feedbackNotice: null,
      onClose: () => undefined,
      onChanged: async () => undefined,
      onClearFeedback: () => undefined,
      onShowError: () => undefined,
      onInstallFromDirectory: async () => false
    })
  ]
] as const

for (const [family, createFamilyTheme] of [
  ['minimal', createMinimalTheme],
  ['teal', createAppTheme]
] as const) {
  for (const mode of ['light', 'dark'] as const) {
    for (const [label, dialog] of dialogs) {
      test(`${family} ${mode}: ${label} dialog excludes underlying native window drag regions`, () => {
        const theme = createTheme(createFamilyTheme(mode), {
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
        const markup = renderToStaticMarkup(createElement(ThemeProvider, { theme }, dialog))
        const paperStyles = [
          ...markup.matchAll(/<style data-emotion="css [^"]*MuiDialog-paper">([\s\S]*?)<\/style>/g)
        ].map((match) => match[1])
        assert.ok(paperStyles.length > 0, 'render the actual dialog paper styles')
        assert.match(paperStyles.join('\n'), /-webkit-app-region:no-drag;/)
      })
    }
  }
}
