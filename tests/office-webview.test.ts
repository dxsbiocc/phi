import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { WebContents, WebPreferences } from 'electron'

import { installOfficeWebviewSecurity } from '../src/main/agent/office/office-webview'

class PreventableEvent {
  defaultPrevented = false

  preventDefault(): void {
    this.defaultPrevented = true
  }
}

class FakeSession extends EventEmitter {
  permissionCheckHandler?: () => boolean
  permissionRequestHandler?: (
    contents: unknown,
    permission: string,
    callback: (allowed: boolean) => void
  ) => void

  setPermissionCheckHandler(handler: () => boolean): void {
    this.permissionCheckHandler = handler
  }

  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void
  ): void {
    this.permissionRequestHandler = handler
  }
}

class FakeGuest extends EventEmitter {
  readonly session = new FakeSession()
  closeCalls = 0
  windowOpenHandler?: () => { action: string }

  getURL(): string {
    return ''
  }

  close(): void {
    this.closeCalls += 1
  }

  setWindowOpenHandler(handler: () => { action: string }): void {
    this.windowOpenHandler = handler
  }
}

function install(previewUrls: readonly string[] = ['http://127.0.0.1:42001/']): {
  host: EventEmitter
  previewUrl: string
} {
  const host = new EventEmitter()
  installOfficeWebviewSecurity(host as unknown as WebContents, (url) => previewUrls.includes(url))
  return { host, previewUrl: previewUrls[0] }
}

function preferences(): WebPreferences {
  return {
    preload: '/tmp/untrusted-preload.cjs',
    sandbox: false,
    contextIsolation: false,
    nodeIntegration: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    webSecurity: false,
    webviewTag: true,
    allowRunningInsecureContent: true,
    navigateOnDragDrop: true,
    devTools: true
  }
}

function beginAttach(
  host: EventEmitter,
  src: string
): { event: PreventableEvent; preferences: WebPreferences } {
  const event = new PreventableEvent()
  const webPreferences = preferences()
  host.emit('will-attach-webview', event, webPreferences, { src })
  return { event, preferences: webPreferences }
}

function finishAttach(host: EventEmitter, guest: FakeGuest): void {
  host.emit('did-attach-webview', new PreventableEvent(), guest)
}

function attach(
  host: EventEmitter,
  src: string,
  guest = new FakeGuest()
): { event: PreventableEvent; preferences: WebPreferences; guest: FakeGuest } {
  const pending = beginAttach(host, src)
  if (!pending.event.defaultPrevented) finishAttach(host, guest)
  return { ...pending, guest }
}

test('an owned Office webview remains alive and fully hardened when its initial URL is empty', () => {
  const { host, previewUrl } = install()
  const { event, preferences: hardened, guest } = attach(host, previewUrl)

  assert.equal(event.defaultPrevented, false)
  assert.equal(guest.closeCalls, 0)
  assert.deepEqual(guest.windowOpenHandler?.(), { action: 'deny' })
  assert.equal(guest.session.permissionCheckHandler?.(), false)
  let permissionAllowed: boolean | undefined
  guest.session.permissionRequestHandler?.({}, 'clipboard-read', (allowed) => {
    permissionAllowed = allowed
  })
  assert.equal(permissionAllowed, false)

  const download = new PreventableEvent()
  guest.session.emit('will-download', download)
  assert.equal(download.defaultPrevented, true)
  assert.equal(guest.listenerCount('will-navigate'), 1)
  assert.equal(guest.listenerCount('will-redirect'), 1)

  assert.equal(hardened.preload, undefined)
  assert.equal(hardened.sandbox, true)
  assert.equal(hardened.contextIsolation, true)
  assert.equal(hardened.nodeIntegration, false)
  assert.equal(hardened.nodeIntegrationInWorker, false)
  assert.equal(hardened.nodeIntegrationInSubFrames, false)
  assert.equal(hardened.webSecurity, true)
  assert.equal(hardened.webviewTag, false)
  assert.equal(hardened.allowRunningInsecureContent, false)
  assert.equal(hardened.navigateOnDragDrop, false)
  assert.equal(hardened.devTools, false)

  assert.equal(guest.session.listenerCount('will-download'), 1)
  guest.emit('destroyed')
  assert.equal(guest.session.listenerCount('will-download'), 0)
})

test('Office webview navigation stays on an owned gateway origin', () => {
  const { host, previewUrl } = install()
  const { guest } = attach(host, previewUrl)
  const attempts = [
    { url: `${previewUrl}events`, blocked: false },
    { url: 'http://127.0.0.1:42002/', blocked: true },
    { url: 'https://example.com/', blocked: true },
    { url: 'file:///tmp/document.html', blocked: true },
    { url: 'javascript:alert(1)', blocked: true },
    { url: 'not a URL', blocked: true }
  ]

  for (const eventName of ['will-navigate', 'will-redirect'] as const) {
    for (const attempt of attempts) {
      const event = new PreventableEvent()
      guest.emit(eventName, event, attempt.url)
      assert.equal(
        event.defaultPrevented,
        attempt.blocked,
        `${eventName} ${attempt.url} should ${attempt.blocked ? 'be blocked' : 'be allowed'}`
      )
    }
  }
})

test('concurrent Office webviews are hardened without relying on attach event order', () => {
  const firstUrl = 'http://127.0.0.1:42001/'
  const secondUrl = 'http://127.0.0.1:42002/'
  const { host } = install([firstUrl, secondUrl])
  const firstPending = beginAttach(host, firstUrl)
  const secondPending = beginAttach(host, secondUrl)
  const firstGuest = new FakeGuest()
  const secondGuest = new FakeGuest()

  assert.equal(firstPending.event.defaultPrevented, false)
  assert.equal(secondPending.event.defaultPrevented, false)
  finishAttach(host, secondGuest)
  finishAttach(host, firstGuest)

  for (const [guest, allowed] of [
    [firstGuest, `${firstUrl}events`],
    [secondGuest, `${secondUrl}events`]
  ] as const) {
    const allowedEvent = new PreventableEvent()
    guest.emit('will-navigate', allowedEvent, allowed)
    assert.equal(allowedEvent.defaultPrevented, false)

    const blockedEvent = new PreventableEvent()
    guest.emit('will-navigate', blockedEvent, 'https://example.com/')
    assert.equal(blockedEvent.defaultPrevented, true)
  }
})

test('an unowned Office webview is rejected before its preferences are hardened', () => {
  const { host } = install()
  const event = new PreventableEvent()
  const untouched = preferences()
  const original = { ...untouched }

  host.emit('will-attach-webview', event, untouched, { src: 'http://127.0.0.1:42002/' })

  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(untouched, original)
})

// Real Electron throws "Object has been destroyed" when a WebContents property is read after
// 'destroyed'. An uncaught throw in the main process pops a native error dialog and freezes it.
class StrictDestroyedGuest extends FakeGuest {
  destroyed = false
  readonly aliveSession = new FakeSession()

  constructor() {
    super()
    // An instance property is needed: FakeGuest's own `session` field would shadow a getter.
    Object.defineProperty(this, 'session', {
      get: (): FakeSession => {
        if (this.destroyed) throw new TypeError('Object has been destroyed')
        return this.aliveSession
      }
    })
  }
}

test('destroying an Office webview never reads the destroyed guest and still detaches the download guard', () => {
  const { host, previewUrl } = install()
  const guest = new StrictDestroyedGuest()
  attach(host, previewUrl, guest)
  const session = guest.aliveSession
  assert.equal(session.listenerCount('will-download'), 1)

  guest.destroyed = true
  assert.doesNotThrow(() => guest.emit('destroyed'))
  assert.equal(session.listenerCount('will-download'), 0)
})
