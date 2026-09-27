import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { downloadWrapperResultToPath } from '../src/main/agent/wrappers/remote-result-download'
import type { WrapperResultDownloadProgress } from '../src/shared/wrapperResultTypes'
import { wrapperResultFixture, wrapperResultRequest } from './helpers/wrapperResultFixture'

function request(path: string): ReturnType<typeof wrapperResultRequest> & { requestId: string } {
  return { ...wrapperResultRequest('output', path), requestId: 'download_001' }
}

function stagedFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.includes('.phi-download-'))
}

test('explicit single-file download stages, verifies, renames and leaves the remote file untouched', async () => {
  const f = wrapperResultFixture()
  try {
    const original = readFileSync(join(f.outputRoot, 'report.html'))
    const destination = join(f.outside, 'saved-report.html')
    const progress: WrapperResultDownloadProgress[] = []
    const result = await downloadWrapperResultToPath(request('report.html'), destination, {
      ...f.dependencies,
      onProgress: (next) => progress.push(next)
    })
    assert.equal(result.status, 'saved')
    assert.equal(result.path, destination)
    assert.equal(result.bytes, original.length)
    assert.equal(result.sha256, `sha256:${createHash('sha256').update(original).digest('hex')}`)
    assert.equal(result.remoteDigestVerified, true)
    assert.deepEqual(readFileSync(destination), original)
    assert.deepEqual(readFileSync(join(f.outputRoot, 'report.html')), original)
    assert.deepEqual(stagedFiles(f.outside), [])
    assert.equal(progress[0]?.phase, 'downloading')
    assert.equal(progress.at(-1)?.phase, 'saving')
    assert.equal(progress.at(-1)?.bytesDownloaded, original.length)
  } finally {
    f.cleanup()
  }
})

test('zero-byte and multi-page downloads preserve exact bytes and monotonic progress', async () => {
  const f = wrapperResultFixture()
  try {
    writeFileSync(join(f.outputRoot, 'empty.bin'), '')
    const emptyTarget = join(f.outside, 'empty.bin')
    const empty = await downloadWrapperResultToPath(
      request('empty.bin'),
      emptyTarget,
      f.dependencies
    )
    assert.equal(empty.bytes, 0)
    assert.deepEqual(readFileSync(emptyTarget), Buffer.alloc(0))

    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x31)
    bytes[195_000] = 0
    writeFileSync(join(f.outputRoot, 'large.bin'), bytes)
    const progress: number[] = []
    const target = join(f.outside, 'large.bin')
    const saved = await downloadWrapperResultToPath(request('large.bin'), target, {
      ...f.dependencies,
      onProgress: (next) => {
        if (next.phase === 'downloading') progress.push(next.bytesDownloaded)
      }
    })
    assert.equal(saved.bytes, bytes.length)
    assert.deepEqual(readFileSync(target), bytes)
    assert.ok(progress.length > 5)
    assert.deepEqual(
      progress,
      [...progress].sort((a, b) => a - b)
    )
    assert.equal(progress.at(-1), bytes.length)
    assert.deepEqual(stagedFiles(f.outside), [])
  } finally {
    f.cleanup()
  }
})

test('a server without Digest::SHA still saves a locally hashed file', async () => {
  const f = wrapperResultFixture()
  try {
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      return {
        ...session,
        execBounded: async (command, options) =>
          command.includes('PHI_SHA256_V1')
            ? {
                stdout: 'UNAVAILABLE\n',
                stderr: '',
                code: 0,
                signal: null,
                stdoutTruncated: false,
                stderrTruncated: false
              }
            : execBounded(command, options)
      }
    }
    const destination = join(f.outside, 'no-remote-digest.html')
    const saved = await downloadWrapperResultToPath(
      request('report.html'),
      destination,
      f.dependencies
    )
    assert.equal(saved.remoteDigestVerified, false)
    assert.match(saved.sha256, /^sha256:[a-f0-9]{64}$/)
    assert.equal(readFileSync(destination, 'utf8'), '<html>ok</html>')
  } finally {
    f.cleanup()
  }
})

test('a late SSH close error does not turn a published verified file into a failed download', async () => {
  const f = wrapperResultFixture()
  try {
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      return {
        ...session,
        close: async () => {
          throw new Error('SSH master already closed')
        }
      }
    }
    const destination = join(f.outside, 'closed-after-save.html')
    const saved = await downloadWrapperResultToPath(
      request('report.html'),
      destination,
      f.dependencies
    )
    assert.equal(saved.status, 'saved')
    assert.equal(readFileSync(destination, 'utf8'), '<html>ok</html>')
  } finally {
    f.cleanup()
  }
})

test('a same-name target is replaced only after verification; special targets are refused', async () => {
  const f = wrapperResultFixture()
  try {
    const destination = join(f.outside, 'report.html')
    writeFileSync(destination, 'old saved content')
    const result = await downloadWrapperResultToPath(
      request('report.html'),
      destination,
      f.dependencies
    )
    assert.equal(result.status, 'saved')
    assert.equal(readFileSync(destination, 'utf8'), '<html>ok</html>')
    assert.deepEqual(stagedFiles(f.outside), [])

    const link = join(f.outside, 'link.html')
    symlinkSync(destination, link)
    await assert.rejects(
      downloadWrapperResultToPath(request('report.html'), link, f.dependencies),
      /不是普通文件/
    )
    assert.equal(readFileSync(destination, 'utf8'), '<html>ok</html>')
    assert.deepEqual(stagedFiles(f.outside), [])
  } finally {
    f.cleanup()
  }
})

test('cancelled and disconnected transfers clean the temp file without replacing a target', async () => {
  const f = wrapperResultFixture()
  try {
    const bytes = Buffer.alloc(400_000, 0x42)
    writeFileSync(join(f.outputRoot, 'data.bin'), bytes)
    const cancelTarget = join(f.outside, 'cancelled.bin')
    const controller = new AbortController()
    await assert.rejects(
      downloadWrapperResultToPath(request('data.bin'), cancelTarget, {
        ...f.dependencies,
        signal: controller.signal,
        onProgress: (next) => {
          if (next.phase === 'downloading' && next.bytesDownloaded > 0) controller.abort()
        }
      })
    )
    assert.equal(existsSync(cancelTarget), false)
    assert.deepEqual(stagedFiles(f.outside), [])

    const destination = join(f.outside, 'preserved.bin')
    writeFileSync(destination, 'previous download')
    const connect = f.dependencies.connectImpl!
    let pages = 0
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      return {
        ...session,
        execBounded: async (command, options) => {
          if (command.includes('PHI_LOG_V1') && ++pages === 3) throw new Error('SSH disconnected')
          return execBounded(command, options)
        }
      }
    }
    await assert.rejects(
      downloadWrapperResultToPath(request('data.bin'), destination, f.dependencies),
      /SSH disconnected/
    )
    assert.equal(readFileSync(destination, 'utf8'), 'previous download')
    assert.deepEqual(stagedFiles(f.outside), [])
  } finally {
    f.cleanup()
  }
})

test('remote replacement or local target changes during download refuse publication', async () => {
  const f = wrapperResultFixture()
  try {
    const remotePath = join(f.outputRoot, 'changing.bin')
    const bytes = Buffer.alloc(400_000, 0x51)
    writeFileSync(remotePath, bytes)
    const destination = join(f.outside, 'verified.bin')
    let changed = false
    await assert.rejects(
      downloadWrapperResultToPath(request('changing.bin'), destination, {
        ...f.dependencies,
        onProgress: (next) => {
          if (!changed && next.phase === 'downloading' && next.bytesDownloaded > 0) {
            changed = true
            writeFileSync(remotePath, Buffer.alloc(bytes.length, 0x52))
          }
        }
      }),
      /摘要不一致|发生变化/
    )
    assert.equal(existsSync(destination), false)
    assert.deepEqual(stagedFiles(f.outside), [])

    writeFileSync(remotePath, bytes)
    writeFileSync(destination, 'original')
    let replaced = false
    await assert.rejects(
      downloadWrapperResultToPath(request('changing.bin'), destination, {
        ...f.dependencies,
        onProgress: (next) => {
          if (!replaced && next.phase === 'downloading' && next.bytesDownloaded > 0) {
            replaced = true
            writeFileSync(destination, 'someone else changed this file')
          }
        }
      }),
      /目标文件在下载期间发生变化/
    )
    assert.equal(readFileSync(destination, 'utf8'), 'someone else changed this file')
    assert.deepEqual(stagedFiles(f.outside), [])
  } finally {
    f.cleanup()
  }
})

test('directories and renderer-supplied local destinations cannot enter the downloader', async () => {
  const f = wrapperResultFixture()
  try {
    const destination = join(f.outside, 'should-not-exist')
    await assert.rejects(downloadWrapperResultToPath(request(''), destination, f.dependencies))
    await assert.rejects(
      downloadWrapperResultToPath(
        { ...request('report.html'), destination: '/tmp/attacker' },
        destination,
        f.dependencies
      ),
      /只能指定已保存的运行/
    )
    assert.equal(existsSync(destination), false)
    assert.deepEqual(stagedFiles(f.outside), [])
  } finally {
    f.cleanup()
  }
})

test('two downloads cannot publish to the same selected local target concurrently', async () => {
  const f = wrapperResultFixture()
  try {
    const destination = join(f.outside, 'shared.bin')
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
            return new Promise((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true
              })
            })
          }
          return execBounded(command, options)
        }
      }
    }
    const controller = new AbortController()
    const first = downloadWrapperResultToPath(request('report.html'), destination, {
      ...f.dependencies,
      signal: controller.signal
    })
    await waiting
    await assert.rejects(
      downloadWrapperResultToPath(
        { ...request('report.html'), requestId: 'download_002' },
        destination,
        f.dependencies
      ),
      /正在下载中/
    )
    controller.abort()
    await assert.rejects(first)
    assert.equal(existsSync(destination), false)
    assert.deepEqual(stagedFiles(f.outside), [])
  } finally {
    f.cleanup()
  }
})
