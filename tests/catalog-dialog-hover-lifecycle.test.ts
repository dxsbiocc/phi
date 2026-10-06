import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

type Cleanup = (() => void) | undefined

function catalogInteractionLifecycle(path: string): {
  render: (open: boolean, pending: boolean) => void
  unmount: () => void
  notifications: boolean[]
} {
  const source = readFileSync(path, 'utf8')
  const previousEffect = '  useEffect(() => () => catalogDialogs.dispose(), [catalogDialogs])'
  const start = source.indexOf(previousEffect) + previousEffect.length
  const end = source.indexOf('\n  const openCatalog', start)
  assert.ok(start >= previousEffect.length && end > start)
  const actualEffect = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const notifications: boolean[] = []
  let dependencies: unknown[] | undefined
  let cleanup: Cleanup
  const context = {
    catalogOpen: false,
    catalogPending: false,
    onPreviewInteractionChange: (active: boolean) => notifications.push(active),
    useEffect: (effect: () => Cleanup, nextDependencies: unknown[]) => {
      if (
        dependencies?.length === nextDependencies.length &&
        dependencies.every((value, index) => Object.is(value, nextDependencies[index]))
      ) {
        return
      }
      cleanup?.()
      dependencies = nextDependencies
      cleanup = effect()
    }
  }
  return {
    notifications,
    render: (open, pending) => {
      context.catalogOpen = open
      context.catalogPending = pending
      runInNewContext(`(() => {\n${actualEffect}\n})()`, context)
    },
    unmount: () => cleanup?.()
  }
}

for (const [label, path] of [
  ['connector', 'src/renderer/src/features/mcp/McpView.tsx'],
  ['wrapper', 'src/renderer/src/features/wrapper/components/WrapperSidebar.tsx']
] as const) {
  test(`${label} catalog keeps its modal interaction uninterrupted when the browser gate opens`, () => {
    const lifecycle = catalogInteractionLifecycle(path)
    lifecycle.render(false, false)
    lifecycle.render(false, true)
    lifecycle.render(true, false)
    lifecycle.render(true, false)
    assert.deepEqual(lifecycle.notifications, [true])
    lifecycle.render(false, false)
    assert.deepEqual(lifecycle.notifications, [true, false])
  })

  test(`${label} catalog releases modal interaction after a canceled gate request`, () => {
    const lifecycle = catalogInteractionLifecycle(path)
    lifecycle.render(false, true)
    lifecycle.render(false, false)
    assert.deepEqual(lifecycle.notifications, [true, false])
  })

  test(`${label} catalog releases modal interaction when its sidebar unmounts`, () => {
    const lifecycle = catalogInteractionLifecycle(path)
    lifecycle.render(true, false)
    lifecycle.unmount()
    assert.deepEqual(lifecycle.notifications, [true, false])
  })
}
