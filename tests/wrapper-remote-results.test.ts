import assert from 'node:assert/strict'
import { renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { wrapperResultFixture, wrapperResultRequest } from './helpers/wrapperResultFixture'

import { listWrapperResultDirectory } from '../src/main/agent/wrappers/remote-results'
import { resolveRemoteOutputRoot } from '../src/main/agent/wrappers/remote-result-paths'
import {
  previewWrapperResult,
  readWrapperResultRange,
  WRAPPER_RESULT_RANGE_MAX_BYTES
} from '../src/main/agent/wrappers/remote-result-read'

const fixture = wrapperResultFixture
const request = wrapperResultRequest

function readRequest(path: string): {
  projectId: string
  hostProfileId: string
  runId: string
  scope: 'output'
  path: string
  requestId: string
} {
  return { ...request('output', path), scope: 'output', requestId: 'result_read_001' }
}

test('output scope rejects parent traversal and sibling prefixes', () => {
  const workspace = '/cluster/work'
  const run = `${workspace}/wrappers/runs/wrun_a`
  assert.equal(resolveRemoteOutputRoot(run, workspace, 'reports', false).path, `${run}/reports`)
  assert.throws(() => resolveRemoteOutputRoot(run, workspace, '../wrun_b', false), /父目录/)
  assert.throws(() => resolveRemoteOutputRoot(run, workspace, '/', true), /服务器根目录/)
  assert.throws(
    () => resolveRemoteOutputRoot(run, workspace, '/cluster/work-other/reports', false),
    /项目根目录外/
  )
  assert.equal(
    resolveRemoteOutputRoot(run, workspace, '/cluster/work-other/reports', true).external,
    true
  )
})

test('running and completed runs list only their saved run and output roots', async () => {
  const f = fixture()
  try {
    const running = await listWrapperResultDirectory(request('run'), f.dependencies)
    assert.equal(running.rootPath, `ssh://cluster-a${f.runRoot}`)
    assert.ok(running.entries.some((entry) => entry.name === 'results'))
    f.run.state = 'completed'
    const complete = await listWrapperResultDirectory(request('output'), f.dependencies)
    assert.equal(complete.rootPath, `ssh://cluster-a${f.outputRoot}`)
    assert.deepEqual(
      complete.entries.map((entry) => entry.name),
      ['report.html']
    )
    assert.equal(f.connections(), 2)
    assert.equal(f.closed(), 2)
  } finally {
    f.cleanup()
  }
})

test('wrong run, project, host and arbitrary absolute paths are rejected before SSH', async () => {
  const f = fixture()
  try {
    for (const bad of [
      { ...request('run'), runId: 'wrun_b' },
      { ...request('run'), runId: '../wrun_a' },
      { ...request('run'), projectId: 'project-b' },
      { ...request('run'), hostProfileId: 'host-b' },
      { ...request('run'), path: '../wrun_b' },
      { ...request('run'), path: '/etc' },
      { ...request('run'), path: 'ssh://cluster-b/etc' },
      { ...request('run'), connection: { host: 'cluster-b' } }
    ]) {
      await assert.rejects(listWrapperResultDirectory(bad, f.dependencies))
    }
    f.run.remote!.host = 'cluster-b'
    await assert.rejects(listWrapperResultDirectory(request('run'), f.dependencies), /服务器不匹配/)
    assert.equal(f.connections(), 0)
  } finally {
    f.cleanup()
  }
})

test('a symlink cannot move a child or the saved output root outside its scope', async () => {
  const f = fixture()
  try {
    symlinkSync(f.outside, join(f.outputRoot, 'escape'))
    await assert.rejects(
      listWrapperResultDirectory(request('output', 'escape'), f.dependencies),
      /超出授权范围/
    )
    renameSync(f.outputRoot, `${f.outputRoot}-old`)
    symlinkSync(f.outside, f.outputRoot)
    await assert.rejects(
      listWrapperResultDirectory(request('output'), f.dependencies),
      /符号链接变化/
    )
    assert.equal(f.connections(), f.closed())
  } finally {
    f.cleanup()
  }
})

test('external output is available only when its exact root was saved as authorized', async () => {
  const f = fixture()
  try {
    f.run.outDir = f.outside
    f.run.remote!.outputRoot = f.outside
    f.run.remote!.externalOutputAuthorized = true
    const listed = await listWrapperResultDirectory(request('output'), f.dependencies)
    assert.deepEqual(
      listed.entries.map((entry) => entry.name),
      ['private.txt']
    )
    f.run.remote!.externalOutputAuthorized = false
    await assert.rejects(
      listWrapperResultDirectory(request('output'), f.dependencies),
      /授权范围不一致/
    )
    f.run.outDir = '/'
    f.run.remote!.outputRoot = '/'
    f.run.remote!.externalOutputAuthorized = true
    await assert.rejects(
      listWrapperResultDirectory(request('output'), f.dependencies),
      /服务器根目录/
    )
  } finally {
    f.cleanup()
  }
})

test('a local project can list its bound remote wrapper results without a project SSH session', async () => {
  const f = fixture()
  try {
    f.project.location = { kind: 'local', path: f.workspace, realPath: f.workspace }
    const listed = await listWrapperResultDirectory(request('output'), f.dependencies)
    assert.equal(listed.entries[0]?.name, 'report.html')
  } finally {
    f.cleanup()
  }
})

test('remote directory permission errors remain visible and close the SSH session', async () => {
  const f = fixture()
  try {
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const exec = session.exec.bind(session)
      return {
        ...session,
        exec: async (command) =>
          command.includes('opendir(my $dir')
            ? { stdout: '', stderr: 'permission denied', code: 74, signal: null }
            : exec(command)
      }
    }
    await assert.rejects(
      listWrapperResultDirectory(request('output'), f.dependencies),
      /无读取权限/
    )
    assert.equal(f.closed(), 1)
  } finally {
    f.cleanup()
  }
})

test('result preview reads bounded UTF-8 text and zero-byte files', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.outputRoot, 'notes.txt'), 'α\nbeta')
    writeFileSync(join(f.outputRoot, 'empty.txt'), '')
    const text = await previewWrapperResult(readRequest('notes.txt'), f.dependencies)
    assert.equal(text.kind, 'text')
    if (text.kind === 'text') assert.equal(text.content, 'α\nbeta')
    assert.equal(text.bytes, 7)
    assert.equal(text.path, `ssh://cluster-a${f.outputRoot}/notes.txt`)
    const empty = await previewWrapperResult(readRequest('empty.txt'), f.dependencies)
    assert.equal(empty.kind, 'text')
    assert.equal(empty.bytes, 0)
    if (empty.kind === 'text') assert.equal(empty.content, '')
  } finally {
    f.cleanup()
  }
})

test('result preview returns byte-exact image and PDF data URLs', async () => {
  const f = fixture()
  try {
    const files = [
      {
        name: 'plot.png',
        mime: 'image/png',
        bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])
      },
      {
        name: 'plot-paged.png',
        mime: 'image/png',
        bytes: Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.alloc(400_000, 0x7f)
        ])
      },
      { name: 'plot.jpg', mime: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 3, 4]) },
      { name: 'report.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nreport') }
    ]
    for (const file of files) {
      writeFileSync(join(f.outputRoot, file.name), file.bytes)
      const preview = await previewWrapperResult(readRequest(file.name), f.dependencies)
      assert.equal(preview.mimeType, file.mime)
      assert.equal(preview.bytes, file.bytes.length)
      assert.equal(preview.truncated, false)
      assert.ok(preview.kind === 'image' || preview.kind === 'pdf')
      if (preview.kind === 'image' || preview.kind === 'pdf') {
        assert.deepEqual(Buffer.from(preview.dataUrl.split(',')[1], 'base64'), file.bytes)
      }
    }
  } finally {
    f.cleanup()
  }
})

test('byte ranges are exact, bounded, and allow an empty read at EOF', async () => {
  const f = fixture()
  try {
    const bytes = Buffer.alloc(WRAPPER_RESULT_RANGE_MAX_BYTES + 17, 0x5a)
    bytes[7] = 0
    writeFileSync(join(f.outputRoot, 'data.bin'), bytes)
    const page = await readWrapperResultRange(
      { ...readRequest('data.bin'), offset: 5, length: 4 },
      f.dependencies
    )
    assert.equal(page.offset, 5)
    assert.equal(page.fileSize, bytes.length)
    assert.equal(page.bytes, 4)
    assert.deepEqual(Buffer.from(page.dataBase64, 'base64'), bytes.subarray(5, 9))
    const eof = await readWrapperResultRange(
      { ...readRequest('data.bin'), offset: bytes.length, length: 10 },
      f.dependencies
    )
    assert.equal(eof.bytes, 0)
    const max = await readWrapperResultRange(
      { ...readRequest('data.bin'), offset: 0, length: WRAPPER_RESULT_RANGE_MAX_BYTES },
      f.dependencies
    )
    assert.equal(max.bytes, WRAPPER_RESULT_RANGE_MAX_BYTES)
    assert.ok(max.dataBase64.length < 256 * 1024)
    await assert.rejects(
      readWrapperResultRange(
        { ...readRequest('data.bin'), offset: bytes.length + 1, length: 1 },
        f.dependencies
      ),
      /字节范围/
    )
    const before = f.connections()
    await assert.rejects(
      readWrapperResultRange(
        { ...readRequest('data.bin'), offset: 0, length: WRAPPER_RESULT_RANGE_MAX_BYTES + 1 },
        f.dependencies
      ),
      /单页上限/
    )
    assert.equal(f.connections(), before)
    await assert.rejects(
      readWrapperResultRange({ ...readRequest('data.bin'), offset: -1, length: 1 }, f.dependencies),
      /字节范围无效/
    )
    assert.equal(f.connections(), before)
  } finally {
    f.cleanup()
  }
})

test('large files return only metadata, while unsupported small binary stays metadata', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.outputRoot, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61))
    writeFileSync(
      join(f.outputRoot, 'large.png'),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.alloc(10 * 1024 * 1024 + 1 - 8, 0)
      ])
    )
    writeFileSync(join(f.outputRoot, 'small.bin'), Buffer.from([0, 1, 2]))
    for (const name of ['large.txt', 'large.png']) {
      const preview = await previewWrapperResult(readRequest(name), f.dependencies)
      assert.equal(preview.kind, 'metadata')
      assert.equal(preview.truncated, true)
      assert.equal(preview.previewBytes, 0)
      assert.equal('dataUrl' in preview, false)
      assert.equal('content' in preview, false)
    }
    const binary = await previewWrapperResult(readRequest('small.bin'), f.dependencies)
    assert.equal(binary.kind, 'metadata')
    if (binary.kind === 'metadata') assert.equal(binary.reason, 'binary')
    assert.equal(binary.truncated, false)
  } finally {
    f.cleanup()
  }
})

test('cancelled result reads stop before connecting and while a byte range is in flight', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.outputRoot, 'data.bin'), Buffer.from([1, 2, 3]))
    const before = new AbortController()
    before.abort()
    await assert.rejects(
      readWrapperResultRange(
        { ...readRequest('data.bin'), offset: 0, length: 3 },
        { ...f.dependencies, signal: before.signal }
      )
    )
    assert.equal(f.connections(), 0)

    let entered!: () => void
    const waiting = new Promise<void>((resolve) => (entered = resolve))
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      return {
        ...session,
        execBounded: async (command, options) => {
          if (command.includes('PHI_LOG_V1')) {
            entered()
            return new Promise((_, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('read aborted')), {
                once: true
              })
            })
          }
          return execBounded(command, options)
        }
      }
    }
    const active = new AbortController()
    const pending = readWrapperResultRange(
      { ...readRequest('data.bin'), offset: 0, length: 3 },
      { ...f.dependencies, signal: active.signal }
    )
    await waiting
    active.abort()
    await assert.rejects(pending, /aborted/)
    assert.equal(f.closed(), 1)
  } finally {
    f.cleanup()
  }
})

test('disconnect and a last-moment symlink replacement never return bytes', async () => {
  const f = fixture()
  try {
    const victim = join(f.outputRoot, 'victim.bin')
    writeFileSync(victim, Buffer.from([1, 2, 3]))
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      return {
        ...session,
        execBounded: async (command, options) => {
          if (command.includes('PHI_LOG_V1')) throw new Error('SSH disconnected')
          return execBounded(command, options)
        }
      }
    }
    await assert.rejects(
      readWrapperResultRange(
        { ...readRequest('victim.bin'), offset: 0, length: 3 },
        f.dependencies
      ),
      /SSH disconnected/
    )
    assert.equal(f.closed(), 1)

    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      return {
        ...session,
        execBounded: async (command, options) => {
          if (command.includes('PHI_LOG_V1')) {
            renameSync(victim, `${victim}-old`)
            symlinkSync(join(f.outside, 'private.txt'), victim)
          }
          return execBounded(command, options)
        }
      }
    }
    await assert.rejects(
      readWrapperResultRange(
        { ...readRequest('victim.bin'), offset: 0, length: 3 },
        f.dependencies
      ),
      /读取失败/
    )
    assert.equal(f.closed(), 2)
  } finally {
    f.cleanup()
  }
})

test('multi-page media preview refuses a file replaced between pages', async () => {
  const f = fixture()
  try {
    const media = join(f.outputRoot, 'changing.png')
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(300_000, 0x11)
    ])
    writeFileSync(media, bytes)
    const connect = f.dependencies.connectImpl!
    let pages = 0
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      return {
        ...session,
        execBounded: async (command, options) => {
          if (command.includes('PHI_LOG_V1')) {
            pages += 1
            if (pages === 2) {
              renameSync(media, `${media}-old`)
              writeFileSync(media, bytes)
            }
          }
          return execBounded(command, options)
        }
      }
    }
    await assert.rejects(previewWrapperResult(readRequest('changing.png'), f.dependencies), /变化/)
    assert.ok(pages >= 2)
  } finally {
    f.cleanup()
  }
})
