import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createBrowserTrustedOverlayGate,
  type BrowserTrustedOverlayGate
} from '../src/renderer/src/features/browser/lib/browserTrustedOverlayGate'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class ManualRuntime {
  nextId = 0
  readonly timers = new Map<number, { callback: () => void; delay: number }>()
  readonly frames = new Map<number, () => void>()

  setTimer = (callback: () => void, delay: number): number => {
    const id = ++this.nextId
    this.timers.set(id, { callback, delay })
    return id
  }
  clearTimer = (id: number): void => {
    this.timers.delete(id)
  }
  requestFrame = (callback: () => void): number => {
    const id = ++this.nextId
    this.frames.set(id, callback)
    return id
  }
  cancelFrame = (id: number): void => {
    this.frames.delete(id)
  }
  runTimer(delay: number): void {
    const entry = [...this.timers].find(([, timer]) => timer.delay === delay)
    assert.ok(entry, `missing timer ${delay}`)
    this.timers.delete(entry[0])
    entry[1].callback()
  }
  runFrame(): void {
    const entry = this.frames.entries().next().value
    assert.ok(entry, 'missing animation frame')
    this.frames.delete(entry[0])
    entry[1]()
  }
}

function gateHarness(options: {
  hide: () => Promise<boolean>
  onHideFailure?: () => void
  onRequestFailure?: (kind: 'auth' | 'approval' | 'interaction' | 'local') => void
}): {
  gate: BrowserTrustedOverlayGate
  runtime: ManualRuntime
  suspended: boolean[]
} {
  const runtime = new ManualRuntime()
  const suspended: boolean[] = []
  const gate = createBrowserTrustedOverlayGate({
    hide: options.hide,
    onHideFailure: options.onHideFailure ?? (() => undefined),
    onRequestFailure: options.onRequestFailure,
    onSuspendedChange: (value) => suspended.push(value),
    setTimer: runtime.setTimer,
    clearTimer: runtime.clearTimer,
    requestFrame: runtime.requestFrame,
    cancelFrame: runtime.cancelFrame
  })
  return { gate, runtime, suspended }
}

test('trusted overlay gate publishes FIFO only after hide and releases after two frames', async () => {
  const order: string[] = []
  const { gate, runtime, suspended } = gateHarness({
    hide: async () => {
      order.push('hide')
      return true
    }
  })
  gate.enqueue({ kind: 'auth', key: 'auth-1', publish: () => order.push('auth') })
  gate.enqueue({ kind: 'approval', key: 'approval-1', publish: () => order.push('approval') })
  await tick()
  await tick()

  assert.deepEqual(order, ['hide', 'auth', 'hide', 'approval'])
  assert.deepEqual(suspended, [true])
  runtime.runFrame()
  assert.deepEqual(suspended, [true])
  runtime.runFrame()
  assert.deepEqual(suspended, [true, false])
})

test('trusted overlay gate cancellation prevents late hide completion from publishing', async () => {
  const firstHide = deferred<boolean>()
  const order: string[] = []
  let hideCount = 0
  const { gate } = gateHarness({
    hide: async () => {
      hideCount += 1
      if (hideCount === 1) return firstHide.promise
      return true
    }
  })
  gate.enqueue({
    kind: 'approval',
    key: 'approval-1',
    publish: () => order.push('stale approval'),
    onCancel: () => order.push('cancelled approval')
  })
  gate.cancel('approval', 'approval-1', true)
  gate.enqueue({
    kind: 'interaction',
    key: 'interaction-1',
    publish: () => order.push('interaction')
  })
  firstHide.resolve(true)
  await tick()
  await tick()

  assert.deepEqual(order, ['cancelled approval', 'interaction'])
})

test('local trusted overlays wait until the native browser confirms it is hidden', async () => {
  const hide = deferred<boolean>()
  const order: string[] = []
  const { gate } = gateHarness({
    hide: () => {
      order.push('hide')
      return hide.promise
    }
  })
  gate.enqueue({ kind: 'local', key: 'settings', publish: () => order.push('settings') })
  await tick()
  assert.deepEqual(order, ['hide'])
  hide.resolve(true)
  await tick()
  assert.deepEqual(order, ['hide', 'settings'])
})

test('trusted overlay gate times out retries and safely cancels persistent failures', async () => {
  const never = new Promise<boolean>(() => undefined)
  const order: string[] = []
  let attempt = 0
  const retryHarness = gateHarness({
    hide: async () => {
      attempt += 1
      order.push(`hide:${attempt}`)
      return attempt === 1 ? never : true
    },
    onHideFailure: () => {
      order.push('fallback')
    }
  })
  retryHarness.gate.enqueue({
    kind: 'approval',
    key: 'approval-timeout',
    publish: () => order.push('publish')
  })
  retryHarness.runtime.runTimer(750)
  await tick()
  retryHarness.runtime.runTimer(250)
  await tick()
  await tick()
  assert.deepEqual(order, ['hide:1', 'fallback', 'hide:2', 'publish'])

  const persistentOrder: string[] = []
  let persistentAttempt = 0
  const persistent = gateHarness({
    hide: async () => {
      persistentAttempt += 1
      persistentOrder.push(`hide:${persistentAttempt}`)
      return persistentAttempt > 3
    },
    onHideFailure: () => {
      persistentOrder.push('fallback')
    },
    onRequestFailure: (kind) => {
      persistentOrder.push(`failure:${kind}`)
    }
  })
  persistent.gate.enqueue({
    kind: 'interaction',
    key: 'interaction-persistent',
    publish: () => persistentOrder.push('publish'),
    onCancel: () => persistentOrder.push('cancel')
  })
  persistent.gate.enqueue({
    kind: 'approval',
    key: 'approval-after-failure',
    publish: () => persistentOrder.push('approval')
  })
  await tick()
  persistent.runtime.runTimer(250)
  await tick()
  persistent.runtime.runTimer(250)
  await tick()
  await tick()
  assert.deepEqual(persistentOrder, [
    'hide:1',
    'fallback',
    'hide:2',
    'hide:3',
    'cancel',
    'failure:interaction',
    'hide:4',
    'approval'
  ])
  persistent.runtime.runFrame()
  persistent.runtime.runFrame()
  assert.deepEqual(persistent.suspended, [true, false])
  persistent.gate.dispose()
})
