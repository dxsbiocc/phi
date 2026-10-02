import type { BrowserViewport } from '../../shared/browserTypes'

type WindowEvent = 'minimize' | 'restore' | 'hide' | 'show'

export interface NativeBrowserViewLike {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setVisible(visible: boolean): void
}

export interface NativeBrowserWindowLike {
  contentView: {
    addChildView(view: NativeBrowserViewLike): void
    removeChildView(view: NativeBrowserViewLike): void
  }
  getContentBounds(): { x: number; y: number; width: number; height: number }
  isMinimized(): boolean
  isVisible(): boolean
  on(event: WindowEvent, listener: () => void): unknown
  off(event: WindowEvent, listener: () => void): unknown
  listenerCount(event: WindowEvent, listener?: () => void): number
}

interface ViewportRecord {
  view: NativeBrowserViewLike
  window: NativeBrowserWindowLike
  desired: BrowserViewport | null
  attached: boolean
  cleanupPending: boolean
}

interface WindowBinding {
  refs: number
  installed: boolean
  poisoned: boolean
  minimized: boolean
  hidden: boolean
  listeners: Record<WindowEvent, () => void>
}

export class BrowserViewportError extends Error {
  constructor() {
    super('Browser viewport could not be applied')
    this.name = 'BrowserViewportError'
  }
}

export class ElectronBrowserViewportController<Key> {
  readonly #records = new Map<Key, ViewportRecord>()
  readonly #windows = new Map<NativeBrowserWindowLike, WindowBinding>()
  #activeKey: Key | null = null

  has(key: Key): boolean {
    return this.#records.has(key)
  }

  register(key: Key, view: NativeBrowserViewLike, window: NativeBrowserWindowLike): void {
    if (this.#records.has(key)) throw new BrowserViewportError()
    let retained = false
    try {
      this.#retainWindow(window)
      retained = true
      view.setVisible(false)
      this.#records.set(key, {
        view,
        window,
        desired: null,
        attached: false,
        cleanupPending: false
      })
    } catch {
      if (retained) this.#releaseWindow(window)
      throw new BrowserViewportError()
    }
  }

  setViewport(key: Key, viewport: BrowserViewport | null): void {
    const record = this.#records.get(key)
    if (!record || record.cleanupPending) throw new BrowserViewportError()
    if (viewport === null) {
      record.desired = null
      const failed = this.#hideRecord(record)
      if (this.#activeKey === key) this.#activeKey = null
      if (failed) throw new BrowserViewportError()
      return
    }
    let bounds: { x: number; y: number; width: number; height: number }
    try {
      bounds = this.#clamp(viewport, record.window)
    } catch {
      this.#hideActive()
      this.#activeKey = null
      throw new BrowserViewportError()
    }
    record.desired = { ...viewport }
    const binding = this.#windows.get(record.window)
    if (!binding || !binding.installed || binding.poisoned) {
      this.#rejectCandidate(record)
      throw new BrowserViewportError()
    }
    if (binding.minimized || binding.hidden) {
      const failed = this.#hideActive()
      if (failed) {
        this.#rejectCandidate(record)
        throw new BrowserViewportError()
      }
      this.#activeKey = key
      return
    }
    if (this.#activeKey === key && record.attached) {
      try {
        record.view.setBounds(bounds)
        return
      } catch {
        this.#rejectCandidate(record)
        throw new BrowserViewportError()
      }
    }
    const hideFailed = this.#hideActive()
    this.#activeKey = key
    try {
      this.#attach(record, bounds)
      if (hideFailed) throw new BrowserViewportError()
    } catch {
      this.#rejectCandidate(record)
      throw new BrowserViewportError()
    }
  }

  prepareForClose(key: Key): boolean {
    const record = this.#records.get(key)
    if (!record) return false
    record.cleanupPending = true
    record.desired = null
    if (this.#activeKey === key) this.#activeKey = null
    return this.#hideRecord(record)
  }

  completeClose(key: Key, closeSucceeded: boolean): boolean {
    const record = this.#records.get(key)
    if (!record || !closeSucceeded) return false
    const failed = this.#hideRecord(record)
    this.#records.delete(key)
    return this.#releaseWindow(record.window) || failed
  }

  #clamp(
    viewport: BrowserViewport,
    window: NativeBrowserWindowLike
  ): { x: number; y: number; width: number; height: number } {
    if (
      !Number.isFinite(viewport.x) ||
      !Number.isFinite(viewport.y) ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      throw new BrowserViewportError()
    }
    const parent = window.getContentBounds()
    if (
      !Number.isFinite(parent.width) ||
      !Number.isFinite(parent.height) ||
      parent.width <= 0 ||
      parent.height <= 0
    ) {
      throw new BrowserViewportError()
    }
    const left = Math.max(0, Math.floor(viewport.x))
    const top = Math.max(0, Math.floor(viewport.y))
    const right = Math.min(parent.width, Math.ceil(viewport.x + viewport.width))
    const bottom = Math.min(parent.height, Math.ceil(viewport.y + viewport.height))
    if (right <= left || bottom <= top) throw new BrowserViewportError()
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  #attach(
    record: ViewportRecord,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    record.view.setVisible(false)
    record.view.setBounds(bounds)
    record.attached = true
    record.window.contentView.addChildView(record.view)
    record.view.setVisible(true)
  }

  #hideActive(): boolean {
    if (this.#activeKey === null) return false
    const active = this.#records.get(this.#activeKey)
    return active ? this.#hideRecord(active) : false
  }

  #hideRecord(record: ViewportRecord): boolean {
    let failed = false
    try {
      record.view.setVisible(false)
    } catch {
      failed = true
      try {
        record.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      } catch {
        failed = true
      }
    }
    if (record.attached) {
      try {
        record.window.contentView.removeChildView(record.view)
        record.attached = false
      } catch {
        failed = true
      }
    }
    return failed
  }

  #rejectCandidate(record: ViewportRecord): void {
    this.#hideRecord(record)
    record.desired = null
    this.#activeKey = null
  }

  #retainWindow(window: NativeBrowserWindowLike): WindowBinding {
    let binding = this.#windows.get(window)
    if (!binding) {
      binding = {
        refs: 0,
        installed: false,
        poisoned: false,
        minimized: window.isMinimized(),
        hidden: !window.isVisible(),
        listeners: {
          minimize: () => this.#windowEvent(window, 'minimize'),
          restore: () => this.#windowEvent(window, 'restore'),
          hide: () => this.#windowEvent(window, 'hide'),
          show: () => this.#windowEvent(window, 'show')
        }
      }
      this.#windows.set(window, binding)
    }
    if (binding.refs === 0 || !binding.installed || binding.poisoned) {
      this.#installWindowListeners(window, binding)
    }
    binding.refs += 1
    return binding
  }

  #installWindowListeners(window: NativeBrowserWindowLike, binding: WindowBinding): void {
    binding.installed = false
    binding.poisoned = true
    for (const event of ['minimize', 'restore', 'hide', 'show'] as const) {
      const listener = binding.listeners[event]
      for (let attempt = 0; attempt < 32; attempt += 1) {
        if (window.listenerCount(event, listener) === 0) break
        window.off(event, listener)
      }
      if (window.listenerCount(event, listener) !== 0) throw new BrowserViewportError()
    }
    for (const event of ['minimize', 'restore', 'hide', 'show'] as const) {
      const listener = binding.listeners[event]
      window.on(event, listener)
      if (window.listenerCount(event, listener) !== 1) throw new BrowserViewportError()
    }
    let minimized: boolean
    let hidden: boolean
    try {
      minimized = window.isMinimized()
      hidden = !window.isVisible()
    } catch {
      throw new BrowserViewportError()
    }
    binding.minimized = minimized
    binding.hidden = hidden
    binding.installed = true
    binding.poisoned = false
  }

  #releaseWindow(window: NativeBrowserWindowLike): boolean {
    const binding = this.#windows.get(window)
    if (!binding) return false
    if (binding.refs > 0) binding.refs -= 1
    if (binding.refs > 0) return false
    try {
      for (const event of ['minimize', 'restore', 'hide', 'show'] as const) {
        const listener = binding.listeners[event]
        for (let attempt = 0; attempt < 32; attempt += 1) {
          if (window.listenerCount(event, listener) === 0) break
          window.off(event, listener)
        }
        if (window.listenerCount(event, listener) !== 0) throw new BrowserViewportError()
      }
      binding.installed = false
      binding.poisoned = false
      this.#windows.delete(window)
      return false
    } catch {
      binding.refs = 0
      binding.installed = false
      binding.poisoned = true
      return true
    }
  }

  #windowEvent(window: NativeBrowserWindowLike, event: WindowEvent): void {
    try {
      const binding = this.#windows.get(window)
      if (!binding) return
      if (event === 'minimize') binding.minimized = true
      if (event === 'restore') binding.minimized = false
      if (event === 'hide') binding.hidden = true
      if (event === 'show') binding.hidden = false
      if (binding.minimized || binding.hidden) this.#suspendWindow(window)
      else this.#resumeWindow(window)
    } catch {
      this.#suspendWindow(window)
    }
  }

  #suspendWindow(window: NativeBrowserWindowLike): void {
    try {
      for (const [key, record] of this.#records) {
        if (
          record.window === window &&
          (record.cleanupPending || (this.#activeKey !== null && key === this.#activeKey))
        ) {
          this.#hideRecord(record)
        }
      }
    } catch {
      return
    }
  }

  #resumeWindow(window: NativeBrowserWindowLike): void {
    try {
      const binding = this.#windows.get(window)
      if (!binding || binding.minimized || binding.hidden || this.#activeKey === null) return
      const record = this.#records.get(this.#activeKey)
      if (!record || record.window !== window || !record.desired || record.cleanupPending) return
      const bounds = this.#clamp(record.desired, window)
      if (record.attached) {
        record.view.setBounds(bounds)
        record.view.setVisible(true)
      } else {
        this.#attach(record, bounds)
      }
    } catch {
      if (this.#activeKey === null) return
      const record = this.#records.get(this.#activeKey)
      if (record?.window === window) this.#hideRecord(record)
    }
  }
}
