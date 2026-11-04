import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTeamPackIpc, type TeamPackIpcOptions } from '../src/main/ipc/team-pack-ipc'
import { IPC } from '../src/shared/ipcChannels'

type Handler = (_event: unknown, input?: unknown) => Promise<unknown>

const source = {
  id: 'source-alpha',
  teamId: 'alpha-team',
  teamName: 'Alpha Team',
  teamKeyId: 'a'.repeat(16),
  location: { kind: 'directory' as const, path: '/tmp/alpha-team' },
  addedAt: '2026-11-04T00:00:00.000Z',
  status: {
    lastSuccessfulRelease: 2,
    lastCheckedAt: '2026-11-04T01:00:00.000Z',
    lastErrorCode: null,
    withdrawnReleases: [1],
    credentialConflicts: ['anthropic'],
    skippedProviders: ['unsupported']
  }
}

function fakeAdmin(): TeamPackIpcOptions['admin'] {
  return {
    listTeams: () => [
      {
        teamId: 'alpha-team',
        name: 'Alpha Team',
        publicKeyFingerprint: 'a'.repeat(16)
      }
    ],
    getTeamSummary: () => ({
      teamId: 'alpha-team',
      name: 'Alpha Team',
      publicKeyFingerprint: 'a'.repeat(16),
      currentMemberCount: 1,
      modelGrants: [
        { memberId: 'member-1', models: [{ providerId: 'openai', label: 'Team OpenAI' }] }
      ],
      latestRelease: 2,
      releases: [
        {
          release: 2,
          publishedAt: '2026-11-04T02:00:00.000Z',
          memberIds: ['member-1'],
          withdrawn: false
        }
      ],
      withdrawnReleases: [1],
      storeDir: '/team/publish'
    }),
    listMembers: () => [
      {
        memberId: 'member-1',
        displayName: 'Alice',
        recipient: 'age1public-member-recipient',
        addedAt: '2026-11-04T01:00:00.000Z'
      }
    ],
    createTeam: () => ({
      teamId: 'alpha-team',
      name: 'Alpha Team',
      publicKeyFingerprint: 'a'.repeat(16),
      backupRequired: true as const,
      warning: 'backup required'
    }),
    exportSigningKeyBackup: async () => undefined,
    importSigningKeyBackup: async () => ({
      teamId: 'alpha-team',
      name: 'Alpha Team',
      publicKeyFingerprint: 'a'.repeat(16)
    }),
    addMember: () => ({
      memberId: 'member-1',
      displayName: 'Alice',
      recipient: 'age1public-member-recipient',
      addedAt: '2026-11-04T01:00:00.000Z'
    }),
    removeMember: () => ({
      memberId: 'member-1',
      displayName: 'Alice',
      recipient: 'age1public-member-recipient',
      addedAt: '2026-11-04T01:00:00.000Z',
      removedAt: '2026-11-04T03:00:00.000Z',
      modelKeyRevocationWarning: 'revoke upstream'
    }),
    setMemberModelGrants: () => ({
      memberId: 'member-1',
      models: [{ providerId: 'openai', label: 'Team OpenAI' }]
    }),
    publishRelease: async () => ({
      release: 3,
      payloadBytes: 100,
      manifestSha256: 'b'.repeat(64),
      storeDir: '/team/publish',
      packages: [{ type: 'skill' as const, id: 'shared-skill', version: '1.0.0' }],
      withdrawnReleases: [1]
    }),
    withdrawRelease: async () => ({
      release: 4,
      payloadBytes: 100,
      manifestSha256: 'c'.repeat(64),
      storeDir: '/team/publish',
      packages: [{ type: 'skill' as const, id: 'shared-skill', version: '1.0.0' }],
      withdrawnReleases: [1, 2]
    })
  }
}

function harness(
  admin = fakeAdmin(),
  requireMainWindowRenderer: TeamPackIpcOptions['requireMainWindowRenderer'] = () => undefined
): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerTeamPackIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as Handler)
      }
    },
    requireMainWindowRenderer,
    member: {
      getRecipient: async () => 'age1public-recipient',
      exportBackup: async () => undefined,
      importBackup: async () => 'age1imported-recipient'
    },
    sources: {
      listSources: () => [source],
      configuredProviders: () => ['openai'],
      previewSource: async () => ({
        teamId: 'alpha-team',
        teamName: 'Alpha Team',
        teamKeyId: 'a'.repeat(16),
        location: { kind: 'directory', path: '/tmp/alpha-team' }
      }),
      addSource: async () => source,
      pullSource: async () => source,
      removeSource: async () => false
    },
    scheduler: { start: async () => undefined, stop: () => undefined },
    admin,
    dialogs: {
      pickSourceDirectory: async () => '/chosen/team-source',
      pickMemberBackupExport: async () => '/chosen/member-backup.age',
      pickMemberBackupImport: async () => '/chosen/member-backup.age',
      pickAdminBackupExport: async () => '/chosen/admin-backup.age',
      pickAdminBackupImport: async () => '/chosen/admin-backup.age',
      pickPublishDirectory: async () => '/team/publish'
    }
  })
  return handlers
}

test('member snapshot exposes only the public recipient in a result envelope', async () => {
  const handler = harness().get(IPC.teamPack.getMemberSnapshot)
  assert.ok(handler)

  const result = await handler(null)

  assert.deepEqual(result, {
    ok: true,
    value: { recipient: 'age1public-recipient' }
  })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('identity'), false)
  assert.equal(serialized.includes('private'), false)
  assert.equal(serialized.includes('apiKey'), false)
})

test('every privileged team-pack handler rejects an untrusted renderer first', async () => {
  const handlers = harness(fakeAdmin(), () => {
    throw new Error('untrusted team-pack renderer')
  })

  assert.equal(handlers.size, Object.keys(IPC.teamPack).length)
  for (const [channel, handler] of handlers) {
    assert.throws(() => handler({ sender: {} }), /untrusted team-pack renderer/, channel)
  }
})

test('admin list and detail expose no signing or model key material', async () => {
  const handlers = harness()
  const list = handlers.get(IPC.teamPack.listAdminTeams)
  const detail = handlers.get(IPC.teamPack.getAdminTeam)
  assert.ok(list)
  assert.ok(detail)

  assert.deepEqual(await list(null), {
    ok: true,
    value: [
      {
        teamId: 'alpha-team',
        name: 'Alpha Team',
        publicKeyFingerprint: 'a'.repeat(16)
      }
    ]
  })
  const result = await detail(null, { teamId: 'alpha-team' })
  assert.equal((result as { ok: boolean }).ok, true)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('apiKey'), false)
  assert.equal(serialized.includes('privateKey'), false)
  assert.equal(serialized.includes('identity'), false)
  assert.equal(serialized.includes('keySha256'), false)
  assert.equal(serialized.includes('credentialId'), false)
})

test('admin team and roster mutations accept only public identity fields', async () => {
  const handlers = harness()
  const create = handlers.get(IPC.teamPack.createAdminTeam)
  const addMember = handlers.get(IPC.teamPack.addAdminMember)
  const removeMember = handlers.get(IPC.teamPack.removeAdminMember)
  assert.ok(create)
  assert.ok(addMember)
  assert.ok(removeMember)

  assert.equal(((await create(null, { name: 'Alpha Team' })) as { ok: boolean }).ok, true)
  assert.equal(
    (
      (await addMember(null, {
        teamId: 'alpha-team',
        displayName: 'Alice',
        recipient: `age1${'q'.repeat(58)}`
      })) as { ok: boolean }
    ).ok,
    true
  )
  const removed = await removeMember(null, { teamId: 'alpha-team', memberId: 'member-1' })
  assert.equal((removed as { ok: boolean }).ok, true)
  assert.equal(JSON.stringify(removed).includes('apiKey'), false)
})

test('model sub-key moves only into the admin service and returns metadata only', async () => {
  let received: unknown
  const admin = {
    ...fakeAdmin(),
    setMemberModelGrants: (input: unknown) => {
      received = input
      return {
        memberId: 'member-1',
        models: [{ providerId: 'openai', label: 'Team OpenAI' }]
      }
    }
  }
  const handler = harness(admin).get(IPC.teamPack.setAdminMemberModels)
  assert.ok(handler)
  const request = {
    teamId: 'alpha-team',
    memberId: 'member-1',
    models: [
      {
        providerId: 'openai',
        label: 'Team OpenAI',
        apiKey: 'one-way-secret',
        baseUrl: 'https://api.openai.com/'
      }
    ]
  }

  const result = await handler(null, request)

  assert.deepEqual(received, request)
  assert.deepEqual(result, {
    ok: true,
    value: {
      memberId: 'member-1',
      models: [{ providerId: 'openai', label: 'Team OpenAI' }]
    }
  })
  assert.equal(JSON.stringify(result).includes('one-way-secret'), false)
  assert.equal(JSON.stringify(result).includes('apiKey'), false)
})

test('admin signing-key backups use main-process paths and return public metadata only', async () => {
  const handlers = harness()
  const exportBackup = handlers.get(IPC.teamPack.exportAdminBackup)
  const importBackup = handlers.get(IPC.teamPack.importAdminBackup)
  assert.ok(exportBackup)
  assert.ok(importBackup)

  assert.deepEqual(
    await exportBackup(null, {
      teamId: 'alpha-team',
      passphrase: 'correct horse battery staple'
    }),
    { ok: true, value: { exported: true } }
  )
  const imported = await importBackup(null, { passphrase: 'correct horse battery staple' })
  assert.deepEqual(imported, {
    ok: true,
    value: {
      imported: true,
      team: {
        teamId: 'alpha-team',
        name: 'Alpha Team',
        publicKeyFingerprint: 'a'.repeat(16)
      }
    }
  })
  assert.equal(JSON.stringify(imported).includes('privateKey'), false)
  assert.equal(JSON.stringify(imported).includes('passphrase'), false)
})

test('publishing accepts package selections only and withdraws by release number', async () => {
  const calls: unknown[] = []
  const base = fakeAdmin()
  const admin = {
    ...base,
    getTeamSummary: () => ({ ...base.getTeamSummary(), storeDir: null }),
    publishRelease: async (input: unknown) => {
      calls.push(['publish', input])
      return base.publishRelease()
    },
    withdrawRelease: async (input: unknown) => {
      calls.push(['withdraw', input])
      return base.withdrawRelease()
    }
  }
  const handlers = harness(admin)
  const publish = handlers.get(IPC.teamPack.publishAdminRelease)
  const withdraw = handlers.get(IPC.teamPack.withdrawAdminRelease)
  assert.ok(publish)
  assert.ok(withdraw)

  const published = await publish(null, {
    teamId: 'alpha-team',
    packages: [{ type: 'skill', id: 'shared-skill' }]
  })
  assert.equal((published as { ok: boolean }).ok, true)
  assert.equal(JSON.stringify(published).includes('apiKey'), false)
  assert.equal(
    ((await withdraw(null, { teamId: 'alpha-team', release: 2 })) as { ok: boolean }).ok,
    true
  )
  assert.deepEqual(calls, [
    [
      'publish',
      {
        teamId: 'alpha-team',
        storeDir: '/team/publish',
        packages: [{ type: 'skill', id: 'shared-skill' }]
      }
    ],
    ['withdraw', { teamId: 'alpha-team', release: 2 }]
  ])
})

test('member backups obtain paths in main and never return identity material', async () => {
  const handlers = harness()
  const exportBackup = handlers.get(IPC.teamPack.exportMemberBackup)
  const importBackup = handlers.get(IPC.teamPack.importMemberBackup)
  assert.ok(exportBackup)
  assert.ok(importBackup)

  assert.deepEqual(await exportBackup(null, { passphrase: 'correct horse battery staple' }), {
    ok: true,
    value: { exported: true }
  })
  const imported = await importBackup(null, { passphrase: 'correct horse battery staple' })
  assert.deepEqual(imported, {
    ok: true,
    value: { imported: true, recipient: 'age1imported-recipient' }
  })
  const serialized = JSON.stringify(imported)
  assert.equal(serialized.includes('identity'), false)
  assert.equal(serialized.includes('passphrase'), false)
})

test('source directory selection stays behind the main-process dialog boundary', async () => {
  const handler = harness().get(IPC.teamPack.pickSourceDirectory)
  assert.ok(handler)

  assert.deepEqual(await handler(null), {
    ok: true,
    value: '/chosen/team-source'
  })
})

test('checking a source returns its latest public status', async () => {
  const handler = harness().get(IPC.teamPack.checkSource)
  assert.ok(handler)

  const result = await handler(null, { sourceId: source.id })

  assert.equal((result as { ok: boolean }).ok, true)
  assert.equal(
    (result as { value: { status: { lastSuccessfulRelease: number } } }).value.status
      .lastSuccessfulRelease,
    2
  )
})

test('adding a source starts scheduling and removing the final source stops it', async () => {
  const handlers = new Map<string, Handler>()
  let sources = [source]
  const lifecycle: string[] = []
  registerTeamPackIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as Handler)
    },
    requireMainWindowRenderer: () => undefined,
    member: {
      getRecipient: async () => 'age1public-recipient',
      exportBackup: async () => undefined,
      importBackup: async () => 'age1imported-recipient'
    },
    sources: {
      listSources: () => sources,
      configuredProviders: () => [],
      previewSource: async () => ({
        teamId: source.teamId,
        teamName: source.teamName,
        teamKeyId: source.teamKeyId,
        location: source.location
      }),
      addSource: async () => source,
      pullSource: async () => source,
      removeSource: async () => {
        sources = []
        return true
      }
    },
    scheduler: {
      start: async () => {
        lifecycle.push('start')
        sources = [
          {
            ...source,
            status: { ...source.status, lastSuccessfulRelease: 3 }
          }
        ]
      },
      stop: () => lifecycle.push('stop')
    },
    admin: fakeAdmin(),
    dialogs: {
      pickSourceDirectory: async () => null,
      pickMemberBackupExport: async () => null,
      pickMemberBackupImport: async () => null,
      pickAdminBackupExport: async () => null,
      pickAdminBackupImport: async () => null,
      pickPublishDirectory: async () => null
    }
  })

  const add = handlers.get(IPC.teamPack.addSource)
  const remove = handlers.get(IPC.teamPack.removeSource)
  assert.ok(add)
  assert.ok(remove)

  const input = {
    location: source.location,
    fingerprint: source.teamKeyId
  }
  const added = await add(null, input)
  assert.equal((added as { ok: boolean }).ok, true)
  assert.equal(
    (added as { value: { status: { lastSuccessfulRelease: number } } }).value.status
      .lastSuccessfulRelease,
    3
  )
  assert.deepEqual(lifecycle, ['start'])

  assert.deepEqual(await remove(null, { sourceId: source.id }), {
    ok: true,
    value: { removed: true }
  })
  assert.deepEqual(lifecycle, ['start', 'stop'])
})

test('source preview returns the confirmed team identity without saving it', async () => {
  const handler = harness().get(IPC.teamPack.previewSource)
  assert.ok(handler)

  const result = await handler(null, {
    location: { kind: 'directory', path: '/tmp/alpha-team' },
    fingerprint: 'a'.repeat(16)
  })

  assert.deepEqual(result, {
    ok: true,
    value: {
      teamId: 'alpha-team',
      teamName: 'Alpha Team',
      publicKeyFingerprint: 'a'.repeat(16),
      location: { kind: 'directory', path: '/tmp/alpha-team' }
    }
  })
})

test('source list projects configured provider IDs without credential ownership secrets', async () => {
  const handler = harness().get(IPC.teamPack.listSources)
  assert.ok(handler)

  const result = await handler(null)

  assert.deepEqual(result, {
    ok: true,
    value: [
      {
        id: 'source-alpha',
        teamId: 'alpha-team',
        teamName: 'Alpha Team',
        publicKeyFingerprint: 'a'.repeat(16),
        location: { kind: 'directory', path: '/tmp/alpha-team' },
        addedAt: '2026-11-04T00:00:00.000Z',
        status: {
          lastSuccessfulRelease: 2,
          lastCheckedAt: '2026-11-04T01:00:00.000Z',
          lastErrorCode: null,
          withdrawnReleases: [1],
          credentialConflicts: ['anthropic'],
          skippedProviders: ['unsupported'],
          configuredProviders: ['openai']
        }
      }
    ]
  })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('keySha256'), false)
  assert.equal(serialized.includes('credentialId'), false)
  assert.equal(serialized.includes('apiKey'), false)
})

test('main-process validation rejects malformed and over-posted requests', async () => {
  const handlers = harness()
  const invalidCalls: Array<[string, unknown]> = [
    [
      IPC.teamPack.previewSource,
      {
        location: source.location,
        fingerprint: source.teamKeyId,
        identity: 'must-not-cross'
      }
    ],
    [IPC.teamPack.checkSource, { sourceId: '../escape' }],
    [IPC.teamPack.createAdminTeam, { name: ' Alpha Team' }],
    [
      IPC.teamPack.addAdminMember,
      {
        teamId: 'alpha-team',
        displayName: 'Alice',
        recipient: `age1${'q'.repeat(58)}`,
        privateKey: 'must-not-cross'
      }
    ],
    [
      IPC.teamPack.setAdminMemberModels,
      {
        teamId: 'alpha-team',
        memberId: 'member-1',
        models: [
          {
            providerId: 'openai',
            label: 'Team OpenAI',
            apiKey: 'secret',
            unexpected: true
          }
        ]
      }
    ],
    [
      IPC.teamPack.setAdminMemberModels,
      {
        teamId: 'alpha-team',
        memberId: 'member-1',
        models: [
          { providerId: 'openai', label: 'Primary', apiKey: 'first-secret' },
          { providerId: 'openai', label: 'Secondary', apiKey: 'second-secret' }
        ]
      }
    ],
    [
      IPC.teamPack.publishAdminRelease,
      { teamId: 'alpha-team', packages: [{ type: 'skill', id: '../bad' }] }
    ],
    [IPC.teamPack.withdrawAdminRelease, { teamId: 'alpha-team', release: 0 }],
    [
      IPC.teamPack.exportAdminBackup,
      { teamId: 'alpha-team', passphrase: 'secret', backupPath: '/renderer/chosen' }
    ]
  ]

  for (const [channel, input] of invalidCalls) {
    const handler = handlers.get(channel)
    assert.ok(handler, channel)
    const result = await handler(null, input)
    assert.equal((result as { ok: boolean }).ok, false, channel)
    assert.equal((result as { error: { code: string } }).error.code, 'INVALID_FORMAT', channel)
    assert.equal(JSON.stringify(result).includes('must-not-cross'), false, channel)
  }
})

test('unexpected failures are normalized without echoing sensitive exception text', async () => {
  const admin = {
    ...fakeAdmin(),
    createTeam: () => {
      throw new Error('upstream accidentally included private-key-secret')
    }
  }
  const handler = harness(admin).get(IPC.teamPack.createAdminTeam)
  assert.ok(handler)

  const result = await handler(null, { name: 'Alpha Team' })

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'STORE_UNAVAILABLE', message: '团队包操作暂时不可用' }
  })
  assert.equal(JSON.stringify(result).includes('private-key-secret'), false)
})
