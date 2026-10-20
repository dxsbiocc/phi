import { beforeEach, afterEach } from 'node:test'
import { getUiLanguage, getUiLocale, setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'
import { errorMessage } from '../src/shared/errorCodes'
import type { ProjectMemorySnapshot } from '../src/shared/projectMemoryTypes'
import type { Project } from '../src/renderer/src/lib/projectTypes'
import { memoryUi } from '../src/renderer/src/features/memory/lib/memoryUi'
import { nextProjectMemorySettings } from '../src/renderer/src/features/memory/lib/projectMemorySettings'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const project: Project = {
  id: 'project-first',
  name: 'First project',
  workingDirectory: '/first',
  location: { kind: 'local', path: '/first', realPath: '/first' },
  createdAt: '2026-10-15T00:00:00Z',
  permissionMode: 'ask',
  memory: { enabled: true, learn: false }
}
const snapshot: ProjectMemorySnapshot = {
  projectId: project.id,
  settings: { enabled: true, learn: false },
  summary: 'Existing project summary',
  summaryUpdatedAt: null,
  lessons: [{ index: 0, text: 'Keep the original tool contract' }]
}
const empty: ProjectMemorySnapshot = { ...snapshot, summary: '', lessons: [] }
type Api = Pick<
  Window['api'],
  'getProjectMemory' | 'deleteProjectMemoryLesson' | 'clearProjectMemory' | 'updateProjectMemory'
>
type Element = { type: string; props: Record<string, unknown> }
type Slot =
  | { kind: 'state'; value: unknown; set: (value: unknown) => void }
  | { kind: 'ref'; value: { current: unknown } }

function nodes(value: unknown, type: string): Element[] {
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as Element
  return [
    ...(node.type === type ? [node] : []),
    ...Object.values(node.props).flatMap((item) => nodes(item, type))
  ]
}

/** Execute the complete existing card and its real event handlers against deferred IPC. */
function harness(overrides: Partial<Api> = {}): {
  read: () => Element
  button: (label: string) => Element
  click: (label: string) => void
  calls: { reads: number; deletes: unknown[][]; clears: string[]; settings: unknown[][] }
  saved: Project[]
} {
  let cursor = 0
  let currentProject = project
  const slots: Slot[] = []
  const saved: Project[] = []
  const calls = {
    reads: 0,
    deletes: [] as unknown[][],
    clears: [] as string[],
    settings: [] as unknown[][]
  }
  const react = {
    useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
      const index = cursor++
      if (!slots[index]) {
        const slot: Extract<Slot, { kind: 'state' }> = {
          kind: 'state',
          value: initial,
          set(value): void {
            slot.value = typeof value === 'function' ? value(slot.value) : value
          }
        }
        slots[index] = slot
      }
      const slot = slots[index]
      if (slot.kind !== 'state') throw new Error('Unexpected hook order')
      return [slot.value as T, slot.set]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      slots[index] ??= { kind: 'ref', value: { current: initial } }
      const slot = slots[index]
      if (slot.kind !== 'ref') throw new Error('Unexpected hook order')
      return slot.value as { current: T }
    },
    useCallback: <T>(callback: T): T => callback
  }
  const api: Api = {
    getProjectMemory: async (id) => {
      calls.reads += 1
      return overrides.getProjectMemory ? overrides.getProjectMemory(id) : snapshot
    },
    deleteProjectMemoryLesson: async (id, index, text) => {
      calls.deletes.push([id, index, text])
      return overrides.deleteProjectMemoryLesson
        ? overrides.deleteProjectMemoryLesson(id, index, text)
        : empty
    },
    clearProjectMemory: async (id) => {
      calls.clears.push(id)
      return overrides.clearProjectMemory ? overrides.clearProjectMemory(id) : empty
    },
    updateProjectMemory: async (id, settings) => {
      calls.settings.push([id, settings])
      return overrides.updateProjectMemory
        ? overrides.updateProjectMemory(id, settings)
        : { ...currentProject, memory: settings }
    }
  }
  const module = { exports: {} as Record<string, unknown> }
  const code = ts.transpileModule(
    readFileSync('src/renderer/src/features/memory/components/ProjectMemoryCard.tsx', 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX
      }
    }
  ).outputText
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier.endsWith('/shared/errorCodes')) return { errorMessage }
      if (specifier.endsWith('/memoryUi')) return { memoryUi }
      if (specifier.endsWith('/lib/i18n')) return { useUiLanguage: getUiLanguage, getUiLocale }
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      if (specifier === '@mui/material') return new Proxy({}, { get: (_, key) => key })
      if (specifier.endsWith('/icons'))
        return {
          PhiIcons: {
            action: { delete: 'DeleteIcon', expand: 'ExpandIcon', collapse: 'CollapseIcon' }
          }
        }
      if (specifier.endsWith('/projectMemorySettings')) return { nextProjectMemorySettings }
      throw new Error(`Unexpected runtime import ${specifier}`)
    },
    window: { api },
    Promise,
    Error,
    Date
  })
  const card = module.exports.ProjectMemoryCard as (props: unknown) => Element
  const read = (): Element => {
    cursor = 0
    return card({
      project: currentProject,
      settings: currentProject.memory,
      onSettingsSaved: (value: Project) => {
        saved.push(value)
        currentProject = value
      }
    })
  }
  const button = (label: string): Element => {
    const found = nodes(read(), 'Button').find((node) => node.props.children === label)
    assert.ok(found, `Missing button ${label}`)
    return found
  }
  return {
    read,
    button,
    click: (label) => (button(label).props.onClick as () => void)(),
    calls,
    saved
  }
}

test('a pending memory lookup blocks clear until the authoritative read settles', async () => {
  const pending = deferred<ProjectMemorySnapshot>()
  let reads = 0
  const f = harness({
    getProjectMemory: () => (++reads === 1 ? Promise.resolve(snapshot) : pending.promise)
  })
  f.click('查看记忆')
  await flush()
  f.click('清空记忆')
  f.click('收起')
  f.click('查看记忆')
  assert.equal(f.button('确认清空').props.disabled, true)
  f.click('确认清空')
  assert.equal(f.calls.clears.length, 0)
  pending.resolve(snapshot)
  await flush()
  f.click('清空记忆')
  f.click('确认清空')
  await flush()
  assert.equal(f.calls.clears.length, 1)
  assert.equal(
    nodes(f.read(), 'Typography').some((node) => node.props.children === snapshot.summary),
    false
  )
})

test('a pending clear blocks refresh and duplicate clear dispatch without restoring stale memory', async () => {
  const pending = deferred<ProjectMemorySnapshot>()
  const f = harness({ clearProjectMemory: () => pending.promise })
  f.click('查看记忆')
  await flush()
  f.click('清空记忆')
  const confirm = f.button('确认清空').props.onClick as () => void
  confirm()
  confirm()
  f.click('收起')
  f.click('查看记忆')
  assert.equal(f.calls.clears.length, 1)
  assert.equal(f.calls.reads, 1)
  pending.resolve(empty)
  await flush()
  assert.equal(
    nodes(f.read(), 'Typography').some((node) => node.props.children === snapshot.summary),
    false
  )
})

test('rapid lesson deletion keeps one project/index/text request in flight', async () => {
  const pending = deferred<ProjectMemorySnapshot>()
  const f = harness({ deleteProjectMemoryLesson: () => pending.promise })
  f.click('查看记忆')
  await flush()
  const remove = nodes(f.read(), 'IconButton')[0].props.onClick as () => void
  remove()
  remove()
  assert.deepEqual(f.calls.deletes, [[project.id, 0, snapshot.lessons[0].text]])
  pending.resolve(empty)
  await flush()
  assert.equal(nodes(f.read(), 'IconButton').length, 0)
})

test('rapid settings changes retain the first confirmed policy until its request settles', async () => {
  const pending = deferred<Project>()
  const f = harness({ updateProjectMemory: () => pending.promise })
  const switches = nodes(f.read(), 'Switch')
  const disable = switches[0].props.onChange as (event: { target: { checked: boolean } }) => void
  const learn = switches[1].props.onChange as typeof disable
  disable({ target: { checked: false } })
  learn({ target: { checked: true } })
  assert.equal(f.calls.settings.length, 1)
  pending.resolve({ ...project, memory: { enabled: false, learn: false } })
  await flush()
  assert.equal(f.saved.length, 1)
  assert.equal(nodes(f.read(), 'Switch')[1].props.disabled, true)
})

test('a current failure preserves the snapshot and allows the next real operation', async () => {
  let attempts = 0
  const f = harness({
    clearProjectMemory: async () => {
      if (++attempts === 1) throw new Error('Clear failed')
      return empty
    }
  })
  f.click('查看记忆')
  await flush()
  f.click('清空记忆')
  f.click('确认清空')
  await flush()
  assert.equal(nodes(f.read(), 'Alert')[0].props.children, 'Clear failed')
  assert.equal(
    nodes(f.read(), 'Typography').some((node) => node.props.children === snapshot.summary),
    true
  )
  f.click('清空记忆')
  f.click('确认清空')
  await flush()
  assert.equal(f.calls.clears.length, 2)
  assert.equal(nodes(f.read(), 'Alert').length, 0)
})

test('switching language retains the expanded memory snapshot and pending confirmation', async () => {
  const f = harness()
  f.click('查看记忆')
  await flush()
  f.click('清空记忆')
  assert.ok(f.button('确认清空'))
  setUiLanguage('en')
  assert.ok(f.button('Confirm clear'))
  assert.ok(f.button('Collapse'))
  assert.equal(f.calls.reads, 1)
  assert.equal(f.calls.clears.length, 0)
  assert.ok(nodes(f.read(), 'Typography').some((node) => node.props.children === snapshot.summary))
  setUiLanguage('zh-CN')
  assert.ok(f.button('确认清空'))
  assert.equal(f.calls.reads, 1)
})
