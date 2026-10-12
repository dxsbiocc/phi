import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const dialogPath = 'src/renderer/src/features/mcp/components/McpCustomConnectorDialog.tsx'
const catalogPath = 'src/renderer/src/features/mcp/components/McpConnectorCatalogDialog.tsx'

function nestedFunction(path: string, name: string): string {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let found: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(found, `missing ${name} in ${path}`)
  return ts.transpileModule(`${found.getText(source)}; ${name}(request);`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

const addLocalCode = nestedFunction(catalogPath, 'addLocal')
const submitLocalCode = nestedFunction(dialogPath, 'submitLocal')
const confirmLocalCode = nestedFunction(dialogPath, 'confirmLocal')
const cancelLocalConfirmCode = nestedFunction(dialogPath, 'cancelLocalConfirm')
const submitRemoteCode = nestedFunction(dialogPath, 'submitRemote')
const request = {
  name: 'fixture',
  runtime: { kind: 'host' },
  command: '/usr/bin/true',
  args: ['--stdio'],
  env: {}
}

test('local connector submission opens confirmation with the validated request', () => {
  const first: unknown[] = []
  runInNewContext(submitLocalCode, {
    busy: false,
    request,
    localDraft: { fixture: true },
    buildLocalConnectorRequest: () => request,
    setLocalError: (value: unknown) => first.push(['error', value]),
    setLocalConfirmRequest: (value: unknown) => first.push(['confirm', value]),
    onSubmitLocal: (value: unknown) => first.push(['submit', value])
  })
  assert.deepEqual(first, [
    ['error', null],
    ['confirm', request]
  ])
})

test('cancelling local confirmation closes only the confirmation dialog', () => {
  const events: unknown[] = []
  runInNewContext(cancelLocalConfirmCode, {
    request,
    localSubmitting: false,
    setLocalConfirmRequest: (value: unknown) => events.push(['confirm', value]),
    setLocalDraft: (value: unknown) => events.push(['draft', value])
  })
  assert.deepEqual(events, [['confirm', null]])
})

test('confirming submits once and closes the confirmation after the start call settles', async () => {
  const events: unknown[] = []
  await runInNewContext(confirmLocalCode, {
    request,
    localConfirmRequest: request,
    localSubmitting: false,
    setLocalSubmitting: (value: unknown) => events.push(['submitting', value]),
    setLocalConfirmRequest: (value: unknown) => events.push(['confirm', value]),
    onSubmitLocal: async (value: unknown) => events.push(['submit', value])
  })
  assert.deepEqual(events, [
    ['submitting', true],
    ['submit', request],
    ['submitting', false],
    ['confirm', null]
  ])
})

test('successful local start closes only the add dialog', async () => {
  const events: unknown[] = []
  await runInNewContext(addLocalCode, {
    request,
    setBusy: (value: unknown) => events.push(['busy', value]),
    setCustomError: (value: unknown) => events.push(['error', value]),
    setCustomOpen: (value: unknown) => events.push(['open', value]),
    ipcErrorMessage: String,
    onRefresh: async () => events.push(['refresh']),
    window: {
      api: {
        startLocalConnectorAdd: async (value: unknown) => {
          events.push(['start', value])
          return { started: true, name: 'fixture' }
        }
      }
    }
  })
  assert.deepEqual(events, [
    ['busy', 'fixture'],
    ['error', null],
    ['start', request],
    ['open', false],
    ['busy', null]
  ])
})

test('failed local add stays open and exposes the probe error inline', async () => {
  const events: unknown[] = []
  await runInNewContext(addLocalCode, {
    request,
    setBusy: (value: unknown) => events.push(['busy', value]),
    setCustomError: (value: unknown) => events.push(['error', value]),
    setCustomOpen: (value: unknown) => events.push(['open', value]),
    ipcErrorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    onRefresh: async () => events.push(['refresh']),
    window: {
      api: {
        startLocalConnectorAdd: async () => {
          throw new Error('同步验证失败')
        }
      }
    }
  })
  assert.deepEqual(events, [
    ['busy', 'fixture'],
    ['error', null],
    ['error', '同步验证失败'],
    ['busy', null]
  ])
})

test('remote custom connector submission keeps its existing OAuth request shape', () => {
  const submitted: unknown[] = []
  runInNewContext(submitRemoteCode, {
    request,
    remoteCanSubmit: true,
    busy: false,
    name: ' remote ',
    url: ' https://example.test/mcp ',
    clientId: ' client ',
    clientSecret: ' secret ',
    onSubmit: (...args: unknown[]) => submitted.push(args)
  })
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [
    [
      'remote',
      'https://example.test/mcp',
      { oauth: { clientId: 'client', clientSecret: 'secret' } }
    ]
  ])
})

test('GitHub Bun drafts keep their runtime hint through catalog and missing-runtime helper wiring', () => {
  const catalog = readFileSync(catalogPath, 'utf8')
  const dialog = readFileSync(dialogPath, 'utf8')

  assert.match(catalog, /runtimeHint:\s*draft\.runtimeHint/)
  assert.match(dialog, /initialDraft\.runtimeHint === 'bun'/)
  assert.match(dialog, /未找到 Phi 内置 Bun，请检查应用安装是否完整/)
})

test('local submit busy copy describes only the brief background start request', () => {
  const dialog = readFileSync(dialogPath, 'utf8')
  assert.doesNotMatch(dialog, /正在启动并验证…/)
  assert.match(dialog, /正在开始…/)
})

test('local connector form has no inline confirmation controls', () => {
  const form = readFileSync(
    'src/renderer/src/features/mcp/components/McpLocalConnectorForm.tsx',
    'utf8'
  )
  assert.doesNotMatch(form, /确认启动并验证|返回修改/)
  assert.doesNotMatch(form, /\bconfirm:/)
})
