import assert from 'node:assert/strict'
import vm from 'node:vm'

import { adaptOfficePreviewHtml } from '../../src/main/agent/office/office-preview-adapter'
import {
  OFFICE_HIGHLIGHT_EVENT,
  OFFICE_HIGHLIGHT_FOLLOW_EVENT,
  OFFICE_PREVIEW_CONTROL_PATH,
  OFFICE_SHEET_HIGHLIGHT_EVENT,
  OFFICE_SHEET_HIGHLIGHT_FOLLOW_EVENT
} from '../../src/main/agent/office/office-preview-control'

const HIGHLIGHT_CLASS = 'phi-ai-highlight'

class FakeClassList {
  private readonly values = new Set<string>()

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token)
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token)
  }

  contains(token: string): boolean {
    return this.values.has(token)
  }

  toggle(token: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(token)
    if (enabled) this.values.add(token)
    else this.values.delete(token)
    return enabled
  }
}

export class FakePreviewElement {
  readonly classList = new FakeClassList()
  readonly children: FakePreviewElement[] = []
  textContent = ''
  value = ''
  scrollCalls = 0
  clickCalls = 0
  scrollTop = 0
  scrollLeft = 0

  constructor(
    readonly tagName: string,
    readonly attributes: Record<string, string> = {},
    private readonly onClick?: () => void,
    private readonly parent?: FakePreviewElement
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }

  removeAttribute(name: string): void {
    delete this.attributes[name]
  }

  appendChild(child: FakePreviewElement): FakePreviewElement {
    this.children.push(child)
    return child
  }

  remove(): void {
    this.attributes.removed = 'true'
  }

  matches(selector: string): boolean {
    const name = this.tagName.toLowerCase()
    return selector
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .some((part) => part === name || part.startsWith(`${name}[`))
  }

  closest(selector: string): FakePreviewElement | null {
    if (selector.includes('sheet-content')) return this.parent ?? null
    return this.matches(selector) ? this : null
  }

  querySelector(selector: string): FakePreviewElement | null {
    if (selector === '.table-wrapper') {
      return this.children.find((child) => child.classList.contains('table-wrapper')) ?? null
    }
    return null
  }

  scrollIntoView(): void {
    this.scrollCalls += 1
  }

  click(): void {
    this.clickCalls += 1
    this.onClick?.()
  }
}

class FakeEventSource {
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>()
  onmessage?: (event: { data: string }) => void
  closed = false

  constructor(readonly url: string) {}

  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  close(): void {
    this.closed = true
  }

  emit(name: string, value: unknown): void {
    const event = { data: JSON.stringify(value) }
    for (const listener of this.listeners.get(name) ?? []) listener(event)
    if (name === 'message') this.onmessage?.(event)
  }
}

interface ScheduledTimer {
  readonly id: number
  readonly dueAt: number
  readonly callback: () => void
}

export interface OfficePreviewAdapterHarness {
  readonly cells: readonly FakePreviewElement[]
  readonly tabs: readonly FakePreviewElement[]
  readonly scrollContainer: { scrollTop: number; scrollLeft: number }
  emitHighlight(sheet: string, range: string, follow: boolean): void
  emitSheetHighlight(sheet: string, follow: boolean): void
  advanceBy(milliseconds: number): void
  setHidden(hidden: boolean): void
  focusEditor(value: string): FakePreviewElement
  dropEditor(editor: FakePreviewElement): void
  simulateFullRefresh(): void
  highlightedPaths(): string[]
  activeSheet(): string | undefined
}

export function createOfficePreviewAdapterHarness(): OfficePreviewAdapterHarness {
  let now = 0
  let timerId = 0
  const timers = new Map<number, ScheduledTimer>()
  const windowListeners = new Map<string, Set<(event: unknown) => void>>()
  const sources: FakeEventSource[] = []
  const cellPaths = [
    '/Sheet1/A1',
    '/Sheet1/B1',
    '/Sheet1/A2',
    '/Sheet1/B2',
    '/Sheet1/A3',
    '/Sheet1/B3',
    '/Sheet1/C1',
    '/Sheet2/A1',
    '/Sheet2/B2'
  ]
  let activeSheet = 'Sheet1'
  const sheetContents = ['Sheet1', 'Sheet2'].map((sheet, index) => {
    const content = new FakePreviewElement('DIV', { 'data-sheet': String(index) })
    content.classList.add('sheet-content')
    content.classList.toggle('active', index === 0)
    const wrapper = new FakePreviewElement('DIV')
    wrapper.classList.add('table-wrapper')
    content.appendChild(wrapper)
    return { sheet, content, wrapper }
  })
  const scrollContainer = sheetContents[0]!.wrapper
  scrollContainer.scrollTop = 240
  scrollContainer.scrollLeft = 12
  const cells = cellPaths.map((path) => {
    const sheet = path.split('/')[1]
    const parent = sheetContents.find((entry) => entry.sheet === sheet)!.content
    return new FakePreviewElement('TD', { 'data-path': path, role: 'gridcell' }, undefined, parent)
  })
  const tabs = ['Sheet1', 'Sheet2'].map(
    (sheet) =>
      new FakePreviewElement('DIV', { role: 'tab', 'data-sheet-name': sheet }, () => {
        activeSheet = sheet
        for (const tab of tabs) tab.classList.toggle('active', tab.textContent === sheet)
        for (const entry of sheetContents) {
          entry.content.classList.toggle('active', entry.sheet === sheet)
        }
      })
  )
  tabs.forEach((tab, index) => {
    tab.textContent = `Sheet${index + 1}`
    tab.classList.toggle('active', index === 0)
  })

  const head = new FakePreviewElement('HEAD')
  const body = new FakePreviewElement('BODY')
  const documentValue = {
    visibilityState: 'visible',
    activeElement: body as FakePreviewElement,
    body,
    head,
    documentElement: scrollContainer,
    scrollingElement: scrollContainer,
    createElement: (tagName: string) => new FakePreviewElement(tagName.toUpperCase()),
    querySelectorAll: (selector: string): FakePreviewElement[] => {
      if (selector.includes('input')) {
        return documentValue.activeElement.tagName === 'INPUT' ? [documentValue.activeElement] : []
      }
      if (
        selector.includes('td') ||
        selector.includes('gridcell') ||
        selector.includes('data-path')
      ) {
        return cells
      }
      if (selector.includes('sheet-tab') || selector.includes('role="tab"')) return tabs
      if (selector.includes('sheet-content')) {
        const contents = sheetContents.map((entry) => entry.content)
        return selector.includes('.active')
          ? contents.filter((content) => content.classList.contains('active'))
          : contents
      }
      if (selector.includes(HIGHLIGHT_CLASS)) {
        return [...cells, ...tabs].filter((element) => element.classList.contains(HIGHLIGHT_CLASS))
      }
      return []
    },
    querySelector(selector: string): FakePreviewElement | null {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }
  const setTimer = (callback: () => void, delay = 0): number => {
    const id = ++timerId
    timers.set(id, { id, dueAt: now + delay, callback })
    return id
  }
  const addWindowListener = (name: string, listener: (event: unknown) => void): void => {
    const listeners = windowListeners.get(name) ?? new Set()
    listeners.add(listener)
    windowListeners.set(name, listeners)
  }
  const fakeWindow = {
    document: documentValue,
    fetch: async () => ({ ok: true }),
    location: { href: 'http://127.0.0.1:42001/', reload: () => undefined },
    addEventListener: addWindowListener,
    removeEventListener: () => undefined,
    scrollX: 0,
    scrollY: 240,
    scrollTo: (_x: number, y: number) => {
      scrollContainer.scrollTop = y
      fakeWindow.scrollY = y
    },
    setTimeout: setTimer,
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => setTimer(callback, 0),
    cancelAnimationFrame: (id: number) => timers.delete(id)
  }
  class EventSourceConstructor extends FakeEventSource {
    constructor(url: string) {
      super(url)
      sources.push(this)
    }
  }
  const mutationCallbacks: Array<() => void> = []
  class MutationObserver {
    private observing = false

    constructor(private readonly callback: () => void) {
      mutationCallbacks.push(callback)
    }

    observe(): void {
      this.observing = true
      void this.callback
    }

    disconnect(): void {
      if (this.observing) this.observing = false
    }
  }
  const context = {
    window: fakeWindow,
    document: documentValue,
    EventSource: EventSourceConstructor,
    MutationObserver,
    URL,
    Date: { now: () => now },
    queueMicrotask: (callback: () => void) => callback(),
    setTimeout: setTimer,
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => setTimer(callback, 0),
    cancelAnimationFrame: (id: number) => timers.delete(id)
  }
  vm.runInNewContext(injectedScript(), context)

  const advanceBy = (milliseconds: number): void => {
    const end = now + milliseconds
    for (;;) {
      const next = [...timers.values()]
        .filter((timer) => timer.dueAt <= end)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
      if (!next) break
      timers.delete(next.id)
      now = next.dueAt
      next.callback()
    }
    now = end
  }

  return {
    cells,
    tabs,
    scrollContainer,
    emitHighlight(sheet, range, follow) {
      assert.equal(sources.length, 1, 'adapter must open one trusted preview event stream')
      assert.equal(sources[0]!.url, OFFICE_PREVIEW_CONTROL_PATH)
      sources[0]!.emit(follow ? OFFICE_HIGHLIGHT_FOLLOW_EVENT : OFFICE_HIGHLIGHT_EVENT, {
        sheet,
        range
      })
      advanceBy(0)
    },
    emitSheetHighlight(sheet, follow) {
      assert.equal(sources.length, 1, 'adapter must open one trusted preview event stream')
      sources[0]!.emit(
        follow ? OFFICE_SHEET_HIGHLIGHT_FOLLOW_EVENT : OFFICE_SHEET_HIGHLIGHT_EVENT,
        { sheet }
      )
      advanceBy(0)
    },
    advanceBy,
    setHidden(hidden) {
      documentValue.visibilityState = hidden ? 'hidden' : 'visible'
    },
    focusEditor(value) {
      const input = new FakePreviewElement('INPUT')
      input.value = value
      documentValue.activeElement = input
      for (const listener of windowListeners.get('focusin') ?? []) listener({ target: input })
      return input
    },
    dropEditor(editor) {
      documentValue.activeElement = body as FakePreviewElement
      for (const callback of mutationCallbacks) {
        ;(callback as (records?: unknown) => void)([
          { removedNodes: [{ nodeType: 1, tagName: editor.tagName }] }
        ])
      }
    },
    simulateFullRefresh() {
      for (const entry of sheetContents) {
        entry.wrapper.scrollTop = 0
        entry.wrapper.scrollLeft = 0
      }
      for (const callback of mutationCallbacks) callback()
      advanceBy(0)
    },
    highlightedPaths: () =>
      cells
        .filter((cell) => cell.classList.contains(HIGHLIGHT_CLASS))
        .map((cell) => cell.getAttribute('data-path')!)
        .sort(),
    activeSheet: () => activeSheet
  }
}

function injectedScript(): string {
  const html = adaptOfficePreviewHtml(
    '<html><head><script id="upstream"></script></head><body></body></html>',
    false
  )
  const script = html.match(/<script data-phi-office-adapter>([\s\S]*?)<\/script>/u)?.[1]
  assert.ok(script)
  return script
}
