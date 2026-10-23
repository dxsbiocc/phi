import { navigationCopy } from '../src/renderer/src/lib/navigationCopy'
import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import type { SessionRenamePanel } from '../src/renderer/src/features/session-actions/SessionRenamePanel'

type PanelProps = ComponentProps<typeof SessionRenamePanel>
type Element = ReactElement<Record<string, unknown>>
type Effect = { dependencies: unknown[]; cleanup?: () => void }

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function panel(overrides: Partial<PanelProps> = {}): {
  render: (next?: Partial<PanelProps>) => Element
  find: (type: string, label?: string) => Element
  generate: () => Promise<void>
  unmount: () => void
  saved: () => number
  title: () => string
} {
  let slots: unknown[] = []
  let cursor = 0
  let key: string | null = null
  let saves = 0
  const unmount = (): void => {
    for (const slot of slots) {
      if (slot && typeof slot === 'object' && 'cleanup' in slot) {
        ;(slot as Effect).cleanup?.()
      }
    }
    slots = []
  }
  const props: PanelProps = {
    open: true,
    title: '原来的长标题',
    compactHoverPreview: false,
    onTitleChange: (title) => {
      props.title = title
    },
    onClose: () => {
      props.open = false
    },
    onSave: () => saves++,
    ...overrides
  }
  const source = ts.transpileModule(
    readFileSync('src/renderer/src/features/session-actions/SessionRenamePanel.tsx', 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX
      }
    }
  ).outputText
  const componentModule: { exports: Record<string, (props: PanelProps) => Element> } = {
    exports: {}
  }
  const hookBindings = {
    useCallback: (callback: unknown): unknown => callback,
    useState: (initial: unknown): [unknown, (value: unknown) => void] => {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => (slots[index] = value)]
    },
    useRef: (initial: unknown): unknown => {
      const index = cursor++
      return (slots[index] ??= { current: initial })
    },
    useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]): void => {
      const index = cursor++
      const previous = slots[index] as Effect | undefined
      if (previous?.dependencies.every((value, index) => Object.is(value, dependencies[index]))) {
        return
      }
      previous?.cleanup?.()
      slots[index] = { dependencies, cleanup: effect() }
    }
  }
  new Function('require', 'module', 'exports', source)(
    (name: string) => {
      if (name === 'react') return hookBindings
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name.endsWith('/i18n')) return { useUiLanguage: getUiLanguage }
      if (name.endsWith('/navigationCopy')) return { navigationCopy }
      return new Proxy({}, { get: (_target, property) => String(property) })
    },
    componentModule,
    componentModule.exports
  )
  const render = (next: Partial<PanelProps> = {}): Element => {
    Object.assign(props, next)
    const shell = componentModule.exports.SessionRenamePanel(props)
    if (key !== shell.key) {
      unmount()
      key = shell.key
    }
    cursor = 0
    return (shell.type as (props: PanelProps) => Element)(shell.props as PanelProps)
  }
  const find = (type: string, label?: string): Element => {
    let found: Element | undefined
    const visit = (node: ReactNode): void => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!isValidElement<Record<string, unknown>>(node)) return
      if (node.type === type && (label === undefined || node.props.children === label)) found = node
      visit(node.props.children as ReactNode)
    }
    visit(render())
    assert.ok(found, `missing ${type}: ${label ?? ''}`)
    return found
  }
  return {
    render,
    find,
    generate: async () => {
      const action = find('Button', 'AI 生成标题').props.onClick as () => void
      action()
      await Promise.resolve()
    },
    unmount,
    saved: () => saves,
    title: () => props.title
  }
}

// Keep the existing Chinese behavior assertions explicit; English switching has dedicated coverage.
setUiLanguage('zh-CN')

test('AI title suggestions populate the editable field and require an explicit save', async () => {
  const request = deferred<string>()
  const view = panel({ onGenerateTitle: () => request.promise })
  await view.generate()
  assert.equal(view.find('TextField').props.disabled, true)
  assert.equal(view.find('Button', '保存').props.disabled, true)
  assert.equal(view.find('Button', 'AI 生成标题').props.disabled, true)
  assert.equal(view.title(), '原来的长标题')
  request.resolve('  单细胞质控  ')
  await request.promise
  assert.equal(view.title(), '单细胞质控')
  assert.equal(view.saved(), 0)
  assert.equal(view.find('TextField').props.disabled, false)
  ;(view.find('Button', '保存').props.onClick as () => void)()
  assert.equal(view.saved(), 1)
})

test('a direct AI title action starts generation when the editor opens', async () => {
  const request = deferred<string>()
  let calls = 0
  const view = panel({
    onGenerateTitle: () => {
      calls++
      return request.promise
    },
    autoGenerateOnOpen: true
  } as Partial<PanelProps> & { autoGenerateOnOpen: boolean })
  view.render()
  assert.equal(calls, 1)
  request.resolve('新的分析标题')
  await request.promise
  await Promise.resolve()
  assert.equal(view.title(), '新的分析标题')
  assert.equal(view.saved(), 0)
})

test('a failed rename stays editable and reports why the title was not saved', async () => {
  const view = panel({
    onSave: async () => {
      throw new Error('无法保存标题')
    }
  })
  view.render()
  const save = view.find('Button', '保存').props.onClick as () => Promise<void>
  await save()
  assert.equal(view.find('Typography').props.children, '无法保存标题')
  assert.equal(view.find('TextField').props.disabled, false)
  assert.equal(view.saved(), 0)
})

test('repeated save clicks share one pending rename', async () => {
  const request = deferred<void>()
  let calls = 0
  const view = panel({
    onSave: () => {
      calls++
      return request.promise
    }
  })
  view.render()
  const save = view.find('Button', '保存').props.onClick as () => void
  save()
  save()
  assert.equal(calls, 1)
  assert.equal(view.find('TextField').props.disabled, true)
  request.resolve()
  await request.promise
  await Promise.resolve()
  assert.equal(view.find('TextField').props.disabled, false)
})

test('closing and reopening discards late suggestions from the previous dialog', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let calls = 0
  const view = panel({ onGenerateTitle: () => (++calls === 1 ? first.promise : second.promise) })
  await view.generate()
  ;(view.find('Button', '取消').props.onClick as () => void)()
  view.render()
  view.render({ open: true, title: '新的手动标题' })
  assert.equal(view.find('TextField').props.disabled, false)
  await view.generate()
  first.resolve('过期的标题')
  await first.promise
  assert.equal(view.title(), '新的手动标题')
  assert.equal(view.find('TextField').props.disabled, true)
  second.resolve('当前标题')
  await second.promise
  assert.equal(view.title(), '当前标题')
})

test('unmounting the dialog prevents a pending generation from changing the title', async () => {
  const request = deferred<string>()
  const view = panel({ onGenerateTitle: () => request.promise })
  await view.generate()
  view.unmount()
  request.resolve('已卸载窗口的标题')
  await request.promise
  assert.equal(view.title(), '原来的长标题')
})

test('failed generation preserves the title, reports an error, and allows retry', async () => {
  let attempts = 0
  const view = panel({
    onGenerateTitle: async () => {
      if (++attempts === 1) throw new Error('请先配置可用模型')
      return '重试后的标题'
    }
  })
  await view.generate()
  assert.equal(view.title(), '原来的长标题')
  assert.equal(view.find('Typography').props.role, 'alert')
  assert.equal(view.find('Typography').props.children, '请先配置可用模型')
  assert.equal(view.find('Button', 'AI 生成标题').props.disabled, false)
  await view.generate()
  assert.equal(view.title(), '重试后的标题')
})

test('busy conversations explain the disabled action and never invoke generation', async () => {
  let calls = 0
  const view = panel({
    onGenerateTitle: async () => {
      calls++
      return '标题'
    },
    generateTitleDisabledReason: '对话运行结束后可生成标题'
  })
  assert.equal(view.find('Tooltip').props.title, '对话运行结束后可生成标题')
  assert.equal(view.find('Button', 'AI 生成标题').props.disabled, true)
  await view.generate()
  assert.equal(calls, 0)
  assert.equal(view.find('TextField').props.disabled, false)
})

test('repeated clicks share the pending request and empty results preserve the title', async () => {
  const request = deferred<string>()
  let calls = 0
  const view = panel({
    onGenerateTitle: () => {
      calls++
      return request.promise
    }
  })
  await view.generate()
  await view.generate()
  assert.equal(calls, 1)
  request.resolve('   ')
  await request.promise
  assert.equal(view.title(), '原来的长标题')
  assert.equal(view.find('Typography').props.children, '未生成有效标题，请重试')
})

test('session rows bind suggestions to their own path while preserving manual save', () => {
  const source = readFileSync('src/renderer/src/components/session-sidebar/SessionRow.tsx', 'utf8')
  const sidebar = readFileSync('src/renderer/src/AppWorkspaceSidebar.tsx', 'utf8')
  assert.match(source, /window\.api\.generateSessionTitle\(session\.path\)/)
  assert.match(source, /<SessionRenamePanel\s+key=\{session\.path\}/)
  assert.match(source, /onSave=\{commitRename\}/)
  assert.match(source, /onClick=\{\(\) => openRename\(true\)\}/)
  assert.match(source, /autoGenerateOnOpen=\{generateTitleOnOpen\}/)
  assert.match(sidebar, /onRenameSession=\{\(path, name\) => onRenameSession\(path, name\)\}/)
  assert.match(source, /generateTitleDisabledReason=\{[\s\S]*exportDisabled/)
})

test('changing interface language retains a rename draft and the pending title request', async () => {
  const request = deferred<string>()
  const view = panel({ title: '用户保留的草稿', onGenerateTitle: () => request.promise })
  await view.generate()
  setUiLanguage('en')
  try {
    assert.equal(view.find('Button', 'Generate title with AI').props.disabled, true)
    assert.equal(view.find('Button', 'Save').props.disabled, true)
    assert.equal(view.title(), '用户保留的草稿')
    request.resolve('AI generated title')
    await request.promise
    assert.equal(view.title(), 'AI generated title')
    assert.equal(view.saved(), 0)
    assert.equal(view.find('Button', 'Save').props.disabled, false)
  } finally {
    setUiLanguage('zh-CN')
  }
})
