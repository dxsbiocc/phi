import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { SIDEBAR_GROUP_HEADER_HEIGHT } from '../src/renderer/src/components/SidebarAccordionGroup'

function layoutHarness(path: string): {
  paint: (visible: boolean, height: number) => { first: number; settled: number }
} {
  const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = syntax.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'useExpandedBodyMaxHeight'
  )
  assert.ok(declaration)
  const constants = syntax.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) =>
        ['LIST_VERTICAL_PADDING', 'EXPANDED_BODY_MIN_HEIGHT'].includes(item.name.getText(syntax))
      )
  )
  const code = ts.transpileModule(
    `${constants.map((node) => node.getText(syntax)).join('\n')}\n${declaration.getText(syntax)}\nuseExpandedBodyMaxHeight`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  let state: number | undefined
  let height = 0
  let dirty = false
  let dependencies: unknown[] | undefined
  let cleanup: (() => void) | undefined
  let scheduled: (() => void) | undefined
  let passive = false
  const observerTasks: Array<() => void> = []
  const ref = {
    current: {
      get offsetHeight() {
        return height
      }
    }
  }
  const effect = (
    callback: () => (() => void) | undefined,
    next: unknown[],
    afterPaint: boolean
  ): void => {
    if (dependencies?.every((item, index) => Object.is(item, next[index]))) return
    scheduled = () => {
      cleanup?.()
      cleanup = callback()
      dependencies = next
    }
    passive = afterPaint
  }
  const hook = runInNewContext(code, {
    SIDEBAR_GROUP_HEADER_HEIGHT,
    useState: (initial: number) => {
      state ??= initial
      return [
        state,
        (next: number) => {
          dirty = !Object.is(state, next)
          state = next
        }
      ]
    },
    useLayoutEffect: (callback: () => (() => void) | undefined, next: unknown[]) =>
      effect(callback, next, false),
    useEffect: (callback: () => (() => void) | undefined, next: unknown[]) =>
      effect(callback, next, true),
    ResizeObserver: class {
      private active = true
      constructor(
        private callback: (entries: Array<{ contentRect: { height: number } }>) => void
      ) {}
      observe(): void {
        observerTasks.push(() => {
          if (this.active) this.callback([{ contentRect: { height } }])
        })
      }
      disconnect(): void {
        this.active = false
      }
    }
  }) as (list: typeof ref, groupCount: number, visible: boolean) => number

  return {
    paint: (visible, measuredHeight) => {
      height = measuredHeight
      let result = hook(ref, 2, visible)
      if (scheduled && !passive) {
        const callback = scheduled
        scheduled = undefined
        callback()
      }
      if (dirty) {
        dirty = false
        result = hook(ref, 2, visible)
      }
      const first = result
      if (scheduled) {
        const callback = scheduled
        scheduled = undefined
        callback()
      }
      observerTasks.splice(0).forEach((callback) => callback())
      if (dirty) {
        dirty = false
        result = hook(ref, 2, visible)
      }
      return { first, settled: result }
    }
  }
}

for (const [label, path] of [
  ['skill', 'src/renderer/src/features/skill/components/SkillSidebar.tsx'],
  ['wrapper', 'src/renderer/src/features/wrapper/components/WrapperSidebar.tsx']
] as const) {
  test(`${label} sidebar measures before its first paint and remeasures after hidden resize`, () => {
    const harness = layoutHarness(path)
    const initial = harness.paint(true, 640)
    assert.equal(initial.first, initial.settled, 'first paint must not use a temporary minimum')
    assert.ok(initial.first > 100)
    const hidden = harness.paint(false, 0)
    assert.equal(hidden.settled, initial.settled, 'hidden geometry must not clear the last height')
    const resized = harness.paint(true, 480)
    assert.equal(
      resized.first,
      resized.settled,
      'reopening must measure the new viewport before paint'
    )
    assert.ok(resized.first < initial.first)
  })
}
