import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as appSettings from '../src/main/agent/app-settings'
import * as management from '../src/main/agent/model-management'
import { IPC } from '../src/shared/ipcChannels'

test('model-management IPC exposes only discovery/toggles and validates targets without auth/session actions', async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-model-ipc-'))
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  const handlers = new Map<string, (event?: unknown, input?: unknown) => Promise<unknown>>()
  const native = { providerId: 'typesafe', modelId: 'jev', name: 'JEV', configured: true }
  const engine = {
    models: {
      snapshot: async () => ({
        providers: [{ id: 'typesafe', name: 'TypeSafe' }],
        models: [],
        credentials: []
      })
    },
    decisions: { models: async () => [native] }
  }
  const exports: { registerSettingsIpc?: (options: unknown) => void } = {}
  runInNewContext(
    ts.transpileModule(readFileSync('src/main/ipc/settings-ipc.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (name: string) => {
        if (name.endsWith('/ipcChannels')) return { IPC }
        if (name.endsWith('/app-settings')) return appSettings
        if (name.endsWith('/model-management'))
          return {
            getModelAvailability: (dir: string) => management.getModelAvailability(dir, engine),
            setModelEnabled: (input: unknown, dir: string) =>
              management.setModelEnabled(input, dir, engine)
          }
        if (name.endsWith('/in-process-engine')) return { getPhiEngine: () => engine }
        throw new Error(`Unexpected import ${name}`)
      }
    }
  )
  exports.registerSettingsIpc!({
    agentDir,
    ipcMain: {
      handle: (channel: string, handler: (event?: unknown, input?: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler)
    },
    syncPreventSleepBlocker: () => undefined
  })
  assert.equal(handlers.has('settings:decisionModels'), false)
  const initial = (await handlers.get(IPC.models.availability)!()) as { models: unknown[] }
  assert.deepEqual(initial.models, [{ ...native, kind: 'decision', enabled: true }])
  const disabled = (await handlers.get(IPC.models.setEnabled)!(undefined, {
    providerId: 'typesafe',
    enabled: false
  })) as { disabledProviders: string[] }
  assert.deepEqual(disabled.disabledProviders, ['typesafe'])
  await assert.rejects(
    handlers.get(IPC.models.setEnabled)!(undefined, { providerId: 'unknown', enabled: false }),
    /Unknown/
  )
  assert.deepEqual(appSettings.readAppSettings(agentDir).modelAvailability?.disabledProviders, [
    'typesafe'
  ])
})
