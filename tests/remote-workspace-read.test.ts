import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import { readRemoteWorkspacePath } from '../src/main/agent/remote-workspace-read'
import {
  buildRemoteWorkspaceReadTool,
  PHI_REMOTE_READ_DESCRIPTION
} from '../src/main/agent/remote-workspace-read-tool'
import type { RemoteWorkspaceBoundaryDependencies } from '../src/main/agent/remote-workspace-boundary'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession } from './helpers/localShellSession'
import { assertBoundaryIdentity } from './helpers/remoteBoundaryIdentity'

function fixture(): {
  root: string
  agentDir: string
  commands: string[]
  closed: () => number
  dependencies: RemoteWorkspaceBoundaryDependencies
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-read-'))
  const agentDir = join(base, 'phi')
  const root = join(base, 'server-project')
  mkdirSync(root)
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot: realpathSync(root)
  }
  const project = {
    id: 'project-a',
    name: 'Remote',
    location,
    workingDirectory: root,
    workingDirectoryRealPath: realpathSync(root),
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z'
  } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const commands: string[] = []
  let closeCount = 0
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (): Promise<RemoteSshSession> => {
      const session = createLocalShellSession(root)
      const exec = session.exec.bind(session)
      const close = session.close.bind(session)
      session.exec = async (command) => {
        commands.push(command)
        return exec(command)
      }
      session.readTextFile = async () => {
        throw new Error('unbounded remote read must not be used')
      }
      session.writeTextFile = async () => {
        throw new Error('read must not write')
      }
      session.mkdirp = async () => {
        throw new Error('read must not write')
      }
      session.exists = async () => {
        throw new Error('extra probe must not be used')
      }
      session.uploadFile = async () => {
        throw new Error('read must not upload')
      }
      session.close = async () => {
        closeCount += 1
        await close()
      }
      return session
    }
  }
  return {
    root,
    agentDir,
    commands,
    closed: () => closeCount,
    dependencies,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

const request = (path: string): { sessionId: string; projectId: string; path: string } => ({
  sessionId: 'session-a',
  projectId: 'project-a',
  path
})

function localOmpSelectorOutput(content: string, selector: string): string {
  const script = `
    import { Settings } from '@oh-my-pi/pi-coding-agent'
    import { buildInMemorySelectorResult } from './node_modules/@oh-my-pi/pi-coding-agent/src/tools/read-format.ts'
    import { parseSel } from './node_modules/@oh-my-pi/pi-coding-agent/src/tools/read-selector.ts'
    const content = Buffer.from(process.env.PHI_SELECTOR_CONTENT, 'base64').toString('utf8')
    const session = {
      cwd: process.cwd(),
      hasEditTool: true,
      settings: Settings.isolated({ 'edit.mode': 'replace', readLineNumbers: true })
    }
    const result = await buildInMemorySelectorResult(
      session,
      content,
      parseSel(process.env.PHI_SELECTOR),
      { entityLabel: 'file', immutable: true }
    )
    process.stdout.write(JSON.stringify(result.content[0].text))
  `
  const result = spawnSync('bun', ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      PHI_SELECTOR: selector,
      PHI_SELECTOR_CONTENT: Buffer.from(content).toString('base64')
    }
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as string
}

test('ordinary remote read returns exact UTF-8 text and an SSH source, including empty files', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'note.txt'), 'alpha\nβeta\n')
    writeFileSync(join(sample.root, 'empty.json'), '')
    writeFileSync(
      join(sample.agentDir, 'remote-project-anchors', 'project-a', 'note.txt'),
      'anchor'
    )
    const note = await readRemoteWorkspacePath(request('note.txt'), sample.dependencies)
    assert.deepEqual(note, {
      kind: 'file',
      path: `ssh://cluster-a${realpathSync(join(sample.root, 'note.txt'))}`,
      content: 'alpha\nβeta\n',
      fileSize: Buffer.byteLength('alpha\nβeta\n'),
      contentType: 'text/plain'
    })
    assert.deepEqual(await readRemoteWorkspacePath(request('empty.json'), sample.dependencies), {
      kind: 'file',
      path: `ssh://cluster-a${realpathSync(join(sample.root, 'empty.json'))}`,
      content: '',
      fileSize: 0,
      contentType: 'application/json'
    })
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('remote read uses the WorkspaceHost session supplied by the main process', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'host.txt'), 'through host')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    let hostConnections = 0
    const result = await readRemoteWorkspacePath(request('host.txt'), {
      ...sample.dependencies,
      connectImpl: async () => {
        throw new Error('legacy SSH connection path was used')
      },
      connectHost: async () => {
        hostConnections += 1
        return connect({ host: 'cluster-a' })
      }
    })

    assert.equal(result.kind, 'file')
    assert.equal(result.content, 'through host')
    assert.equal(hostConnections, 1)
    assert.equal(
      sample.commands.some((command) => command.includes('O_NOFOLLOW')),
      true
    )
  } finally {
    sample.cleanup()
  }
})

test('directory records preserve newlines and quotes, sort directories first, and report empty', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'folder'))
    mkdirSync(join(sample.root, 'empty'))
    writeFileSync(join(sample.root, "line\n'quote'.txt"), 'x')
    writeFileSync(join(sample.root, 'z.txt'), 'z')
    const listed = await readRemoteWorkspacePath(request('.'), sample.dependencies)
    assert.equal(listed.kind, 'directory')
    if (listed.kind !== 'directory') throw new Error('expected directory')
    assert.deepEqual(
      listed.entries.map((entry) => [entry.name, entry.isDirectory]),
      [
        ['empty', true],
        ['folder', true],
        ["line\n'quote'.txt", false],
        ['z.txt', false]
      ]
    )
    assert.equal(listed.content.includes(JSON.stringify("line\n'quote'.txt")), true)
    const namedFile = await readRemoteWorkspacePath(
      request("line\n'quote'.txt"),
      sample.dependencies
    )
    assert.equal(namedFile.kind, 'file')
    assert.equal(namedFile.path.endsWith(encodeURIComponent("line\n'quote'.txt")), true)
    const empty = await readRemoteWorkspacePath(request('empty'), sample.dependencies)
    assert.equal(empty.kind, 'directory')
    assert.equal(empty.content, '(empty directory)')
  } finally {
    sample.cleanup()
  }
})

test('large remote text returns a bounded prefix and continuation instead of a size error', async () => {
  const sample = fixture()
  try {
    const content = `${Array.from({ length: 120_000 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    const fileSize = Buffer.byteLength(content)
    assert.ok(fileSize > 1024 * 1024)
    writeFileSync(join(sample.root, 'limit.txt'), content)
    const result = await readRemoteWorkspacePath(request('limit.txt'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected file read')
    assert.equal(result.fileSize, fileSize)
    assert.equal(result.truncated, true)
    assert.ok(Buffer.byteLength(result.content) < fileSize)
    assert.match(result.continuation ?? result.content, /Use :\d+ to continue/)
  } finally {
    sample.cleanup()
  }
})

test('binary and invalid UTF-8 remote files return actionable file guidance', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'binary.dat'), Buffer.from([0, 1, 2]))
    writeFileSync(join(sample.root, 'invalid.txt'), Buffer.from([0xff, 0xfe]))
    for (const path of ['binary.dat', 'invalid.txt']) {
      const result = await readRemoteWorkspacePath(request(path), sample.dependencies)
      assert.equal(result.kind, 'file')
      assert.match(result.content, /二进制/)
      assert.match(result.content, /\bfile\b/)
    }
  } finally {
    sample.cleanup()
  }
})

test('special files and symlink escapes remain rejected', async () => {
  const sample = fixture()
  try {
    const fifo = join(sample.root, 'pipe')
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
    await assert.rejects(
      readRemoteWorkspacePath(request('pipe'), sample.dependencies),
      /不是普通文件/
    )
    const outside = join(sample.agentDir, 'outside.txt')
    writeFileSync(outside, 'private')
    symlinkSync(outside, join(sample.root, 'escape'))
    await assert.rejects(
      readRemoteWorkspacePath(request('escape'), sample.dependencies),
      /超出项目根目录/
    )
  } finally {
    sample.cleanup()
  }
})

test('permission failures and oversized directory listings return explicit errors', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'private.txt'), 'private')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    await assert.rejects(
      readRemoteWorkspacePath(request('private.txt'), {
        ...sample.dependencies,
        connectImpl: async (config) => {
          const session = await connect(config)
          return {
            ...session,
            execBounded: undefined,
            exec: async (command) =>
              command.includes('Fcntl')
                ? { stdout: '', stderr: 'private diagnostic', code: 75, signal: null }
                : session.exec(command)
          }
        }
      }),
      /不可访问或已变成符号链接/
    )
    for (let index = 0; index < 1001; index += 1) {
      writeFileSync(join(sample.root, `entry-${index}`), '')
    }
    await assert.rejects(readRemoteWorkspacePath(request('.'), sample.dependencies), /条目过多/)
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('swapping a leaf or directory to an outside symlink after authorization is rejected', async () => {
  const sample = fixture()
  try {
    const outsideDir = join(sample.agentDir, 'outside')
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
    writeFileSync(join(sample.root, 'target.txt'), 'safe')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    let swaps = 0
    const swappedFileDependencies: RemoteWorkspaceBoundaryDependencies = {
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        let calls = 0
        return {
          ...session,
          execBounded: undefined,
          exec: async (command) => {
            const result = await session.exec(command)
            if (++calls === 1) {
              rmSync(join(sample.root, 'target.txt'))
              symlinkSync(join(outsideDir, 'secret.txt'), join(sample.root, 'target.txt'))
              swaps += 1
            }
            return result
          }
        }
      }
    }
    await assert.rejects(
      readRemoteWorkspacePath(request('target.txt'), swappedFileDependencies),
      /符号链接/
    )

    mkdirSync(join(sample.root, 'folder'))
    const swappedDirectoryDependencies: RemoteWorkspaceBoundaryDependencies = {
      ...sample.dependencies,
      connectImpl: async (config) => {
        const session = await connect(config)
        let calls = 0
        return {
          ...session,
          execBounded: undefined,
          exec: async (command) => {
            const result = await session.exec(command)
            if (++calls === 1) {
              rmSync(join(sample.root, 'folder'), { recursive: true })
              symlinkSync(outsideDir, join(sample.root, 'folder'))
              swaps += 1
            }
            return result
          }
        }
      }
    }
    await assert.rejects(
      readRemoteWorkspacePath(request('folder'), swappedDirectoryDependencies),
      /移出项目根目录/
    )
    assert.equal(swaps, 2)
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('missing file, malformed request, and disconnected SSH do not read the anchor', async () => {
  const sample = fixture()
  try {
    await assert.rejects(
      readRemoteWorkspacePath(request('missing'), sample.dependencies),
      /目标不存在/
    )
    await assert.rejects(
      readRemoteWorkspacePath({ ...request('x'), host: 'attacker' }, sample.dependencies),
      /只能包含会话、项目 ID 和路径/
    )
    await assert.rejects(
      readRemoteWorkspacePath(request('x'), {
        ...sample.dependencies,
        connectImpl: async () => {
          throw new Error('SSH offline')
        }
      }),
      /SSH offline/
    )
    writeFileSync(join(sample.root, 'x'), 'remote')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    await assert.rejects(
      readRemoteWorkspacePath(request('x'), {
        ...sample.dependencies,
        connectImpl: async (config) => {
          const session = await connect(config)
          let calls = 0
          return {
            ...session,
            execBounded: undefined,
            exec: async (command) => {
              if (++calls === 3) throw new Error('SSH dropped during read')
              return session.exec(command)
            }
          }
        }
      }),
      /SSH dropped during read/
    )
    assert.equal(sample.closed(), 2)
  } finally {
    sample.cleanup()
  }
})

test('same-name read tool preserves the SDK path parameter and remote source metadata', async () => {
  const calls: string[] = []
  const tool = buildRemoteWorkspaceReadTool(async (path) => {
    calls.push(path)
    return {
      kind: 'file',
      path: 'ssh://cluster-a/project/note.txt',
      content: 'remote text',
      fileSize: 11,
      contentType: 'text/plain'
    }
  })
  assert.equal(tool.name, 'read')
  assert.equal(tool.description, PHI_REMOTE_READ_DESCRIPTION)
  assert.deepEqual(tool.parameters.required, ['path'])
  const result = await tool.execute('call-1', { path: 'note.txt' }, undefined, {} as never)
  assert.equal(calls[0], 'note.txt')
  assert.equal(result.content[0]?.text, 'remote text')
  assert.deepEqual(result.details, {
    resolvedPath: 'ssh://cluster-a/project/note.txt',
    kind: 'file',
    fileSize: 11,
    contentType: 'text/plain'
  })
  const invalid = await tool.execute('call-2', {}, undefined, {} as never)
  assert.equal(invalid.isError, true)
  assert.equal(calls.length, 1)
})

test('remote read classifies an oversized BAM before size and suggests samtools', async () => {
  const sample = fixture()
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0)
    Buffer.from([0x42, 0x41, 0x4d, 0x01]).copy(bytes)
    writeFileSync(join(sample.root, 'alignments.bam'), bytes)
    const result = await readRemoteWorkspacePath(request('alignments.bam'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected file guidance')
    assert.match(result.content, /二进制文件（BAM）/)
    assert.match(result.content, /samtools/)
    assert.doesNotMatch(result.content, /超过 1 MiB|1 MiB 上限/)
  } finally {
    sample.cleanup()
  }
})

test('remote read identifies gzip and suggests zcat', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'reads.fastq.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
    const result = await readRemoteWorkspacePath(request('reads.fastq.gz'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected file guidance')
    assert.match(result.content, /二进制文件（GZIP|二进制文件（GZ/i)
    assert.match(result.content, /zcat/)
  } finally {
    sample.cleanup()
  }
})

test('remote read supports the local path:start-end selector format', async () => {
  const sample = fixture()
  try {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    writeFileSync(join(sample.root, 'lines.txt'), content)
    const result = await readRemoteWorkspacePath(request('lines.txt:10-12'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected selected text')
    assert.equal(result.content, localOmpSelectorOutput(content, '10-12'))
    assert.equal(result.truncated, true)
  } finally {
    sample.cleanup()
  }
})

test('remote read supports tail, open, multi-range and raw selector syntax', async () => {
  const sample = fixture()
  try {
    const content = `${Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    writeFileSync(join(sample.root, 'selector-lines.txt'), content)

    const tail = await readRemoteWorkspacePath(
      request('selector-lines.txt:-2'),
      sample.dependencies
    )
    const open = await readRemoteWorkspacePath(
      request('selector-lines.txt:58-'),
      sample.dependencies
    )
    const multi = await readRemoteWorkspacePath(
      request('selector-lines.txt:2-3,58-59'),
      sample.dependencies
    )
    const raw = await readRemoteWorkspacePath(
      request('selector-lines.txt:raw:10+2'),
      sample.dependencies
    )

    assert.equal(tail.kind, 'file')
    assert.equal(open.kind, 'file')
    assert.equal(multi.kind, 'file')
    assert.equal(raw.kind, 'file')
    if (
      tail.kind !== 'file' ||
      open.kind !== 'file' ||
      multi.kind !== 'file' ||
      raw.kind !== 'file'
    ) {
      assert.fail('expected selected text')
    }
    assert.equal(tail.content, localOmpSelectorOutput(content, '-2'))
    assert.equal(open.content, localOmpSelectorOutput(content, '58-'))
    assert.equal(multi.content, localOmpSelectorOutput(content, '2-3,58-59'))
    assert.equal(raw.content, localOmpSelectorOutput(content, 'raw:10+2'))
  } finally {
    sample.cleanup()
  }
})

test('remote read prefers a literal selector-looking file name', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'literal.txt:10-12'), 'literal content')
    const result = await readRemoteWorkspacePath(request('literal.txt:10-12'), sample.dependencies)
    assert.equal(result.kind, 'file')
    assert.equal(result.content, 'literal content')
  } finally {
    sample.cleanup()
  }
})

test('remote tail skips an oversized early line and raw selectors preserve CRLF bytes', async () => {
  const sample = fixture()
  try {
    const tailContent = `${'x'.repeat(80_000)}\nsecond\nthird\nfourth\n`
    const rawContent = 'first\r\nsecond\r\nthird\r\n'
    writeFileSync(join(sample.root, 'tail.txt'), tailContent)
    writeFileSync(join(sample.root, 'crlf.txt'), rawContent)
    const tail = await readRemoteWorkspacePath(request('tail.txt:-2'), sample.dependencies)
    const raw = await readRemoteWorkspacePath(request('crlf.txt:raw:2-2'), sample.dependencies)
    assert.equal(tail.kind, 'file')
    assert.equal(raw.kind, 'file')
    if (tail.kind !== 'file' || raw.kind !== 'file') assert.fail('expected selected text')
    assert.equal(tail.content, localOmpSelectorOutput(tailContent, '-2'))
    assert.equal(raw.content, localOmpSelectorOutput(rawContent, 'raw:2-2'))
  } finally {
    sample.cleanup()
  }
})

test('remote tail reports when a retained line exceeds the byte budget', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'long-tail.txt'), `first\n${'x'.repeat(80_000)}`)
    const result = await readRemoteWorkspacePath(request('long-tail.txt:-1'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected selected text')
    assert.equal(result.truncated, true)
    assert.match(result.content, /Tail output was truncated/)
    assert.match(result.continuation ?? '', /narrower :-N selector|bash tail/)
  } finally {
    sample.cleanup()
  }
})

test('remote read classifies NUL after the initial 512-byte head before applying size rules', async () => {
  const sample = fixture()
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61)
    bytes[600] = 0
    writeFileSync(join(sample.root, 'late-binary.dat'), bytes)
    const result = await readRemoteWorkspacePath(request('late-binary.dat'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected binary guidance')
    assert.match(result.content, /二进制文件/)
    assert.doesNotMatch(result.content, /1 MiB/)
  } finally {
    sample.cleanup()
  }
})

test('remote read records edit basis only for complete unselected text', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'small.txt'), 'one\ntwo\n')
    writeFileSync(join(sample.root, 'large.txt'), 'line\n'.repeat(220_000))
    const recorded: string[] = []
    const dependencies = {
      ...sample.dependencies,
      onFileRead: (_authorized: unknown, content: string) => recorded.push(content)
    }
    await readRemoteWorkspacePath(request('small.txt:1-1'), dependencies)
    await readRemoteWorkspacePath(request('large.txt'), dependencies)
    assert.deepEqual(recorded, [])
    await readRemoteWorkspacePath(request('small.txt'), dependencies)
    assert.deepEqual(recorded, ['one\ntwo\n'])
  } finally {
    sample.cleanup()
  }
})

test('remote read tool returns supported images as image content', async () => {
  const sample = fixture()
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
    writeFileSync(join(sample.root, 'pixel.png'), png)
    const tool = buildRemoteWorkspaceReadTool((path) =>
      readRemoteWorkspacePath(request(path), sample.dependencies)
    )
    const output = await tool.execute('image', { path: 'pixel.png' }, undefined, {} as never)
    assert.equal(output.isError, undefined)
    const image = output.content.find((item) => item.type === 'image')
    assert.deepEqual(image, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
  } finally {
    sample.cleanup()
  }
})

test('remote read returns metadata guidance instead of image content for an oversized image', async () => {
  const sample = fixture()
  try {
    const png = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    writeFileSync(join(sample.root, 'large.png'), png)
    const result = await readRemoteWorkspacePath(request('large.png'), sample.dependencies)
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected metadata guidance')
    assert.match(result.content, /PNG|图像/)
    assert.match(result.content, /10 MiB|过大/)
  } finally {
    sample.cleanup()
  }
})

test('remote read tool rejects undeclared parameters before invoking the host read', async () => {
  let calls = 0
  const tool = buildRemoteWorkspaceReadTool(async () => {
    calls += 1
    assert.fail('read callback must not run for undeclared parameters')
  })
  const result = await tool.execute(
    'strict',
    { path: 'note.txt', host: 'attacker' },
    undefined,
    {} as never
  )
  assert.equal(result.isError, true)
  assert.equal(calls, 0)
  assert.match(
    result.content[0]?.type === 'text' ? result.content[0].text : '',
    /只接受.*path|参数|只能包含/
  )
})

test('remote read passes only declared identity fields to the host connection boundary', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, 'note.txt'), 'safe')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    const result = await readRemoteWorkspacePath(request('note.txt'), {
      ...sample.dependencies,
      connectHost: async (input) => {
        assert.deepEqual(Object.keys(input).sort(), ['execTimeoutMs', 'projectId', 'sessionId'])
        const { execTimeoutMs, ...identity } = input
        assertBoundaryIdentity(identity)
        assert.equal(execTimeoutMs, 30_000)
        return connect({ host: 'cluster-a' })
      }
    })
    assert.equal(result.kind, 'file')
    assert.equal(result.content, 'safe')
  } finally {
    sample.cleanup()
  }
})

test('remote agent range decoding preserves UTF-8 split across a transport chunk', async () => {
  const sample = fixture()
  try {
    const content = `${'x\n'.repeat(32_767)}你\nlast\n`
    writeFileSync(join(sample.root, 'utf8-window.txt'), content)
    const result = await readRemoteWorkspacePath(
      request('utf8-window.txt:32768-32768'),
      sample.dependencies
    )
    assert.equal(result.kind, 'file')
    if (result.kind !== 'file') assert.fail('expected selected text')
    assert.doesNotMatch(result.content, /�/)
    assert.equal(result.content, localOmpSelectorOutput(content, '32768-32768'))
  } finally {
    sample.cleanup()
  }
})
