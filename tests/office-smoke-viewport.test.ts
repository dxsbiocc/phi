import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('Office app smoke follows the native window instead of retaining an emulated viewport', async () => {
  const path = 'scripts/office/smoke-app-pptx-runtime.ts'
  const source = readFileSync(path, 'utf8')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'launch'
  )
  assert.ok(declaration)
  const code = ts.transpileModule(declaration.getText(parsed).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText

  for (const native of [
    { width: 1280, height: 820 },
    { width: 1024, height: 768 }
  ]) {
    let viewport = { width: 1500, height: 950 }
    const page = {
      url: () => 'file:///Phi/out/renderer/index.html',
      setViewport: async (next: typeof native | null): Promise<void> => {
        viewport = next ?? native
      }
    }
    const browser = { pages: async () => [page] }
    const child = {
      exitCode: null,
      signalCode: null,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined }
    }
    const launch = runInNewContext(`${code}\nlaunch`, {
      reservePort: async () => 9222,
      spawn: () => child,
      electronPath: 'Electron',
      repoRoot: '/Phi',
      environment: () => ({}),
      waitUntil: async (_label: string, action: () => Promise<unknown>) => action(),
      connect: async (options: { defaultViewport?: typeof native | null }) => {
        if (options.defaultViewport !== null)
          viewport = options.defaultViewport ?? { width: 800, height: 600 }
        return browser
      }
    }) as (paths: { userDataDir: string }) => Promise<unknown>

    await launch({ userDataDir: '/tmp/isolated-user-data' })
    assert.deepEqual(viewport, native)
  }
})
