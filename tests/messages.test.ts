import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppUpdateCheck } from '../src/shared/appUpdateTypes'
import type { PackageUpdateView } from '../src/shared/packageManagerTypes'
import {
  appUpdateMessageId,
  buildMessages,
  messageIdsForContent,
  packageUpdatesMessageId
} from '../src/renderer/src/features/messages/lib/messages'
import {
  MESSAGE_READ_STORAGE_KEY,
  markMessagesRead,
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

test('package updates become one message with sorted stable keys in both languages', () => {
  const updates = [
    update({ id: 'z-skill', type: 'skill', title: 'Zeta', newVersion: '2.0.0' }),
    update({ id: 'a-plugin', type: 'plugin', title: 'Alpha', newVersion: '3.0.0' })
  ]

  setUiLanguage('zh-CN')
  const [chinese] = buildMessages({ updates, appUpdate: null })
  assert.ok(chinese)
  assert.equal(chinese.id, packageUpdatesMessageId(updates))
  assert.equal(chinese.id, ['plugin:a-plugin@3.0.0', 'skill:z-skill@2.0.0'].sort().join('|'))
  assert.equal(chinese.title, '有 2 个内容包可更新')
  assert.equal(chinese.subtitle, 'Zeta、Alpha')
  assert.equal(chinese.status, '可更新')
  assert.equal(chinese.kind, 'package-updates')

  setUiLanguage('en')
  const [english] = buildMessages({ updates, appUpdate: null })
  assert.ok(english)
  assert.equal(english.id, chinese.id)
  assert.equal(english.title, '2 content package updates available')
  assert.equal(english.subtitle, 'Zeta, Alpha')
  assert.equal(english.status, 'Update available')
})

test('plugin update names use the shared plugin display title', () => {
  setUiLanguage('en')
  const [message] = buildMessages({
    updates: [update({ id: 'visualization', type: 'plugin', title: '科研绘图' })],
    appUpdate: null
  })
  assert.ok(message)
  assert.equal(message.subtitle, 'Visualization')
})

test('message ids change when the update content changes', () => {
  const first = [update()]
  const second = [update({ newVersion: '1.2.0' })]
  assert.notEqual(packageUpdatesMessageId(first), packageUpdatesMessageId(second))
  assert.deepEqual(messageIdsForContent(first, null), [packageUpdatesMessageId(first)])
  assert.deepEqual(messageIdsForContent([], appUpdate()), [appUpdateMessageId('0.2.0')])
})

test('an available app update becomes one localized message', () => {
  setUiLanguage('zh-CN')
  const [chinese] = buildMessages({ updates: [], appUpdate: appUpdate() })
  assert.ok(chinese)
  assert.equal(chinese.id, 'app@0.2.0')
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

test('up-to-date and failed update checks produce no message', () => {
  for (const status of ['up-to-date', 'error'] as const) {
    assert.deepEqual(
      buildMessages({ updates: [], appUpdate: appUpdate({ status, latestVersion: '0.2.0' }) }),
      []
    )
  }
})

test('read state counts unread messages and mark-all-read clears the badge', () => {
  const messages = buildMessages({
    updates: [update()],
    appUpdate: appUpdate()
  })
  const ids = messages.map((message) => message.id)
  assert.equal(unreadMessageCount(ids, new Set()), 2)

  const partlyRead = markMessagesRead(new Set(), [ids[0]!])
  assert.equal(unreadMessageCount(ids, partlyRead), 1)

  const allRead = markMessagesRead(partlyRead, ids)
  assert.equal(unreadMessageCount(ids, allRead), 0)
  assert.deepEqual([...allRead].sort(), [...ids].sort())
})

test('a changed message id makes an otherwise read message unread again', () => {
  const readIds = markMessagesRead(new Set(), messageIdsForContent([update()], appUpdate()))
  const changedContent = messageIdsForContent([update({ newVersion: '9.0.0' })], appUpdate())
  assert.equal(unreadMessageCount(changedContent, readIds), 1)
})

test('read ids persist under one versioned key', () => {
  const storage = new MemoryStorage()
  const readIds = new Set(['app@0.2.0', 'plugin:demo@2.0.0'])
  writeMessageReadIds(readIds, storage)

  assert.equal(MESSAGE_READ_STORAGE_KEY, 'phi.messages-read.v1')
  assert.deepEqual([...readMessageReadIds(storage)].sort(), [...readIds].sort())
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
})
