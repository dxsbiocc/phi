import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { MessageBoxOptions } from 'electron'
import ts from 'typescript'

import { readAppUiLanguage } from '../src/main/agent/app-settings'
import { redactSensitiveText } from '../src/main/agent/redaction'
import { nativeUiCopy } from '../src/main/native-ui-copy'
import { DEFAULT_UI_LANGUAGE, systemUiLanguage, type UiLanguage } from '../src/shared/uiLanguage'

function launchFixture(
  context: TestContext,
  main: (ready: Promise<void>, stopAfterFailure: () => void) => unknown,
  dialogFailure = false
): {
  loaded: Promise<void>
  ready: () => void
  stopped: Promise<void>
  calls: string[]
  boxes: MessageBoxOptions[]
  logs: string[]
} {
  const directory = mkdtempSync(join(tmpdir(), 'phi-startup-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ uiLanguage: 'zh-CN' }))
  writeFileSync(join(directory, 'model-availability.json'), 'not JSON')

  const calls: string[] = []
  const boxes: MessageBoxOptions[] = []
  const logs: string[] = []
  let ready!: () => void
  let stop!: () => void
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
  })
  const stopAfterFailure = (): void => {
    calls.push('clean shutdown')
    stop()
  }
  const source = readFileSync('src/main/bootstrap.ts', 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  const loaded = runInNewContext(`(async () => { ${outputText}\n })()`, {
    exports: {},
    console: { error: (message: string) => logs.push(message) },
    require(specifier: string): unknown {
      switch (specifier) {
        case 'electron':
          return {
            app: {
              whenReady: () => readiness,
              getPreferredSystemLanguages: () => ['en-US'],
              exit: (code: number) => {
                calls.push(`exit ${code}`)
                stop()
              }
            },
            dialog: {
              showMessageBox: async (options: MessageBoxOptions) => {
                calls.push('show dialog')
                boxes.push(options)
                if (dialogFailure) throw new Error('native dialog fixture')
              }
            }
          }
        case './agent/app-logger':
          return { writeAppLog: (entry: unknown) => logs.push(JSON.stringify(entry)) }
        case './agent/app-settings':
          return {
            readAppUiLanguage: (fallback: UiLanguage) => readAppUiLanguage(fallback, directory)
          }
        case './agent/redaction':
          return { redactSensitiveText }
        case './native-ui-copy':
          return { nativeUiCopy }
        case '../shared/uiLanguage':
          return { DEFAULT_UI_LANGUAGE, systemUiLanguage }
        case './index':
          return main(readiness, stopAfterFailure)
        default:
          throw new Error(`Unexpected module ${specifier}`)
      }
    }
  }) as Promise<void>
  return { loaded, ready, stopped, calls, boxes, logs }
}

test(
  'a main import failure opens the localized Phi dialog after ready and exits',
  { timeout: 2_000 },
  async (t) => {
    const fixture = launchFixture(t, () => {
      throw new Error('token=fixture-startup-secret')
    })
    await fixture.loaded
    assert.deepEqual(fixture.calls, [])
    fixture.ready()
    await fixture.stopped
    assert.deepEqual(fixture.calls, ['show dialog', 'exit 1'])
    assert.equal(fixture.boxes[0]?.title, 'Phi')
    assert.equal(fixture.boxes[0]?.message, 'Phi 启动失败')
    assert.doesNotMatch(JSON.stringify([fixture.logs, fixture.boxes]), /fixture-startup-secret/)
    assert.match(fixture.logs.join('\n'), /bootstrap_load_failed/)
  }
)

test(
  'an initialization rejection opens one dialog and uses the existing shutdown path',
  { timeout: 2_000 },
  async (t) => {
    const fixture = launchFixture(t, (ready, stopAfterFailure) => ({
      startup: ready.then(() => {
        throw new Error('initialization fixture')
      }),
      stopAfterStartupFailure: stopAfterFailure
    }))
    await fixture.loaded
    assert.deepEqual(fixture.calls, [])
    fixture.ready()
    await fixture.stopped
    assert.deepEqual(fixture.calls, ['show dialog', 'clean shutdown'])
    assert.match(fixture.logs.join('\n'), /bootstrap_initialization_failed/)
  }
)

test(
  'an unprintable error and failed native dialog cannot prevent shutdown',
  { timeout: 2_000 },
  async (t) => {
    const fixture = launchFixture(
      t,
      () => {
        throw Object.create(null)
      },
      true
    )
    await fixture.loaded
    fixture.ready()
    await fixture.stopped
    assert.deepEqual(fixture.calls, ['show dialog', 'exit 1'])
    assert.match(fixture.logs.join('\n'), /Could not read the startup error/)
    assert.match(fixture.logs.join('\n'), /Could not show the startup dialog/)
  }
)
