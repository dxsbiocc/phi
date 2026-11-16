import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Execute the actual entrypoint callback with only its external effects replaced.
// Copying the startup sequence into a fixture would not catch a missing quit guard.
const source = ts.createSourceFile(
  'index.ts',
  readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

function startupCallback(): string {
  let callback: ts.ArrowFunction | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'app.whenReady().then' &&
      ts.isArrowFunction(node.arguments[0])
    ) {
      callback = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(callback, 'entrypoint startup callback exists')
  return callback.getText(source)
}

function declaredFunction(name: string): string {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name
  )
  assert.ok(declaration, `${name} exists`)
  return declaration.getText(source)
}

function harness(initiallyQuitting = false): {
  start: () => Promise<void>
  stop: () => void
  releaseSplash: () => void
  calls: string[]
  splash: { closed: number }
  invoke: (name: string) => void
} {
  let quitting = initiallyQuitting
  let releaseSplash!: () => void
  const calls: string[] = []
  const splash = {
    closed: 0,
    isDestroyed: () => false,
    close: (): void => {
      splash.closed += 1
    }
  }
  const pendingSplash = new Promise<typeof splash>((resolve) => {
    releaseSplash = () => resolve(splash)
  })
  const context: Record<string, unknown> = {
    mainWindowRetention: { isQuitting: () => quitting },
    runtime: {
      window: {
        setStartupSplashWindow: () => calls.push('register-splash'),
        resetCleanup: () => calls.push('reset-cleanup')
      }
    },
    openStartupSplash: () => {
      calls.push('open-splash')
      return pendingSplash
    },
    startTeamPackDesktop: () => calls.push('team'),
    requireMainWindowRenderer: () => undefined,
    getActiveWindow: () => undefined,
    sendToAllWindows: () => undefined
  }
  for (const name of [
    'prepareStartupInterface',
    'runStartupMaintenance',
    'migrateStartupPluginEnablement',
    'recoverStartupState',
    'configureStartupWindowDefaults',
    'registerWindowAndFileIpc',
    'registerRemoteFileAndWrapperIpc',
    'registerAgentIpc',
    'registerApplicationAndModelIpc',
    'registerSessionIpc',
    'registerProjectAndAnalysisIpc',
    'registerPluginAndPackageIpc',
    'registerSkillAgentAndMcpIpc',
    'registerWrapperJobsAndPersonaIpc',
    'openInitialWindow',
    'registerAppActivationHandler'
  ]) {
    context[name] = () => calls.push(name)
  }
  function evaluate(code: string): unknown {
    const compiled = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    return runInNewContext(compiled, context)
  }
  const start = evaluate(`(${startupCallback()})`) as () => Promise<void>
  return {
    start,
    stop: () => {
      quitting = true
    },
    releaseSplash,
    calls,
    splash,
    invoke: (name) => {
      evaluate(`${declaredFunction(name)}\n${name}()`)
    }
  }
}

test('quit before ready prevents all startup effects', async () => {
  const state = harness(true)
  state.releaseSplash()
  await state.start()
  assert.deepEqual(state.calls, [])
})

test('quit during splash loading closes the late splash without resuming startup', async () => {
  const state = harness()
  const pending = state.start()
  assert.deepEqual(state.calls, ['prepareStartupInterface', 'open-splash'])
  state.stop()
  state.releaseSplash()
  await pending
  assert.deepEqual(state.calls, ['prepareStartupInterface', 'open-splash'])
  assert.equal(state.splash.closed, 1)
})

test('ordinary startup still registers services and opens the initial window', async () => {
  const state = harness()
  const pending = state.start()
  state.releaseSplash()
  await pending
  assert.ok(state.calls.includes('register-splash'))
  assert.ok(state.calls.includes('registerProjectAndAnalysisIpc'))
  assert.ok(state.calls.includes('openInitialWindow'))
  assert.equal(state.splash.closed, 0)
})

test('late window callbacks do not reset cleanup or schedule new work after quit', () => {
  for (const name of ['createWindow', 'openInitialWindow', 'showMainWindowFromMenuBar']) {
    const state = harness(true)
    state.invoke(name)
    assert.deepEqual(state.calls, [], name)
  }
})
