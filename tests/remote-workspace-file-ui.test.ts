import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  listRemoteWorkspaceDirectory,
  previewRemoteWorkspaceFile
} from '../src/main/agent/remote-workspace-file-ui'
import type { RemoteWorkspaceBoundaryDependencies } from '../src/main/agent/remote-workspace-boundary'
import type { FilePreview } from '../src/renderer/src/types'
import { createLocalShellSession } from './helpers/localShellSession'

function fixture(): {
  root: string
  outside: string
  anchor: string
  dependencies: RemoteWorkspaceBoundaryDependencies
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-file-ui-'))
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  const agentDir = join(base, 'phi')
  mkdirSync(root)
  mkdirSync(outside)
  const canonicalRoot = realpathSync(root)
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot
  }
  const project = {
    id: 'project-a',
    name: 'Remote',
    location,
    workingDirectory: root,
    workingDirectoryRealPath: canonicalRoot,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00Z'
  } as Project
  const anchor = ensureRemoteProjectAnchor(project.id, agentDir)
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: anchor
  } as PhiSessionManifest
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster A', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async () => {
      const session = createLocalShellSession(root)
      session.readTextFile = async () => {
        throw new Error('unbounded read not allowed')
      }
      session.writeTextFile = async () => {
        throw new Error('write not allowed')
      }
      session.mkdirp = async () => {
        throw new Error('not used')
      }
      session.exists = async () => {
        throw new Error('not used')
      }
      session.uploadFile = async () => {
        throw new Error('not used')
      }
      return session
    }
  }
  return {
    root,
    outside,
    anchor,
    dependencies,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function request(path: string): { sessionId: string; projectId: string; path: string } {
  return { sessionId: 'session-a', projectId: 'project-a', path }
}

test('remote file sidebar maps T02 directory entries into SSH URIs and bounded text preview', async () => {
  const f = fixture()
  try {
    const nested = join(f.root, 'sub')
    mkdirSync(nested)
    writeFileSync(join(nested, "line\n'quote'.txt"), 'α\nβ')
    const root = await listRemoteWorkspaceDirectory(request('.'), f.dependencies)
    assert.equal(root.rootPath, `ssh://cluster-a${realpathSync(f.root)}`)
    assert.equal(root.rootLabel, 'cluster-a')
    assert.equal(root.entries[0]?.kind, 'directory')
    const child = await listRemoteWorkspaceDirectory(request('sub'), f.dependencies)
    assert.equal(child.entries.length, 1)
    assert.match(child.entries[0].path, /line%0A'quote'\.txt/)
    const preview = await previewRemoteWorkspaceFile(
      request("sub/line\n'quote'.txt"),
      f.dependencies
    )
    assert.equal(preview.kind, 'text')
    assert.equal(preview.content, 'α\nβ')
    assert.equal(preview.bytes, 5)
    assert.equal(preview.truncated, false)
    assert.equal(readFileSync(join(nested, "line\n'quote'.txt"), 'utf8'), 'α\nβ')
    assert.equal(preview.path.startsWith('ssh://cluster-a/'), true)
  } finally {
    f.cleanup()
  }
})

test('remote UI read rejects wrong project, raw SSH URL and escape link without weakening type checks', async () => {
  const f = fixture()
  try {
    symlinkSync(f.outside, join(f.root, 'escape'))
    writeFileSync(join(f.root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await assert.rejects(
      previewRemoteWorkspaceFile({ ...request('binary.dat'), projectId: 'other' }, f.dependencies),
      /会话与项目不匹配/
    )
    await assert.rejects(
      previewRemoteWorkspaceFile(request('ssh://cluster-a/project/file'), f.dependencies),
      /不能传入 ssh:\/\//
    )
    await assert.rejects(
      listRemoteWorkspaceDirectory(request('escape'), f.dependencies),
      /超出项目根目录/
    )
    await assert.rejects(
      listRemoteWorkspaceDirectory(request('binary.dat'), f.dependencies),
      /不是目录/
    )
  } finally {
    f.cleanup()
  }
})

test('remote UI missing errors name the requested relative file or directory', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      previewRemoteWorkspaceFile(request('wrappers/runs/wrun_a/params.json'), f.dependencies),
      /^Error: 远程文件不存在：wrappers\/runs\/wrun_a\/params\.json$/
    )
    await assert.rejects(
      listRemoteWorkspaceDirectory(request('wrappers/runs/wrun_a/missing'), f.dependencies),
      /^Error: 远程目录不存在：wrappers\/runs\/wrun_a\/missing$/
    )
  } finally {
    f.cleanup()
  }
})

test('remote UI missing errors keep the relative path when a target disappears after authorization', async () => {
  for (const { expectedKind, relativePath } of [
    { expectedKind: 'file', relativePath: 'wrappers/runs/wrun_race/params.json' },
    { expectedKind: 'directory', relativePath: 'wrappers/runs/wrun_race' },
    { expectedKind: 'directory', relativePath: '.' }
  ] as const) {
    const f = fixture()
    try {
      const target = join(f.root, relativePath)
      if (expectedKind === 'file') {
        mkdirSync(join(f.root, 'wrappers', 'runs', 'wrun_race'), { recursive: true })
        writeFileSync(target, '{}')
      } else {
        mkdirSync(target, { recursive: true })
      }
      const connect = f.dependencies.connectImpl
      assert.ok(connect)
      f.dependencies.connectImpl = async (config) => {
        const session = await connect(config)
        let commandCount = 0
        return {
          ...session,
          exec: async (command) => {
            const result = await session.exec(command)
            commandCount += 1
            if (commandCount === 1) rmSync(target, { recursive: true, force: true })
            return result
          }
        }
      }

      const operation =
        expectedKind === 'file'
          ? previewRemoteWorkspaceFile(request(relativePath), f.dependencies)
          : listRemoteWorkspaceDirectory(request(relativePath), f.dependencies)
      await assert.rejects(
        operation,
        new RegExp(
          `^Error: 远程${expectedKind === 'file' ? '文件' : '目录'}不存在：${relativePath.replaceAll('.', '\\.')}$`
        )
      )
    } finally {
      f.cleanup()
    }
  }
})

const TEXT_PREVIEW_BYTES = 320_000
const MEDIA_PREVIEW_BYTES = 10 * 1024 * 1024
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function preview(f: ReturnType<typeof fixture>, path: string): Promise<FilePreview> {
  return previewRemoteWorkspaceFile(request(path), f.dependencies) as Promise<FilePreview>
}

test('remote UI preview returns a PNG data URL without using an unbounded text read', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'pixel.png'), PNG_BYTES)
    const result = await preview(f, 'pixel.png')
    assert.equal(result.kind, 'image')
    if (result.kind !== 'image') assert.fail('expected image preview')
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.dataUrl, `data:image/png;base64,${PNG_BYTES.toString('base64')}`)
    assert.equal(result.previewBytes, PNG_BYTES.length)
    assert.equal(result.truncated, false)
  } finally {
    f.cleanup()
  }
})

test('remote UI preview returns a small PDF data URL', async () => {
  const f = fixture()
  try {
    const bytes = Buffer.from('%PDF-1.7\n%%EOF\n')
    writeFileSync(join(f.root, 'paper.pdf'), bytes)
    const result = await preview(f, 'paper.pdf')
    assert.equal(result.kind, 'pdf')
    if (result.kind !== 'pdf') assert.fail('expected PDF preview')
    assert.equal(result.mimeType, 'application/pdf')
    assert.equal(result.dataUrl, `data:application/pdf;base64,${bytes.toString('base64')}`)
    assert.equal(result.truncated, false)
  } finally {
    f.cleanup()
  }
})

test('remote UI preview returns large-file metadata for a PDF over 10 MiB', async () => {
  const f = fixture()
  try {
    const bytes = Buffer.alloc(MEDIA_PREVIEW_BYTES + 1, 0x20)
    Buffer.from('%PDF-1.7\n').copy(bytes)
    writeFileSync(join(f.root, 'large.pdf'), bytes)
    const result = await preview(f, 'large.pdf')
    assert.equal(result.kind, 'metadata')
    if (result.kind !== 'metadata') assert.fail('expected metadata preview')
    assert.equal(result.mimeType, 'application/pdf')
    assert.equal(result.reason, 'large_file')
    assert.equal(result.bytes, bytes.length)
    assert.equal(result.truncated, true)
  } finally {
    f.cleanup()
  }
})

test('remote UI preview returns large-file metadata for a PNG over 10 MiB', async () => {
  const f = fixture()
  try {
    const bytes = Buffer.alloc(MEDIA_PREVIEW_BYTES + 1, 0x20)
    PNG_BYTES.subarray(0, 16).copy(bytes)
    writeFileSync(join(f.root, 'large.png'), bytes)
    const result = await preview(f, 'large.png')
    assert.equal(result.kind, 'metadata')
    if (result.kind !== 'metadata') assert.fail('expected metadata preview')
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.reason, 'large_file')
  } finally {
    f.cleanup()
  }
})

test('remote UI preview classifies gzip and BAM as binary metadata', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'reads.fastq.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
    const bamBytes = Buffer.alloc(2 * 1024 * 1024, 0)
    Buffer.from([0x42, 0x41, 0x4d, 0x01]).copy(bamBytes)
    writeFileSync(join(f.root, 'alignments.bam'), bamBytes)
    const gzip = await preview(f, 'reads.fastq.gz')
    const bam = await preview(f, 'alignments.bam')
    assert.equal(gzip.kind, 'metadata')
    assert.equal(bam.kind, 'metadata')
    if (gzip.kind !== 'metadata' || bam.kind !== 'metadata') {
      assert.fail('expected binary metadata previews')
    }
    assert.equal(gzip.reason, 'binary')
    assert.equal(bam.reason, 'binary')
    assert.equal(bam.bytes, bamBytes.length)
    assert.match(gzip.mimeType, /gzip|gz/i)
    assert.match(bam.mimeType, /bam/i)
  } finally {
    f.cleanup()
  }
})

test('remote UI preview truncates large UTF-8 text at 320000 bytes instead of rejecting it', async () => {
  const f = fixture()
  try {
    const content = `${'a'.repeat(TEXT_PREVIEW_BYTES)}tail`
    writeFileSync(join(f.root, 'large.txt'), content)
    const result = await preview(f, 'large.txt')
    assert.equal(result.kind, 'text')
    if (result.kind !== 'text') assert.fail('expected text preview')
    assert.equal(Buffer.byteLength(result.content), TEXT_PREVIEW_BYTES)
    assert.equal(result.content, 'a'.repeat(TEXT_PREVIEW_BYTES))
    assert.equal(result.bytes, Buffer.byteLength(content))
    assert.equal(result.previewBytes, TEXT_PREVIEW_BYTES)
    assert.equal(result.truncated, true)
  } finally {
    f.cleanup()
  }
})

test('remote UI preview reads complete HTML up to 10 MiB and keeps CSV and TSV as text', async () => {
  const f = fixture()
  try {
    const html = `<html><body>${'x'.repeat(TEXT_PREVIEW_BYTES)}</body></html>`
    writeFileSync(join(f.root, 'report.html'), html)
    writeFileSync(join(f.root, 'table.csv'), 'a,b\n1,2\n')
    writeFileSync(join(f.root, 'table.tsv'), 'a\tb\n1\t2\n')
    const htmlPreview = await preview(f, 'report.html')
    const csvPreview = await preview(f, 'table.csv')
    const tsvPreview = await preview(f, 'table.tsv')
    assert.equal(htmlPreview.kind, 'html')
    if (htmlPreview.kind !== 'html') assert.fail('expected HTML preview')
    assert.equal(htmlPreview.content, html)
    assert.equal(htmlPreview.truncated, false)
    assert.equal(csvPreview.kind, 'text')
    assert.equal(csvPreview.mimeType, 'text/plain')
    assert.equal(tsvPreview.kind, 'text')
    assert.equal(tsvPreview.mimeType, 'text/plain')
  } finally {
    f.cleanup()
  }
})

test('remote UI preview rejects undeclared fields before opening a host session', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'note.txt'), 'safe')
    await assert.rejects(
      previewRemoteWorkspaceFile({ ...request('note.txt'), host: 'attacker' }, f.dependencies),
      /只能包含会话、项目 ID 和路径/
    )
  } finally {
    f.cleanup()
  }
})

test('remote UI text preview matches local byte truncation when UTF-8 crosses the 320000-byte boundary', async () => {
  const f = fixture()
  try {
    const content = `${'a'.repeat(TEXT_PREVIEW_BYTES - 1)}你tail`
    const expected = Buffer.from(content).subarray(0, TEXT_PREVIEW_BYTES).toString('utf8')
    writeFileSync(join(f.root, 'utf8-boundary.txt'), content)
    const result = await preview(f, 'utf8-boundary.txt')
    assert.equal(result.kind, 'text')
    if (result.kind !== 'text') assert.fail('expected text preview')
    assert.equal(result.content, expected)
    assert.equal(result.previewBytes, TEXT_PREVIEW_BYTES)
    assert.equal(result.truncated, true)
  } finally {
    f.cleanup()
  }
})

test('remote UI preview detects binary content after the 512-byte classification head', async () => {
  const f = fixture()
  try {
    const bytes = Buffer.alloc(2048, 0x61)
    bytes[600] = 0
    writeFileSync(join(f.root, 'late-binary.dat'), bytes)
    const result = await preview(f, 'late-binary.dat')
    assert.equal(result.kind, 'metadata')
    if (result.kind !== 'metadata') assert.fail('expected binary metadata')
    assert.equal(result.reason, 'binary')
    assert.equal(result.mimeType, 'application/octet-stream')
  } finally {
    f.cleanup()
  }
})

test('remote UI preview falls back to a truncated text preview for HTML over 10 MiB', async () => {
  const f = fixture()
  try {
    const prefix = Buffer.from('<html><body>')
    const bytes = Buffer.alloc(MEDIA_PREVIEW_BYTES + 1, 0x61)
    prefix.copy(bytes)
    writeFileSync(join(f.root, 'large.html'), bytes)
    const result = await preview(f, 'large.html')
    assert.equal(result.kind, 'text')
    if (result.kind !== 'text') assert.fail('expected text preview')
    assert.equal(result.previewBytes, TEXT_PREVIEW_BYTES)
    assert.equal(Buffer.byteLength(result.content), TEXT_PREVIEW_BYTES)
    assert.equal(result.truncated, true)
  } finally {
    f.cleanup()
  }
})
