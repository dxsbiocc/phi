import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { appCopy } from '../src/renderer/src/lib/appCopy'

setUiLanguage('zh-CN')

const source = ts.createSourceFile(
  'App.tsx',
  readFileSync('src/renderer/src/App.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
let expression: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'onSelectPermissionMode')
    expression = node.initializer
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(expression)
const callback = ts.transpileModule(`const onSelectPermissionMode=${expression.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

type Mode = 'ask' | 'auto' | 'full'
type SelectionState = {
  activeSessionPath: string
  activePhiSessionId: string
  activeSessionGeneration: number
  currentPermissionMode: Mode
}
function fixture(): {
  invoke: (mode: Mode) => Promise<void>
  calls: Array<{ mode: Mode; target: unknown }>
  applied: unknown[]
  errors: string[]
  busy: boolean[]
  readonly state: SelectionState
  setState: (next: Partial<SelectionState>) => void
  resolve: (value: unknown) => void
  reject: (error: Error) => void
} {
  let state = {
    activeSessionPath: 'phi-session:a',
    activePhiSessionId: 'a',
    activeSessionGeneration: 3,
    currentPermissionMode: 'ask' as Mode
  }
  const calls: Array<{ mode: Mode; target: unknown }> = [],
    applied: unknown[] = [],
    errors: string[] = [],
    busy: boolean[] = []
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const invoke = runInNewContext(`${callback}\nonSelectPermissionMode`, {
    appCopy,
    useSessionStore: { getState: () => state },
    permissionModeUpdateRef: { current: false },
    setIsUpdatingPermissionMode: (value: boolean) => busy.push(value),
    rendererApi: {
      updateCurrentSessionPermissionMode: (mode: Mode, target: unknown) => {
        calls.push({ mode, target })
        return new Promise((yes, no) => {
          resolve = yes
          reject = no
        })
      }
    },
    applyCurrentSession: (current: { permissionMode: Mode }) => {
      applied.push(current)
      state = { ...state, currentPermissionMode: current.permissionMode }
    },
    resetAnalysisJupyterRuntimeForCwdChange: () => undefined,
    setProjectSessionRefreshKey: () => undefined,
    showSnackbarError: (error: Error) => errors.push(error.message)
  }) as (mode: Mode) => Promise<void>
  return {
    invoke,
    calls,
    applied,
    errors,
    busy,
    get state() {
      return state
    },
    setState: (next: Partial<typeof state>) => {
      state = { ...state, ...next }
    },
    resolve: (value: unknown) => resolve(value),
    reject: (error: Error) => reject(error)
  }
}

test('chat permission updates carry the visible session identity and apply a confirmed mode', async () => {
  const f = fixture(),
    pending = f.invoke('auto')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].mode, 'auto')
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].target)), {
    sessionPath: 'phi-session:a',
    phiSessionId: 'a',
    sessionGeneration: 3
  })
  assert.equal(f.state.currentPermissionMode, 'ask')
  f.resolve({ permissionMode: 'auto' })
  await pending
  assert.equal(f.state.currentPermissionMode, 'auto')
  assert.equal(f.applied.length, 1)
  assert.deepEqual(f.busy, [true, false])
})

test('a late permission reply cannot switch the renderer back to another conversation', async () => {
  const f = fixture(),
    pending = f.invoke('full')
  f.setState({
    activeSessionPath: 'phi-session:b',
    activePhiSessionId: 'b',
    activeSessionGeneration: 4,
    currentPermissionMode: 'auto'
  })
  f.resolve({ permissionMode: 'full' })
  await pending
  assert.equal(f.applied.length, 0)
  assert.equal(f.state.currentPermissionMode, 'auto')
  assert.deepEqual(f.busy, [true, false])
})

test('permission update failures are shown and leave the selected permission unchanged', async () => {
  const f = fixture(),
    pending = f.invoke('auto')
  f.reject(new Error('保存权限失败'))
  await pending
  assert.deepEqual(f.errors, ['保存权限失败'])
  assert.equal(f.applied.length, 0)
  assert.equal(f.state.currentPermissionMode, 'ask')
  assert.deepEqual(f.busy, [true, false])
})

test('duplicate clicks are serialized and selecting the current mode has no side effects', async () => {
  const f = fixture()
  await f.invoke('ask')
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.busy, [])
  const pending = f.invoke('auto')
  await f.invoke('full')
  assert.equal(f.calls.length, 1)
  f.resolve({ permissionMode: 'auto' })
  await pending
  assert.equal(f.state.currentPermissionMode, 'auto')
})
