import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
  saveWorkspaceMarkdownFile,
  validateWorkspaceMarkdownSaveRequest,
  type WorkspaceMarkdownFileDependencies
} from '../src/main/workspace-markdown-file'
import {
  WORKSPACE_MARKDOWN_MAX_BYTES,
  type WorkspaceMarkdownSaveRequest
} from '../src/shared/workspaceFileOperations'
import { remoteWorkspaceUri } from '../src/shared/remoteWorkspacePath'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'
import type { Project } from '../src/main/agent/projects'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'

function fixture(): {
  base: string
  root: string
  outside: string
  agentDir: string
  location: { kind: 'ssh'; hostProfileId: string; remoteRoot: string; canonicalRoot: string }
  project: Project
  manifest: PhiSessionManifest
  dependencies: WorkspaceMarkdownFileDependencies
  connections: string[]
  writes: Array<{ path: string; expectedHash?: string }>
  remoteHost: WorkspaceHost
  hostCreations: () => number
  closes: () => number
  local: (path: string, expectedContent?: string, content?: string) => WorkspaceMarkdownSaveRequest
  remote: (path: string, expectedContent?: string, content?: string) => WorkspaceMarkdownSaveRequest
  cleanup: () => void
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-markdown-save-')))
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  const agentDir = join(base, 'phi')
  mkdirSync(root)
  mkdirSync(outside)
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
    projectLocation: { ...location },
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const localHost = new LocalHost(root)
  let hostCreations = 0
  let closes = 0
  const writes: Array<{ path: string; expectedHash?: string }> = []
  const connections: string[] = []
  const remoteHost: WorkspaceHost = {
    fs: {
      ...localHost.fs,
      writeAtomic: async (path, content, options) => {
        writes.push({ path, expectedHash: options?.expectedHash })
        return localHost.fs.writeAtomic(path, content, options)
      }
    },
    exec: localHost.exec,
    capabilities: () => localHost.capabilities(),
    close: async () => {
      closes += 1
    }
  }
  const dependencies: WorkspaceMarkdownFileDependencies = {
    agentDir,
    getManifest: (id) => (id === 'session-a' ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (config) => {
      connections.push(config.host)
      return createLocalShellSession(root)
    },
    createRemoteHost: (config) => {
      hostCreations += 1
      assert.equal(config.canonicalRoot, root)
      return remoteHost
    }
  }
  return {
    base,
    root,
    outside,
    agentDir,
    location,
    project,
    manifest,
    dependencies,
    connections,
    writes,
    remoteHost,
    hostCreations: () => hostCreations,
    closes: () => closes,
    local: (path: string, expectedContent = '# Before\n', content = '# After\n') => ({
      kind: 'local' as const,
      rootPath: root,
      path,
      expectedContent,
      content
    }),
    remote: (path: string, expectedContent = '# Before\n', content = '# After\n') => ({
      kind: 'remote' as const,
      sessionId: 'session-a',
      projectId: project.id,
      path,
      expectedContent,
      content
    }),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

test('Markdown saves persist exact content, retain CRLF/BOM and file permissions', async () => {
  const f = fixture()
  try {
    const path = join(f.root, '说明.MD')
    const original = '\uFEFF# Before\r\n正文\r\n'
    writeFileSync(path, original)
    chmodSync(path, 0o640)
    const result = await saveWorkspaceMarkdownFile(
      f.local(path, original, '# After\n正文\n'),
      f.dependencies
    )
    const expected = '\uFEFF# After\r\n正文\r\n'
    assert.deepEqual(result, { path, content: expected, bytes: Buffer.byteLength(expected) })
    assert.equal(readFileSync(path, 'utf8'), expected)
    assert.equal(statSync(path).mode & 0o777, 0o640)
    const empty = await saveWorkspaceMarkdownFile(f.local(path, expected, ''), f.dependencies)
    assert.equal(empty.content, '\uFEFF')
  } finally {
    f.cleanup()
  }
})

test('Markdown saves reject stale source and CAS conflicts occurring after the read', async () => {
  const f = fixture()
  const path = join(f.root, 'note.md')
  try {
    writeFileSync(path, '# External\n')
    await assert.rejects(saveWorkspaceMarkdownFile(f.local(path), f.dependencies), /已在磁盘上变化/)
    assert.equal(readFileSync(path, 'utf8'), '# External\n')
    writeFileSync(path, '# Before\n')
    await assert.rejects(
      saveWorkspaceMarkdownFile(f.local(path), {
        ...f.dependencies,
        beforeWrite: () => writeFileSync(path, '# Changed during save\n')
      }),
      /已在磁盘上变化/
    )
    assert.equal(readFileSync(path, 'utf8'), '# Changed during save\n')
    writeFileSync(path, '# Before\n')
    const results = await Promise.allSettled([
      saveWorkspaceMarkdownFile(f.local(path, '# Before\n', '# First\n'), f.dependencies),
      saveWorkspaceMarkdownFile(f.local(path, '# Before\n', '# Second\n'), f.dependencies)
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  } finally {
    f.cleanup()
  }
})

test('Markdown saves reject path escapes, symlinks, directories and private remote anchors', async () => {
  const f = fixture()
  try {
    const path = join(f.root, 'note.md')
    const outside = join(f.outside, 'note.md')
    writeFileSync(path, '# Before\n')
    writeFileSync(outside, '# Before\n')
    symlinkSync(path, join(f.root, 'alias.md'))
    symlinkSync(f.outside, join(f.root, 'escape'))
    const directory = join(f.root, 'directory.md')
    mkdirSync(directory)
    for (const target of [
      outside,
      join(f.root, 'alias.md'),
      join(f.root, 'escape', 'note.md'),
      directory
    ]) {
      await assert.rejects(
        saveWorkspaceMarkdownFile(f.local(target), f.dependencies),
        /目录外|符号链接|普通/
      )
    }
    const anchor = ensureRemoteProjectAnchor('other-project', f.agentDir)
    const anchoredFile = join(anchor, 'private.md')
    writeFileSync(anchoredFile, '# Before\n')
    await assert.rejects(
      saveWorkspaceMarkdownFile({ ...f.local(anchoredFile), rootPath: anchor }, f.dependencies),
      /锚点/
    )
    assert.equal(readFileSync(outside, 'utf8'), '# Before\n')
  } finally {
    f.cleanup()
  }
})

test('Markdown saves enforce extension, exact fields, full UTF-8 and byte bounds', async () => {
  const f = fixture()
  const path = join(f.root, 'note.md')
  try {
    for (const request of [
      { ...f.local(path), hostAlias: 'untrusted' },
      f.local(join(f.root, 'note.txt')),
      f.local(`${f.root}/../outside/note.md`),
      f.local(path, '# Before\n', '\ud800'),
      f.local(path, '# Before\n', '\0binary'),
      f.local(path, '# Before\n', '你'.repeat(Math.ceil(WORKSPACE_MARKDOWN_MAX_BYTES / 3)))
    ]) {
      assert.throws(() => validateWorkspaceMarkdownSaveRequest(request))
    }
    writeFileSync(path, Buffer.from([0xc3, 0x28]))
    await assert.rejects(saveWorkspaceMarkdownFile(f.local(path, '�('), f.dependencies), /UTF-8/)
    writeFileSync(path, 'x'.repeat(WORKSPACE_MARKDOWN_MAX_BYTES + 1))
    await assert.rejects(saveWorkspaceMarkdownFile(f.local(path), f.dependencies), /超过/)
    writeFileSync(path, 'x'.repeat(WORKSPACE_MARKDOWN_MAX_BYTES))
    const result = await saveWorkspaceMarkdownFile(
      f.local(
        path,
        'x'.repeat(WORKSPACE_MARKDOWN_MAX_BYTES),
        'y'.repeat(WORKSPACE_MARKDOWN_MAX_BYTES)
      ),
      f.dependencies
    )
    assert.equal(result.bytes, WORKSPACE_MARKDOWN_MAX_BYTES)
  } finally {
    f.cleanup()
  }
})

test('remote Markdown saves use the project-bound host, CAS hash and canonical display identity', async () => {
  const f = fixture()
  try {
    const path = join(f.root, 'note.markdown')
    writeFileSync(path, '# Before\n')
    const result = await saveWorkspaceMarkdownFile(f.remote(path), f.dependencies)
    assert.deepEqual(result, {
      path: remoteWorkspaceUri('cluster-a', path),
      content: '# After\n',
      bytes: Buffer.byteLength('# After\n')
    })
    assert.deepEqual(f.writes, [
      {
        path,
        expectedHash: createHash('sha256').update('# Before\n').digest('hex')
      }
    ])
    assert.equal(readFileSync(path, 'utf8'), '# After\n')
    assert.equal(f.hostCreations(), 1)
    assert.equal(f.closes(), 1)
    const pinned = f.dependencies.createRemoteHost!
    await saveWorkspaceMarkdownFile(f.remote(path, '# After\n'), {
      ...f.dependencies,
      createRemoteHost: (config) => {
        void config.connect().then((session) => session.close())
        return pinned(config)
      }
    })
    assert.deepEqual(f.connections, ['cluster-a'])
  } finally {
    f.cleanup()
  }
})

test('remote Markdown saves reject foreign sessions, paths, symlinks and changed bindings', async () => {
  const f = fixture()
  const path = join(f.root, 'note.mdown')
  try {
    writeFileSync(path, '# Before\n')
    await assert.rejects(
      saveWorkspaceMarkdownFile(
        { ...f.remote(path), sessionId: 'foreign-session' },
        f.dependencies
      ),
      /不匹配/
    )
    assert.equal(f.hostCreations(), 0)
    await assert.rejects(
      saveWorkspaceMarkdownFile(f.remote(join(f.outside, 'note.mdown')), f.dependencies),
      /不属于当前项目/
    )
    symlinkSync(path, join(f.root, 'alias.mdown'))
    await assert.rejects(
      saveWorkspaceMarkdownFile(f.remote(join(f.root, 'alias.mdown')), f.dependencies),
      /符号链接/
    )
    await assert.rejects(
      saveWorkspaceMarkdownFile(f.remote(path), {
        ...f.dependencies,
        createRemoteHost: (config) => {
          const host = f.dependencies.createRemoteHost!(config)
          return {
            ...host,
            fs: {
              ...host.fs,
              readRange: async (...args) => {
                const source = await host.fs.readRange(...args)
                f.location.remoteRoot = f.outside
                return source
              }
            }
          }
        }
      }),
      /不匹配|连接已变化/
    )
    assert.equal(f.writes.length, 0)
    assert.equal(readFileSync(path, 'utf8'), '# Before\n')
    assert.equal(f.closes(), 3)
  } finally {
    f.cleanup()
  }
})

test('remote Markdown saves execute the real SSH read/write protocol and preserve text format', async () => {
  const f = fixture()
  const restoreSetsid = installSetsidShim(f.base)
  const path = join(f.root, '远程笔记.md')
  const original = '\uFEFF# Before\r\n正文\r\n'
  const dependencies: WorkspaceMarkdownFileDependencies = {
    ...f.dependencies,
    createRemoteHost: undefined,
    connectImpl: async (config) => {
      assert.equal(config.host, 'cluster-a')
      const session = createLocalShellSession(f.root)
      session.execWithInput = async (command, input) => {
        const process = await session.openStdio!(command)
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        process.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        process.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        process.stdin.on('error', () => undefined)
        process.stdin.end(input)
        const result = await process.closed
        return {
          ...result,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        }
      }
      return session
    }
  }
  try {
    writeFileSync(path, original)
    chmodSync(path, 0o640)
    const result = await saveWorkspaceMarkdownFile(
      f.remote(path, original, '# After\n正文\n'),
      dependencies
    )
    assert.equal(result.content, '\uFEFF# After\r\n正文\r\n')
    assert.equal(readFileSync(path, 'utf8'), result.content)
    assert.equal(statSync(path).mode & 0o777, 0o640)
    await assert.rejects(
      saveWorkspaceMarkdownFile(f.remote(path, result.content), {
        ...dependencies,
        beforeWrite: () => writeFileSync(path, '# External\n')
      }),
      /已在磁盘上变化/
    )
    assert.equal(readFileSync(path, 'utf8'), '# External\n')
  } finally {
    restoreSetsid()
    f.cleanup()
  }
})
