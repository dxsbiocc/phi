import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { createPlanRunApi } from '../src/preload/plan-run-api'
import { IPC } from '../src/shared/ipcChannels'

const TEAM_PACK_CALLS = [
  ['getMemberSnapshot'],
  ['listSources'],
  ['pickSourceDirectory'],
  [
    'previewSource',
    { location: { kind: 'https', url: 'https://teams.example/acme' }, fingerprint: 'a'.repeat(16) }
  ],
  [
    'addSource',
    { location: { kind: 'directory', path: '/shared/acme' }, fingerprint: 'b'.repeat(16) }
  ],
  ['checkSource', { sourceId: 'source-1' }],
  ['removeSource', { sourceId: 'source-1' }],
  ['exportMemberBackup', { passphrase: 'member-backup-passphrase' }],
  ['importMemberBackup', { passphrase: 'member-backup-passphrase' }],
  ['listSubmissionCandidates', { sourceId: 'source-1' }],
  [
    'submitPackages',
    { sourceId: 'source-1', packages: [{ type: 'skill', id: 'literature-review' }] }
  ],
  ['listAdminTeams'],
  ['getAdminTeam', { teamId: 'acme-lab' }],
  ['createAdminTeam', { name: 'Acme Lab' }],
  ['exportAdminBackup', { teamId: 'acme-lab', passphrase: 'admin-backup-passphrase' }],
  ['importAdminBackup', { passphrase: 'admin-backup-passphrase' }],
  [
    'addAdminMember',
    { teamId: 'acme-lab', displayName: 'Researcher', recipient: `age1${'q'.repeat(58)}` }
  ],
  ['removeAdminMember', { teamId: 'acme-lab', memberId: 'member-1' }],
  [
    'setAdminMemberModels',
    {
      teamId: 'acme-lab',
      memberId: 'member-1',
      models: [{ providerId: 'openai', label: 'Team key', apiKey: 'one-way-secret' }]
    }
  ],
  [
    'publishAdminRelease',
    { teamId: 'acme-lab', packages: [{ type: 'skill', id: 'literature-review' }] }
  ],
  ['withdrawAdminRelease', { teamId: 'acme-lab', release: 1 }],
  ['listAdminSubmissions', { teamId: 'acme-lab' }],
  ['importAdminSubmission', { teamId: 'acme-lab' }],
  ['acceptAdminSubmission', { teamId: 'acme-lab', entryId: 'entry-1' }],
  ['deleteAdminSubmission', { teamId: 'acme-lab', entryId: 'entry-1' }]
] as const

test('preload exposes one nested teamPack API and forwards each payload unchanged', async () => {
  const compiled = ts.transpileModule(readFileSync(resolve('src/preload/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const exposed = new Map<string, unknown>()
  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return undefined
    }
  }
  const ipcRenderer = new FakeIpcRenderer()
  new Function('require', 'exports', 'process', 'window', 'console', compiled)(
    (specifier: string) => {
      if (specifier === '../shared/ipcChannels') return { IPC }
      if (specifier === './plan-run-api') return { createPlanRunApi }
      assert.equal(specifier, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (name: string, value: unknown): void => {
            exposed.set(name, value)
          }
        },
        ipcRenderer,
        webUtils: { getPathForFile: (): string => '' }
      }
    },
    {},
    { contextIsolated: true, platform: 'darwin', env: {} },
    { addEventListener: (): void => undefined },
    console
  )

  const rootApi = exposed.get('api') as {
    teamPack?: Record<string, (...args: unknown[]) => unknown>
  }
  assert.ok(rootApi.teamPack)
  assert.deepEqual(
    Object.keys(rootApi.teamPack).sort(),
    TEAM_PACK_CALLS.map(([name]) => name).sort()
  )

  const channels = IPC.teamPack as Record<string, string>
  for (const [method, input] of TEAM_PACK_CALLS) {
    assert.equal(typeof channels[method], 'string', `missing IPC.teamPack.${method}`)
    await rootApi.teamPack[method]!(...(input === undefined ? [] : [input]))
  }

  assert.deepEqual(
    calls,
    TEAM_PACK_CALLS.map(([method, input]) => ({
      channel: channels[method]!,
      args: input === undefined ? [] : [input]
    }))
  )
})

test('ambient preload contract reuses the shared nested TeamPackRendererApi', () => {
  const ambient = readFileSync(resolve('src/preload/index.d.ts'), 'utf8')
  assert.match(ambient, /import type \{ TeamPackRendererApi \} from '\.\.\/shared\/teamPackTypes'/u)
  assert.match(ambient, /teamPack: TeamPackRendererApi/u)
  assert.doesNotMatch(ambient, /getMemberSnapshot: \(\)/u)
})

test('main registers TeamPack IPC with safe storage, live native copy, shared services, and shutdown', () => {
  const main = readFileSync(resolve('src/main/index.ts'), 'utf8')
  const desktop = readFileSync(resolve('src/main/team-pack-desktop.ts'), 'utf8')
  const nativeCopy = readFileSync(resolve('src/main/native-ui-copy.ts'), 'utf8')

  assert.match(
    main,
    /startTeamPackDesktop\(\{ requireMainWindowRenderer, getActiveWindow, sendToAllWindows \}\)/u
  )
  assert.match(
    main,
    /safeCleanupStep\('team_source_service_cleanup_failed', closeTeamPackDesktop\)/u
  )

  assert.match(
    desktop,
    /import \{ registerTeamPackIpc, type TeamPackIpcOptions \} from '\.\/ipc\/team-pack-ipc'/u
  )
  assert.match(desktop, /dialogs: teamPackDialogs\(options\)/u)
  assert.match(desktop, /new TeamPackAdminService\(\{ agentDir, safeStorage \}\)/u)
  assert.match(desktop, /new TeamMemberSubmissionService\(\{ agentDir, safeStorage \}\)/u)
  assert.match(desktop, /authStorage: \(\) => getAuthManager\(\)\.getRuntime\(\)/u)
  assert.match(
    desktop,
    /onCredentialsChanged: \(\) => options\.sendToAllWindows\(IPC\.auth\.credentialsChanged\)/u
  )
  assert.match(desktop, /registerTeamPackIpc\(\{\s*ipcMain,\s*requireMainWindowRenderer,/u)
  assert.match(desktop, /desktop\.registerIpc\(ipcMain, options\.requireMainWindowRenderer\)/u)
  assert.match(desktop, /getPublicKey: \(\) => getMemberPublicKey\(memberIdentityOptions\)/u)
  assert.match(desktop, /listSources: \(\) => sources\.listSources\(\)/u)
  assert.match(desktop, /start: \(\) => scheduler\.start\(\)/u)
  assert.match(desktop, /\badmin,/u)
  assert.match(desktop, /nativeUiCopy\(readAppSettings\(\)\.uiLanguage\)/u)
  assert.match(desktop, /app\.once\('browser-window-created'/u)
  assert.match(desktop, /running\?\.stopScheduler\(\)\s*await running\?\.close\(\)/u)

  for (const key of [
    'selectTeamSource',
    'exportMemberIdentity',
    'importMemberIdentity',
    'exportTeamSigningKey',
    'importTeamSigningKey',
    'selectTeamPublishFolder',
    'ageBackupFile',
    'exportTeamSubmission',
    'importTeamSubmission',
    'teamSubmissionFile'
  ]) {
    assert.equal((nativeCopy.match(new RegExp(`\\b${key}:`, 'gu')) ?? []).length, 2, key)
  }
})
