import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { AppErrorBoundary } from '../src/renderer/src/components/AppErrorBoundary'

test.beforeEach(() => setUiLanguage('zh-CN'))
test.afterEach(() => setUiLanguage('en'))

test('unrelated global errors do not replace the chat with the render error page', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const listeners = new Map<string, (event: { reason?: unknown; error?: unknown }) => void>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener(
        type: string,
        listener: (event: { reason?: unknown; error?: unknown }) => void
      ) {
        listeners.set(type, listener)
      },
      removeEventListener(type: string) {
        listeners.delete(type)
      }
    }
  })

  try {
    const boundary = new AppErrorBoundary({ children: 'chat stays visible' })
    Object.defineProperty(boundary, 'setState', {
      value: (update: Partial<typeof boundary.state>) => {
        boundary.state = { ...boundary.state, ...update }
      }
    })
    if ('componentDidMount' in boundary) {
      ;(boundary as unknown as { componentDidMount: () => void }).componentDidMount()
    }
    listeners.get('unhandledrejection')?.({ reason: new Error('background network failure') })
    listeners.get('error')?.({ error: new Error('background event failure') })
    assert.equal(boundary.state.error, null)
    assert.equal(boundary.render(), 'chat stays visible')
    if ('componentWillUnmount' in boundary) {
      ;(boundary as unknown as { componentWillUnmount: () => void }).componentWillUnmount()
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('the recovery page follows the saved theme instead of the original teal chrome', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map<string, string>([
    ['phi-theme-mode', 'dark'],
    ['phi-theme-palette', 'minimal']
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null
    }
  })
  try {
    const boundary = new AppErrorBoundary({ children: 'chat' })
    boundary.state = {
      ...boundary.state,
      ...AppErrorBoundary.getDerivedStateFromError(new Error('render failure'))
    }
    const markup = renderToStaticMarkup(boundary.render() as ReactElement)
    assert.match(markup, /#0D1218/i)
    assert.match(markup, /#00A76F/i)
    assert.doesNotMatch(markup, /#0B262D|#123640|#2E9FB3/i)
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('a React render failure still shows the recovery page', () => {
  const boundary = new AppErrorBoundary({ children: 'chat' })
  boundary.state = {
    ...boundary.state,
    ...AppErrorBoundary.getDerivedStateFromError(new Error('render failure'))
  }
  const markup = renderToStaticMarkup(boundary.render() as ReactElement)
  assert.match(markup, /界面渲染遇到错误/)
  assert.match(markup, /render failure/)
})

test('the recovery page shows the component path before React internals', () => {
  const boundary = new AppErrorBoundary({ children: 'chat' })
  boundary.state = {
    error: new Error('Maximum update depth exceeded'),
    componentStack: 'at ChatMessageList (ChatMessageList.tsx:230)'
  }
  const markup = renderToStaticMarkup(boundary.render() as ReactElement)
  assert.ok(markup.indexOf('at ChatMessageList') < markup.indexOf('Maximum update depth exceeded'))
})
