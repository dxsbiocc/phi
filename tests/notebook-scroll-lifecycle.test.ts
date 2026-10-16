import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const path = resolve('src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx')
const text = readFileSync(path, 'utf8')
const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function findExpression(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined
  function visit(node: ts.Node): void {
    if (!found && predicate(node)) found = node
    if (!found) ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(found, 'expected the actual Notebook scroll lifecycle callback')
  return found
}

function callback(
  node: ts.Node,
  bindings: Record<string, unknown>
): (...args: unknown[]) => unknown {
  const code = ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  return new Function(...Object.keys(bindings), `return ${code}`)(...Object.values(bindings))
}

test('StrictMode effect replay releases the cancelled scroll frame and refreshes the viewport', () => {
  const effectCall = findExpression(
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[0]?.getText(source).includes('virtualRowObserversRef.current')
  ) as ts.CallExpression
  const schedulerDeclaration = findExpression(
    (node) =>
      ts.isVariableDeclaration(node) && node.name.getText(source) === 'scheduleNotebookScrollState'
  ) as ts.VariableDeclaration
  assert.ok(
    schedulerDeclaration.initializer && ts.isCallExpression(schedulerDeclaration.initializer)
  )

  let requested = 0
  let refreshed = 0
  let disconnected = 0
  const frames = new Map<number, () => void>()
  const scrollFrameRef: { current: number | null } = { current: null }
  const virtualRowObserversRef = {
    current: new Map([['cell', { disconnect: () => disconnected++ }]])
  }
  const bindings = {
    scrollFrameRef,
    virtualRowObserversRef,
    updateNotebookScrollState: () => refreshed++,
    window: {
      requestAnimationFrame: (handler: () => void): number => {
        frames.set(++requested, handler)
        return requested
      },
      cancelAnimationFrame: (id: number): void => {
        frames.delete(id)
      }
    }
  }
  const setup = callback(effectCall.arguments[0], bindings)
  const schedule = callback(schedulerDeclaration.initializer.arguments[0], bindings)
  const firstCleanup = setup() as () => void
  schedule()
  assert.equal(requested, 1)

  // The real entrypoint wraps App in StrictMode: setup -> cleanup -> setup.
  firstCleanup()
  const secondCleanup = setup() as () => void
  schedule()
  assert.equal(requested, 2, 'a cancelled frame must not permanently block later scroll updates')
  assert.equal(disconnected, 1)
  assert.equal(virtualRowObserversRef.current.size, 0)
  frames.get(scrollFrameRef.current!)!()
  assert.equal(refreshed, 1)
  assert.equal(scrollFrameRef.current, null)
  secondCleanup()
})
