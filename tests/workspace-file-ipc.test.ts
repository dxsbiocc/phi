import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

import { registerWorkspaceFileIpc } from '../src/main/workspace-file-ipc'

test('workspace mutations and downloads reject untrusted frames before filesystem or dialogs', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  let localChecks = 0
  let dialogs = 0
  let trashes = 0
  registerWorkspaceFileIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      }
    },
    requireRenderer: () => {
      throw new Error('untrusted frame')
    },
    requireLocalWorkspaceRoot: () => {
      localChecks += 1
    },
    dialog: {
      showSaveDialog: async () => {
        dialogs += 1
        return { canceled: true, filePath: '' }
      }
    },
    shell: {
      trashItem: async () => {
        trashes += 1
      }
    },
    downloads: new Map(),
    observeRemote: async (_, operation) => operation()
  })
  for (const channel of [
    'files:saveTextFile',
    'files:saveMarkdownFile',
    'files:renameWorkspaceFile',
    'files:deleteWorkspaceFile',
    'remoteWorkspace:download'
  ]) {
    await assert.rejects(
      async () => handlers.get(channel)!({} as IpcMainInvokeEvent, {}),
      /untrusted frame/
    )
  }
  assert.deepEqual({ localChecks, dialogs, trashes }, { localChecks: 0, dialogs: 0, trashes: 0 })
})

test('local IPC operations require the active local workspace scope and delete through trash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-file-ipc-'))
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const event = {} as IpcMainInvokeEvent
  let remoteActive = false
  const trashed: string[] = []
  registerWorkspaceFileIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      }
    },
    requireRenderer: () => ({}) as BrowserWindow,
    requireLocalWorkspaceRoot: (requested) => {
      if (remoteActive || requested !== root) throw new Error('not the active local workspace')
    },
    dialog: { showSaveDialog: async () => ({ canceled: true, filePath: '' }) },
    shell: {
      trashItem: async (path) => {
        trashed.push(path)
      }
    },
    downloads: new Map(),
    observeRemote: async (_, operation) => operation()
  })
  try {
    const source = join(root, 'source.txt')
    writeFileSync(source, 'hello')
    await assert.rejects(
      async () =>
        handlers.get('files:deleteWorkspaceFile')!(event, {
          kind: 'local',
          rootPath: '/',
          path: source
        }),
      /active local workspace/
    )
    const result = await handlers.get('files:renameWorkspaceFile')!(event, {
      kind: 'local',
      rootPath: root,
      path: source,
      newName: 'renamed.txt'
    })
    assert.deepEqual(result, { path: join(root, 'renamed.txt') })
    await handlers.get('files:deleteWorkspaceFile')!(event, {
      kind: 'local',
      rootPath: root,
      path: join(root, 'renamed.txt')
    })
    assert.equal(trashed.length, 1)
    const markdown = join(root, 'note.md')
    writeFileSync(markdown, '# Before\n')
    const save = handlers.get('files:saveMarkdownFile')!
    const markdownRequest = {
      kind: 'local',
      rootPath: root,
      path: markdown,
      expectedContent: '# Before\n',
      content: '# After\n'
    }
    await assert.rejects(
      async () => save(event, { ...markdownRequest, rootPath: '/' }),
      /active local workspace/
    )
    assert.deepEqual(await save(event, markdownRequest), {
      path: markdown,
      content: '# After\n',
      bytes: Buffer.byteLength('# After\n')
    })
    assert.equal(readFileSync(markdown, 'utf8'), '# After\n')
    const textPath = join(root, 'example.py')
    writeFileSync(textPath, 'print(1)\n')
    const saveText = handlers.get('files:saveTextFile')!
    const textRequest = {
      ...markdownRequest,
      path: textPath,
      expectedContent: 'print(1)\n',
      content: 'print(2)\n'
    }
    await assert.rejects(
      async () => saveText(event, { ...textRequest, rootPath: '/' }),
      /active local workspace/
    )
    assert.deepEqual(await saveText(event, textRequest), {
      path: textPath,
      content: 'print(2)\n',
      bytes: Buffer.byteLength('print(2)\n')
    })
    const pendingSave = save(event, {
      ...markdownRequest,
      expectedContent: '# After\n',
      content: '# Should remain unsaved\n'
    })
    const pendingTextSave = saveText(event, {
      ...textRequest,
      expectedContent: 'print(2)\n',
      content: 'print(3)\n'
    })
    remoteActive = true
    await Promise.all([
      assert.rejects(async () => pendingSave, /active local workspace/),
      assert.rejects(async () => pendingTextSave, /active local workspace/)
    ])
    assert.equal(readFileSync(textPath, 'utf8'), 'print(2)\n')
    assert.equal(readFileSync(markdown, 'utf8'), '# After\n')
    await assert.rejects(async () => save(event, markdownRequest), /active local workspace/)
    await assert.rejects(async () => saveText(event, textRequest), /active local workspace/)
    await assert.rejects(
      async () =>
        handlers.get('files:deleteWorkspaceFile')!(event, {
          kind: 'local',
          rootPath: root,
          path: join(root, 'renamed.txt')
        }),
      /active local workspace/
    )
    assert.equal(trashed.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('download IPC validates input before save dialog and cancellation never starts a transfer', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  let dialogs = 0
  let transfers = 0
  registerWorkspaceFileIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      }
    },
    requireRenderer: () => ({}) as BrowserWindow,
    requireLocalWorkspaceRoot: () => undefined,
    dialog: {
      showSaveDialog: async () => {
        dialogs += 1
        return { canceled: true, filePath: '' }
      }
    },
    shell: { trashItem: async () => undefined },
    downloads: new Map(),
    observeRemote: async (_, operation) => {
      transfers += 1
      return operation()
    }
  })
  const event = {} as IpcMainInvokeEvent
  const download = handlers.get('remoteWorkspace:download')!
  const request = {
    sessionId: 'session',
    projectId: 'project',
    path: '/project/file.txt',
    requestId: 'download_001'
  }
  await assert.rejects(
    async () => download(event, { ...request, destination: '/tmp/renderer-chosen.txt' }),
    /绝对文件路径/
  )
  assert.equal(dialogs, 0)
  assert.deepEqual(await download(event, request), { status: 'cancelled' })
  assert.equal(dialogs, 1)
  assert.equal(transfers, 0)
})
