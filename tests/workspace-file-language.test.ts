import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, test } from 'node:test'
import ts from 'typescript'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { filePreviewCopy } from '../src/renderer/src/features/file-preview/lib/filePreviewUiCopy'
import { readableErrorMessage } from '../src/renderer/src/lib/sessionNotifications'
import {
  isWorkspaceFileDownloadCancellation,
  remoteFileRequestForUri,
  workspaceFileRoute
} from '../src/renderer/src/useWorkspaceFileTabs'
import { notebookEnvironmentErrorMessage } from '../src/renderer/src/features/analysis/lib/analysisNotebookRuntimeUtils'

const source = ts.createSourceFile(
  'useWorkspaceFileTabs.ts',
  readFileSync('src/renderer/src/useWorkspaceFileTabs.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
function callback(name: string, bindings: Record<string, unknown>): unknown {
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      initializer = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(initializer, `${name} must be an actual hook callback`)
  const code = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return runInNewContext(code, {
    filePreviewCopy,
    readableErrorMessage,
    workspaceFileRoute,
    isWorkspaceFileDownloadCancellation,
    ...bindings
  })
}

afterEach(() => setUiLanguage('en'))

test('remote route validation uses current language while keeping original service diagnostics unchanged', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    assert.throws(
      () => remoteFileRequestForUri('ssh://cluster/work/file.txt', null),
      language === 'en' ? /remote file is outside the current project/ : /远程文件不属于当前项目/
    )
    assert.equal(
      readableErrorMessage(new Error('服务器原始错误: ENOENT'), filePreviewCopy.previewFileFailed),
      '服务器原始错误: ENOENT'
    )
  }
})

test('the same preview callback resolves localized fallbacks at invocation and preserves raw errors', async () => {
  let error: unknown
  let state: { status: string; message?: string } | undefined
  const invoke = callback('loadFilePreview', {
    cancelActiveWrapperResultRead: () => undefined,
    filePreviewRequestRef: { current: 0 },
    wrapperResultScopeRef: { current: null },
    activeResultReadIdRef: { current: null },
    getActiveProjectId: () => null,
    getActiveRemoteProject: () => null,
    rendererApi: {
      previewFile: async () => {
        throw error
      }
    },
    setFilePreview: (next: typeof state) => {
      state = next
    },
    cacheFilePreviewState: () => undefined,
    upsertWorkspaceFileTab: () => undefined
  }) as (path: string) => void
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    error = undefined
    invoke('/project/unchanged_中文.txt')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(state?.status, 'error')
    assert.equal(state?.message, language === 'en' ? 'Could not preview the file' : '无法预览文件')
    error = new Error('服务器拒绝访问: EACCES')
    invoke('/project/unchanged_中文.txt')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(state?.message, '服务器拒绝访问: EACCES')
  }
})

test('download cancellation recognizes raw Chinese, English and AbortError independently of language', () => {
  const abort = new Error('The operation could not finish')
  abort.name = 'AbortError'
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    for (const error of [
      '下载已取消',
      'Download cancelled',
      'Download canceled',
      'The operation was aborted',
      'AbortError: aborted',
      abort
    ])
      assert.equal(isWorkspaceFileDownloadCancellation(error), true)
    for (const error of ['下载失败', 'Could not cancel the download', 'download failed', undefined])
      assert.equal(isWorkspaceFileDownloadCancellation(error), false)
  }
})

test('actual download callback clears cancellation and localizes failures without changing server error text', async () => {
  let error: unknown
  const states: unknown[] = []
  const notices: Array<{ error: unknown; fallback: string }> = []
  const project = {
    sessionId: 'session',
    projectId: 'project',
    hostAlias: 'cluster',
    canonicalRoot: '/work'
  }
  const invoke = callback('downloadWrapperResultFile', {
    wrapperResultScopeRef: { current: null },
    activeDownloadIdRef: { current: null },
    downloadSequenceRef: { current: 0 },
    getActiveProjectId: () => project.projectId,
    getActiveRemoteProject: () => project,
    setFileDownload: (state: unknown) => states.push(state),
    rendererApi: {
      downloadRemoteWorkspaceFile: async () => {
        throw error
      }
    },
    showSnackbarError: (error: unknown, fallback: string) => notices.push({ error, fallback })
  }) as (uri: string) => Promise<void>
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    for (const message of ['下载已取消', 'Download cancelled', 'Download canceled', 'aborted']) {
      error = new Error(message)
      await invoke('ssh://cluster/work/result.txt')
      assert.equal(states.at(-1), null)
      assert.equal(notices.length, 0)
    }
    error = new Error('服务器原始错误: EIO')
    await invoke('ssh://cluster/work/result.txt')
    assert.deepEqual(JSON.parse(JSON.stringify(states.at(-1))), {
      status: 'error',
      sourcePath: 'ssh://cluster/work/result.txt',
      message: '服务器原始错误: EIO'
    })
    assert.equal(
      notices.pop()?.fallback,
      language === 'en' ? 'Remote file download failed' : '远程文件下载失败'
    )
  }
})

test('notebook environment classification keeps both raw runtime languages and appends only localized guidance', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    for (const raw of [
      '环境未构建',
      '环境 phi:python@1 尚未构建。',
      'environment phi:python@1 is not ready'
    ]) {
      const message = notebookEnvironmentErrorMessage(new Error(raw), 'fallback')
      assert.ok(message.startsWith(raw))
      assert.ok(message.includes(language === 'en' ? 'Settings → Environments' : '设置 → 环境'))
      assert.equal(
        notebookEnvironmentErrorMessage(new Error(message), 'fallback'),
        message,
        'Guidance must not be appended twice'
      )
    }
    assert.equal(
      notebookEnvironmentErrorMessage(new Error('external kernel diagnostic'), 'fallback'),
      'external kernel diagnostic'
    )
  }
})
