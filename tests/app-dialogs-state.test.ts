import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { useAppDialogs } from '../src/renderer/src/lib/app-shell/useAppDialogs'

/**
 * Renders one throwaway component and returns whatever it captured. The value is
 * read back through an object property, because the hooks lint rule rejects
 * reassigning a variable declared outside the component.
 */
function capture<T>(read: (dialogs: ReturnType<typeof useAppDialogs>) => T): T {
  const box: { value?: T } = {}
  function Probe(): null {
    box.value = read(useAppDialogs())
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  assert.ok(box.value !== undefined, 'probe captured nothing')
  return box.value
}

test('every app dialog starts closed with the general settings category', () => {
  const state = capture((dialogs) => ({
    open: {
      settings: dialogs.isSettingsOpen,
      sessionSearch: dialogs.isSessionSearchOpen,
      newProject: dialogs.isNewProjectDialogOpen,
      skillCatalog: dialogs.isSkillCatalogOpen,
      phiPluginCatalog: dialogs.isPhiPluginCatalogOpen
    },
    onboarding: dialogs.showOnboarding,
    environmentSummary: dialogs.showEnvironmentSummary,
    settingsCategory: dialogs.settingsCategory,
    exportTarget: dialogs.exportTarget,
    isExportingSession: dialogs.isExportingSession
  }))

  assert.deepEqual(state.open, {
    settings: false,
    sessionSearch: false,
    newProject: false,
    skillCatalog: false,
    phiPluginCatalog: false
  })
  assert.equal(state.onboarding, false)
  assert.equal(state.environmentSummary, false)
  assert.equal(state.settingsCategory, 'general')
  assert.equal(state.exportTarget, null)
  assert.equal(state.isExportingSession, false)
})

test('the hook exposes the setter shape App already used', () => {
  const setters = capture((dialogs) => ({
    settings: typeof dialogs.setIsSettingsOpen,
    category: typeof dialogs.setSettingsCategory,
    exportTarget: typeof dialogs.setExportTarget,
    exporting: typeof dialogs.setIsExportingSession
  }))

  assert.deepEqual(setters, {
    settings: 'function',
    category: 'function',
    exportTarget: 'function',
    exporting: 'function'
  })
})
