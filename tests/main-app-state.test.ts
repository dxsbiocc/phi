import assert from 'node:assert/strict'
import test from 'node:test'

import { AppCaches } from '../src/main/app-state/app-caches'
import { MainWindowState } from '../src/main/app-state/main-window-state'
import { WorkspaceServicesState } from '../src/main/app-state/workspace-services-state'

function plainObject<T>(value: object): T {
  return value as unknown as T
}

test('MainWindowState owns window, splash, menu bar, and queued-action references', () => {
  const state = new MainWindowState()
  const mainWindow = plainObject<NonNullable<MainWindowState['mainWindow']>>({ id: 'main' })
  const staleWindow = plainObject<NonNullable<MainWindowState['mainWindow']>>({ id: 'stale' })
  const splash = plainObject<NonNullable<MainWindowState['startupSplashWindow']>>({ id: 'splash' })
  let menuBarDestroyed = 0
  const menuBarController = plainObject<NonNullable<MainWindowState['menuBarController']>>({
    destroy: () => {
      menuBarDestroyed += 1
    }
  })

  assert.equal(state.mainWindow, null)
  assert.equal(state.startupSplashWindow, null)
  assert.equal(state.menuBarController, null)
  assert.equal(state.consumeMenuBarAction(), null)

  state.setMainWindow(mainWindow)
  assert.equal(state.mainWindow, mainWindow)
  state.clearMainWindow(staleWindow)
  assert.equal(state.mainWindow, mainWindow)
  state.clearMainWindow(mainWindow)
  assert.equal(state.mainWindow, null)

  state.setStartupSplashWindow(splash)
  assert.equal(state.startupSplashWindow, splash)
  assert.equal(state.takeStartupSplashWindow(), splash)
  assert.equal(state.startupSplashWindow, null)
  assert.equal(state.takeStartupSplashWindow(), null)

  state.setMenuBarController(menuBarController)
  assert.equal(state.menuBarController, menuBarController)
  state.destroyMenuBarController()
  assert.equal(menuBarDestroyed, 1)
  assert.equal(state.menuBarController, null)

  state.queueMenuBarAction('new-chat')
  state.queueMenuBarAction('open-settings')
  assert.equal(state.consumeMenuBarAction(), 'open-settings')
  assert.equal(state.consumeMenuBarAction(), null)
})

test('MainWindowState cleanup starts once, preserves ordering, and can be reset', async () => {
  const state = new MainWindowState()
  const calls: string[] = []

  assert.equal(state.cleanupStarted, false)
  assert.equal(state.cleanupPromise, null)

  const first = state.beginCleanup(
    () => {
      calls.push('dispose-before-cleanup')
    },
    async () => {
      calls.push('cleanup')
    }
  )
  const second = state.beginCleanup(
    () => {
      calls.push('unexpected-second-dispose')
    },
    async () => {
      calls.push('unexpected-second-cleanup')
    }
  )

  assert.equal(state.cleanupStarted, true)
  assert.equal(state.cleanupPromise, first)
  assert.equal(second, first)
  assert.deepEqual(calls, ['dispose-before-cleanup'])

  await first
  assert.deepEqual(calls, ['dispose-before-cleanup', 'cleanup'])

  state.resetCleanup()
  assert.equal(state.cleanupStarted, false)
  assert.equal(state.cleanupPromise, null)
})

test('WorkspaceServicesState owns the browser-registry lifecycle and disposal identity', () => {
  const state = new WorkspaceServicesState()
  const registry = plainObject<NonNullable<WorkspaceServicesState['browserWorkspaceRegistry']>>({
    id: 'registry'
  })
  const staleRegistry = plainObject<
    NonNullable<WorkspaceServicesState['browserWorkspaceRegistry']>
  >({
    id: 'stale-registry'
  })
  const disposal = Promise.resolve()
  const staleDisposal = Promise.resolve()

  assert.equal(state.browserWorkspaceRegistry, null)
  assert.equal(state.browserWorkspaceRegistryLifecycle, 'idle')
  assert.equal(state.browserWorkspaceRegistryDisposal, null)

  state.setBrowserWorkspaceRegistry(registry)
  state.markBrowserWorkspaceRegistryDisposing()
  state.setBrowserWorkspaceRegistryDisposal(disposal)
  assert.equal(state.browserWorkspaceRegistry, registry)
  assert.equal(state.browserWorkspaceRegistryLifecycle, 'disposing')
  assert.equal(state.browserWorkspaceRegistryDisposal, disposal)

  assert.equal(state.failBrowserWorkspaceRegistryDisposal(staleRegistry, disposal), false)
  assert.equal(state.failBrowserWorkspaceRegistryDisposal(registry, staleDisposal), false)
  assert.equal(state.browserWorkspaceRegistryLifecycle, 'disposing')

  assert.equal(state.failBrowserWorkspaceRegistryDisposal(registry, disposal), true)
  assert.equal(state.browserWorkspaceRegistryLifecycle, 'failed')

  state.completeBrowserWorkspaceRegistryDisposal(staleRegistry, disposal)
  state.completeBrowserWorkspaceRegistryDisposal(registry, staleDisposal)
  assert.equal(state.browserWorkspaceRegistryLifecycle, 'failed')

  state.completeBrowserWorkspaceRegistryDisposal(registry, disposal)
  assert.equal(state.browserWorkspaceRegistry, null)
  assert.equal(state.browserWorkspaceRegistryDisposal, null)
  assert.equal(state.browserWorkspaceRegistryLifecycle, 'idle')
})

test('WorkspaceServicesState records a synchronous browser-registry disposal failure', () => {
  const state = new WorkspaceServicesState()

  state.markBrowserWorkspaceRegistryDisposing()
  state.markBrowserWorkspaceRegistryDisposalFailed()

  assert.equal(state.browserWorkspaceRegistryLifecycle, 'failed')
})

test('WorkspaceServicesState owns and atomically releases terminal services', () => {
  const state = new WorkspaceServicesState()
  const manager = plainObject<NonNullable<WorkspaceServicesState['terminalManager']>>({
    id: 'manager'
  })
  const draftService = plainObject<NonNullable<WorkspaceServicesState['terminalDraftService']>>({
    id: 'draft-service'
  })

  assert.equal(state.terminalManager, null)
  assert.equal(state.terminalDraftService, null)

  state.setTerminalManager(manager)
  state.setTerminalDraftService(draftService)
  assert.equal(state.terminalManager, manager)
  assert.equal(state.terminalDraftService, draftService)
  assert.deepEqual(state.takeTerminalServices(), { draftService, manager })
  assert.equal(state.terminalManager, null)
  assert.equal(state.terminalDraftService, null)
  assert.deepEqual(state.takeTerminalServices(), { draftService: null, manager: null })
})

test('AppCaches owns LaunchServices and package-update caches', async () => {
  const caches = new AppCaches()
  const launchServicesHandlers = Promise.resolve([{ LSHandlerContentTag: 'pdf' }])
  const packageUpdates = plainObject<AppCaches['cachedPackageUpdates']>([{ id: 'package-update' }])

  assert.equal(caches.macLaunchServicesHandlers, null)
  assert.deepEqual(caches.cachedPackageUpdates, [])

  caches.setMacLaunchServicesHandlers(launchServicesHandlers)
  assert.equal(caches.macLaunchServicesHandlers, launchServicesHandlers)
  assert.deepEqual(await caches.macLaunchServicesHandlers, [{ LSHandlerContentTag: 'pdf' }])

  caches.replaceCachedPackageUpdates(packageUpdates)
  assert.equal(caches.cachedPackageUpdates, packageUpdates)
  caches.clearCachedPackageUpdates()
  assert.deepEqual(caches.cachedPackageUpdates, [])
})

test('AppCaches records and clears the prevent-sleep blocker id', () => {
  const caches = new AppCaches()

  assert.equal(caches.preventSleepBlockerId, null)
  caches.setPreventSleepBlockerId(41)
  assert.equal(caches.preventSleepBlockerId, 41)
  caches.clearPreventSleepBlockerId()
  assert.equal(caches.preventSleepBlockerId, null)
  caches.clearPreventSleepBlockerId()
  assert.equal(caches.preventSleepBlockerId, null)
})

test('AppCaches stores and disposes the session-title generator without clearing it', () => {
  const caches = new AppCaches()
  let disposeCalls = 0
  const generator = plainObject<NonNullable<AppCaches['sessionTitleGenerator']>>({
    dispose: () => {
      disposeCalls += 1
    }
  })

  assert.equal(caches.sessionTitleGenerator, null)
  caches.setSessionTitleGenerator(generator)
  assert.equal(caches.sessionTitleGenerator, generator)
  caches.disposeSessionTitleGenerator()
  assert.equal(disposeCalls, 1)
  assert.equal(caches.sessionTitleGenerator, generator)
})
