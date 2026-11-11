import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { AppUpdateCheck } from '../src/shared/appUpdateTypes'
import type { PackageUpdateView } from '../src/shared/packageManagerTypes'
import {
  appUpdateMessageId,
  buildMessages,
  messageIdsForContent,
  orderMessagesByReadState,
  packageUpdateMessageId
} from '../src/renderer/src/features/messages/lib/messages'
import {
  MESSAGE_READ_STORAGE_KEY,
  markMessageRead,
  readMessageReadIds,
  unreadMessageCount,
  writeMessageReadIds,
  type MessageReadStorage
} from '../src/renderer/src/features/messages/lib/messageReadState'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

class MemoryStorage implements MessageReadStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function update(overrides: Partial<PackageUpdateView> = {}): PackageUpdateView {
  return {
    id: 'demo-skill',
    type: 'skill',
    title: 'Demo Skill',
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    registryId: 'official',
    registryPath: 'skills/demo-skill',
    trust: 'official',
    ...overrides
  }
}

function appUpdate(overrides: Partial<AppUpdateCheck> = {}): AppUpdateCheck {
  return {
    status: 'available',
    currentVersion: '0.1.6',
    latestVersion: '0.2.0',
    releasesUrl: 'https://github.com/Phi-Science/Phi/releases/tag/v0.2.0',
    checkedAt: '2026-10-24T10:00:00.000Z',
    ...overrides
  }
}

test.afterEach(() => setUiLanguage('en'))

test('each content package update becomes its own localized message', () => {
  const updates = [
    update({
      id: 'visualization',
      type: 'plugin',
      title: '科研绘图',
      currentVersion: '0.6.0',
      newVersion: '0.7.0'
    }),
    update({ id: 'z-skill', type: 'skill', title: 'Zeta', newVersion: '2.0.0' })
  ]

  setUiLanguage('zh-CN')
  const chinese = buildMessages({ updates, appUpdate: null })
  assert.equal(chinese.length, 2)

  const [plugin, skill] = chinese
  assert.ok(plugin)
  assert.equal(plugin.id, 'package:plugin:visualization@0.7.0')
  assert.equal(plugin.kind, 'package-update')
  assert.equal(plugin.title, 'Visualization')
  assert.equal(plugin.subtitle, '0.6.0 → 0.7.0')
  assert.equal(plugin.status, '可更新')
  assert.equal(plugin.packageType, 'plugin')
  assert.equal(plugin.packageUpdate?.id, 'visualization')

  assert.ok(skill)
  assert.equal(skill.id, 'package:skill:z-skill@2.0.0')
  assert.equal(skill.title, 'Zeta')
  assert.equal(skill.subtitle, '1.0.0 → 2.0.0')
  assert.equal(skill.status, '可更新')
  assert.equal(skill.packageType, 'skill')

  setUiLanguage('en')
  const english = buildMessages({ updates, appUpdate: null })
  assert.deepEqual(
    english.map((message) => message.id),
    chinese.map((message) => message.id)
  )
  assert.equal(english[0]?.title, 'Visualization')
  assert.equal(english[0]?.status, 'Update available')
  assert.equal(english[1]?.subtitle, '1.0.0 → 2.0.0')
})

test('package and app message ids stay stable and versioned', () => {
  const first = [update()]
  const second = [update({ newVersion: '1.2.0' })]
  assert.equal(packageUpdateMessageId(first[0]!), 'package:skill:demo-skill@1.1.0')
  assert.notEqual(packageUpdateMessageId(first[0]!), packageUpdateMessageId(second[0]!))
  assert.deepEqual(messageIdsForContent(first, appUpdate()), [
    'package:skill:demo-skill@1.1.0',
    appUpdateMessageId('0.2.0')
  ])
  assert.deepEqual(messageIdsForContent([], appUpdate()), ['app@0.2.0'])
})

test('an available app update stays one localized message', () => {
  setUiLanguage('zh-CN')
  const [chinese] = buildMessages({ updates: [], appUpdate: appUpdate() })
  assert.ok(chinese)
  assert.equal(chinese.id, 'app@0.2.0')
  assert.equal(chinese.kind, 'app-update')
  assert.equal(chinese.title, 'Phi 0.2.0 可用')
  assert.equal(chinese.subtitle, '当前版本 0.1.6')
  assert.equal(chinese.status, '可用')
  assert.equal(chinese.releasesUrl, appUpdate().releasesUrl)

  setUiLanguage('en')
  const [english] = buildMessages({ updates: [], appUpdate: appUpdate() })
  assert.ok(english)
  assert.equal(english.title, 'Phi 0.2.0 is available')
  assert.equal(english.subtitle, 'Current version 0.1.6')
  assert.equal(english.status, 'Available')
})

test('up-to-date and failed update checks produce no app message', () => {
  for (const status of ['up-to-date', 'error'] as const) {
    assert.deepEqual(
      buildMessages({ updates: [], appUpdate: appUpdate({ status, latestVersion: '0.2.0' }) }),
      []
    )
  }
})

test('unread messages stay first, then read messages in their stable order', () => {
  const messages = buildMessages({
    updates: [update({ id: 'alpha' }), update({ id: 'beta' })],
    appUpdate: appUpdate()
  })
  const read = new Set([messages[1]!.id])
  assert.deepEqual(
    orderMessagesByReadState(messages, read).map((message) => message.id),
    [messages[0]!.id, messages[2]!.id, messages[1]!.id]
  )
})

test('opening the panel does not mark read; reading one leaves the others unread', () => {
  const messages = buildMessages({
    updates: [update({ id: 'alpha' }), update({ id: 'beta' })],
    appUpdate: appUpdate()
  })
  const ids = messages.map((message) => message.id)

  // Nothing is written just by building the list the panel renders.
  const unopened = new Set<string>()
  assert.equal(unreadMessageCount(ids, unopened), 3)

  const afterOneClick = markMessageRead(unopened, ids, ids[0]!)
  assert.equal(unreadMessageCount(ids, afterOneClick), 2)
  assert.ok(afterOneClick.has(ids[0]!))
  assert.ok(!afterOneClick.has(ids[1]!))

  const panel = readFileSync('src/renderer/src/features/messages/MessagesPanel.tsx', 'utf8')
  assert.doesNotMatch(panel, /markAllRead|markAllMessagesRead/)
  assert.match(panel, /markRead\(message\.id\)/)
  assert.match(panel, /orderMessagesByReadState/)
  assert.match(panel, /statusPlacement="center"/)
  assert.doesNotMatch(panel, /PackageUpdatesDialog|applyAllPackageUpdates|onApplyAll/)
})

test('starting a package update closes the dialog before the background update finishes', () => {
  const panel = readFileSync('src/renderer/src/features/messages/MessagesPanel.tsx', 'utf8')
  const apply = panel
    .split('function apply(update: PackageUpdateView): void {')[1]
    ?.split('function openMessage(')[0]
  assert.ok(apply)

  const close = apply.indexOf('setSelectedUpdate(null)')
  const start = apply.indexOf('void (async')
  const run = apply.indexOf('await window.api.applyPackageUpdate')
  assert.ok(close >= 0)
  assert.ok(start > close)
  assert.ok(run > start)
  assert.match(apply, /await refresh\(\)/)
  assert.match(apply, /if \(updatingKeysRef\.current\.has\(key\)\) return/)

  // Busy belongs to the package, so reopening the same message disables only Update.
  assert.match(panel, /busy=\{selectedUpdateBusy\}/)
  assert.match(panel, /onClose=\{\(\) => setSelectedUpdate\(null\)\}/)
  assert.doesNotMatch(panel, /if \(!busy\)|setError|errorMessage/)
})

test('a newer package version makes the message unread again', () => {
  const oldIds = messageIdsForContent([update({ newVersion: '1.1.0' })], null)
  const readIds = markMessageRead(new Set(), oldIds, oldIds[0]!)
  const newerIds = messageIdsForContent([update({ newVersion: '1.2.0' })], null)

  assert.equal(unreadMessageCount(newerIds, readIds), 1)
  const next = markMessageRead(readIds, newerIds, newerIds[0]!)
  assert.deepEqual([...next].sort(), [newerIds[0]!].sort())
})

test('read ids persist under one versioned key and prune vanished messages', () => {
  const storage = new MemoryStorage()
  const ids = messageIdsForContent([update()], appUpdate())
  const stale = 'package:skill:removed@9.9.9'
  const previous = new Set([stale, ids[0]!])

  const readIds = markMessageRead(previous, ids, ids[0]!)
  writeMessageReadIds(readIds, storage)

  assert.equal(MESSAGE_READ_STORAGE_KEY, 'phi.messages-read.v1')
  assert.deepEqual([...readMessageReadIds(storage)].sort(), [ids[0]!].sort())
  assert.ok(!readMessageReadIds(storage).has(stale))
})

test('malformed and throwing storage leaves messages unread without breaking the app', () => {
  const malformed = new MemoryStorage()
  malformed.setItem(MESSAGE_READ_STORAGE_KEY, 'not json')
  assert.deepEqual(readMessageReadIds(malformed), new Set())

  const throwing: MessageReadStorage = {
    getItem() {
      throw new Error('storage denied')
    },
    setItem() {
      throw new Error('storage denied')
    }
  }
  assert.deepEqual(readMessageReadIds(throwing), new Set())
  assert.doesNotThrow(() => writeMessageReadIds(['app@0.2.0'], throwing))
  assert.doesNotThrow(() => markMessageRead(new Set(['app@0.2.0']), ['app@0.2.0'], 'app@0.2.0'))
})
