import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  saveWorkspaceTextFile,
  validateWorkspaceTextSaveRequest,
  type WorkspaceTextFileDependencies
} from '../src/main/workspace-text-file'
import { saveWorkspaceMarkdownFile } from '../src/main/workspace-markdown-file'
import {
  WORKSPACE_MARKDOWN_MAX_BYTES,
  WORKSPACE_TEXT_MAX_BYTES,
  type WorkspaceTextSaveRequest
} from '../src/shared/workspaceFileOperations'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { Project } from '../src/main/agent/projects'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import { remoteWorkspaceUri } from '../src/shared/remoteWorkspacePath'

function localRequest(
  rootPath: string,
  path: string,
  expectedContent = 'before\n',
  content = 'after\n'
): WorkspaceTextSaveRequest {
  return { kind: 'local', rootPath, path, expectedContent, content }
}

test('generic text saves support source, data, HTML, extensionless and dotfiles', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-text-save-')))
  try {
    for (const name of [
      'note.txt',
      'data.json',
      'script.py',
      'data.csv',
      'page.html',
      'run.sh',
      'README',
      '.gitignore'
    ]) {
      const path = join(root, name)
      writeFileSync(path, 'before\n')
      const result = await saveWorkspaceTextFile(
        localRequest(root, path, 'before\n', '修改后的文本\n')
      )
      assert.deepEqual(result, {
        path,
        content: '修改后的文本\n',
        bytes: Buffer.byteLength('修改后的文本\n')
      })
      assert.equal(readFileSync(path, 'utf8'), result.content)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generic text saves preserve BOM, CRLF and executable file permissions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-text-format-')))
  const path = join(root, 'run.sh')
  const original = '\uFEFF#!/bin/sh\r\necho before\r\n'
  try {
    writeFileSync(path, original)
    chmodSync(path, 0o755)
    const saved = await saveWorkspaceTextFile(
      localRequest(root, path, original, '#!/bin/sh\necho after\n')
    )
    assert.equal(saved.content, '\uFEFF#!/bin/sh\r\necho after\r\n')
    assert.equal(readFileSync(path, 'utf8'), saved.content)
    assert.equal(statSync(path).mode & 0o777, 0o755)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generic text saves reject binary and invalid UTF-8 sources even with text extensions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-text-binary-')))
  const path = join(root, 'binary.txt')
  try {
    for (const bytes of [Buffer.from('before\0binary'), Buffer.from([0xc3, 0x28])]) {
      writeFileSync(path, bytes)
      await assert.rejects(saveWorkspaceTextFile(localRequest(root, path)), /UTF-8/)
      assert.deepEqual(readFileSync(path), bytes)
    }
    for (const content of ['\0binary', '\ud800', 'x'.repeat(WORKSPACE_TEXT_MAX_BYTES + 1)]) {
      assert.throws(() => validateWorkspaceTextSaveRequest(localRequest(root, path, '', content)))
    }
    assert.throws(() =>
      validateWorkspaceTextSaveRequest({ ...localRequest(root, path), arbitrary: true })
    )
    assert.equal(WORKSPACE_TEXT_MAX_BYTES, WORKSPACE_MARKDOWN_MAX_BYTES)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generic text saves keep existing-file, workspace and symlink boundaries', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-text-boundary-')))
  const root = join(base, 'project')
  const outside = join(base, 'outside.txt')
  const path = join(root, 'file.txt')
  mkdirSync(root)
  writeFileSync(path, 'before\n')
  writeFileSync(outside, 'before\n')
  symlinkSync(path, join(root, 'alias.txt'))
  try {
    for (const target of [root, outside, join(root, 'alias.txt')]) {
      await assert.rejects(
        saveWorkspaceTextFile(localRequest(root, target)),
        /根目录|目录外|符号链接/
      )
    }
    const missing = join(root, 'new.txt')
    await assert.rejects(saveWorkspaceTextFile(localRequest(root, missing)), /ENOENT/)
    assert.equal(existsSync(missing), false)
    assert.equal(readFileSync(outside, 'utf8'), 'before\n')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('generic text saves detect external writes after the read and retain bounded full-source CAS', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-text-conflict-')))
  const path = join(root, 'data.csv')
  try {
    writeFileSync(path, 'before\n')
    await assert.rejects(
      saveWorkspaceTextFile(localRequest(root, path), {
        beforeWrite: () => writeFileSync(path, 'external\n')
      }),
      /已在磁盘上变化/
    )
    assert.equal(readFileSync(path, 'utf8'), 'external\n')
    writeFileSync(path, 'x'.repeat(WORKSPACE_TEXT_MAX_BYTES + 1))
    await assert.rejects(saveWorkspaceTextFile(localRequest(root, path)), /超过/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy Markdown saves keep their extension guard while sharing the text writer', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-text-markdown-')))
  try {
    const plain = join(root, 'file.txt')
    writeFileSync(plain, 'before\n')
    await assert.rejects(saveWorkspaceMarkdownFile(localRequest(root, plain)), /只能保存 .md/)
    assert.equal(readFileSync(plain, 'utf8'), 'before\n')
    for (const name of ['file.md', 'file.MARKDOWN', 'file.mdown']) {
      const path = join(root, name)
      writeFileSync(path, 'before\n')
      const saved = await saveWorkspaceMarkdownFile(localRequest(root, path))
      assert.equal(saved.content, 'after\n')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generic remote text saves keep project/session binding for files without Markdown extensions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-remote-text-')))
  const agentDir = join(root, 'phi-state')
  const path = join(root, 'data.csv')
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot: root
  }
  const project = { id: 'project-a', location } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  let hostCreations = 0
  const dependencies: WorkspaceTextFileDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: () => ({ id: 'host-a', label: 'Cluster', hostAlias: 'cluster-a' }),
    createRemoteHost: (config) => {
      assert.equal(config.remoteRoot, root)
      hostCreations += 1
      return new LocalHost(root)
    }
  }
  const request = {
    kind: 'remote' as const,
    sessionId: manifest.sessionId,
    projectId: project.id,
    path,
    expectedContent: 'a,b\n1,2\n',
    content: 'a,b\n3,4\n'
  }
  try {
    writeFileSync(path, request.expectedContent)
    await assert.rejects(
      saveWorkspaceTextFile({ ...request, sessionId: 'foreign-session' }, dependencies),
      /不匹配/
    )
    assert.equal(hostCreations, 0)
    const result = await saveWorkspaceTextFile(request, dependencies)
    assert.equal(result.path, remoteWorkspaceUri('cluster-a', path))
    assert.equal(readFileSync(path, 'utf8'), request.content)
    assert.equal(hostCreations, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
