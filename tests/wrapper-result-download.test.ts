import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { FileTransferCoordinator, FileTransferRegistry } from '../src/main/agent/transfer'
import { downloadWrapperResultToPath } from '../src/main/agent/wrappers/remote-result-download'
import type { WrapperResultDownloadProgress } from '../src/shared/wrapperResultTypes'
import { createLocalShellSession } from './helpers/localShellSession'
import { wrapperResultFixture, wrapperResultRequest } from './helpers/wrapperResultFixture'

function request(path: string): ReturnType<typeof wrapperResultRequest> & { requestId: string } {
  return { ...wrapperResultRequest('output', path), requestId: 'download_001' }
}

function stagedFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.includes('.phi-download-'))
}

test('wrapper result download uses the resumable SSH stream data plane', async () => {
  const f = wrapperResultFixture()
  const session = createLocalShellSession(f.workspace)
  try {
    const content = Buffer.alloc(2 * 1024 * 1024 + 19, 0x5c)
    writeFileSync(join(f.outputRoot, 'streamed.bin'), content)
    f.dependencies.connectImpl = async () => session
    const destination = join(f.outside, 'streamed.bin')

    const result = await downloadWrapperResultToPath(
      request('streamed.bin'),
      destination,
      f.dependencies
    )

    assert.deepEqual(readFileSync(destination), content)
    assert.equal(result.sha256, `sha256:${createHash('sha256').update(content).digest('hex')}`)
    assert.equal(result.remoteDigestVerified, true)
    assert.ok(session.commands.some((command) => command.includes('PHI_ID=')))
    assert.equal(
      session.commands.some((command) => command.includes('PHI_LOG_V1')),
      false
    )
  } finally {
    await session.close()
    f.cleanup()
  }
})

test('ancestor symlink swap after authorization is rejected before streaming bytes', async () => {
  const f = wrapperResultFixture()
  try {
    const attackerRoot = join(f.outside, 'attacker-results')
    mkdirSync(attackerRoot)
    writeFileSync(join(attackerRoot, 'report.html'), 'attacker bytes')
    const originalRoot = `${f.outputRoot}.original`
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const execBounded = session.execBounded!.bind(session)
      let swapped = false
      return {
        ...session,
        execBounded: async (command, options) => {
          if (!swapped && command.includes('PHI_ID=')) {
            swapped = true
            renameSync(f.outputRoot, originalRoot)
            symlinkSync(attackerRoot, f.outputRoot)
          }
          return execBounded(command, options)
        }
      }
    }
    const destination = join(f.outside, 'must-not-leak.html')

    await assert.rejects(
      downloadWrapperResultToPath(request('report.html'), destination, f.dependencies),
      /preflight|传输|路径/i
    )
    assert.equal(existsSync(destination), false)
    assert.equal(
      readdirSync(f.outside).some((name) => name.includes('.phi-transfer-')),
      false
    )
  } finally {
    f.cleanup()
  }
})

test('unavailable helper data plane automatically falls back to the SSH stream', async () => {
  const f = wrapperResultFixture()
  const session = createLocalShellSession(f.workspace)
  let helperAttempts = 0
  try {
    f.dependencies.connectImpl = async () => session
    const destination = join(f.outside, 'helper-fallback.html')
    const saved = await downloadWrapperResultToPath(request('report.html'), destination, {
      ...f.dependencies,
      transferHelperConnect: async () => {
        helperAttempts += 1
        throw new Error('helper unavailable')
      }
    })

    assert.equal(helperAttempts, 1)
    assert.equal(saved.remoteDigestVerified, true)
    assert.equal(readFileSync(destination, 'utf8'), '<html>ok</html>')
    assert.ok(session.commands.some((command) => command.includes('PHI_BEFORE=')))
  } finally {
    await session.close()
    f.cleanup()
  }
})

test('expected SHA-256 mismatch fails closed and retains the resumable partial', async () => {
  const f = wrapperResultFixture()
  try {
    const destination = join(f.outside, 'wrong-digest.html')
    await assert.rejects(
      downloadWrapperResultToPath(request('report.html'), destination, {
        ...f.dependencies,
        expectedSha256: '0'.repeat(64)
      }),
      /摘要不一致/
    )

    assert.equal(existsSync(destination), false)
    assert.ok(readdirSync(f.outside).some((name) => name.endsWith('.part')))
    assert.ok(readdirSync(f.outside).some((name) => name.endsWith('.part.json')))
  } finally {
    f.cleanup()
  }
})

test('cancelled stream download resumes from its durable checkpoint after manager restart', async () => {
  const f = wrapperResultFixture()
  const sessions: ReturnType<typeof createLocalShellSession>[] = []
  try {
    const content = Buffer.alloc(4 * 1024 * 1024 + 23, 0x36)
    writeFileSync(join(f.outputRoot, 'resume.bin'), content)
    f.dependencies.connectImpl = async () => {
      const session = createLocalShellSession(f.workspace)
      sessions.push(session)
      return session
    }
    const destination = join(f.outside, 'resume.bin')
    const controller = new AbortController()
    const coordinator = new FileTransferCoordinator({
      registry: new FileTransferRegistry(
        join(f.dependencies.agentDir!, 'transfers', 'registry.json')
      ),
      policy: {
        chunkSizeBytes: 512 * 1024,
        checkpointBytes: 512 * 1024,
        progressBytes: 1,
        progressIntervalMs: 0
      }
    })

    await assert.rejects(
      downloadWrapperResultToPath(request('resume.bin'), destination, {
        ...f.dependencies,
        signal: controller.signal,
        transferCoordinator: coordinator,
        onProgress: (progress) => {
          if (progress.phase === 'downloading' && progress.bytesDownloaded >= 512 * 1024) {
            controller.abort()
          }
        }
      }),
      { code: 'ABORTED' }
    )
    assert.equal(existsSync(destination), false)
    const part = readdirSync(f.outside).find((name) => name.endsWith('.part'))
    assert.ok(part)
    const manifestPath = join(f.outside, `${part}.json`)
    const checkpoint = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      durableOffset: number
    }
    assert.ok(checkpoint.durableOffset >= 512 * 1024)

    const progress: WrapperResultDownloadProgress[] = []
    const saved = await downloadWrapperResultToPath(request('resume.bin'), destination, {
      ...f.dependencies,
      transferCoordinator: coordinator,
      onProgress: (event) => progress.push(event)
    })

    assert.equal(saved.bytes, content.byteLength)
    assert.deepEqual(readFileSync(destination), content)
    assert.equal(
      readdirSync(f.outside).some((name) => name.includes('.phi-transfer-')),
      false
    )
    assert.ok(
      sessions[1]?.commands.some(
        (command) =>
          command.includes('tail -c') && command.includes(String(checkpoint.durableOffset + 1))
      )
    )
    assert.ok(progress.some((event) => event.bytesDownloaded >= checkpoint.durableOffset))
  } finally {
    await Promise.all(sessions.map((session) => session.close()))
    f.cleanup()
  }
})

test('stream progress is phase-bounded and contains no host or path details', async () => {
  const f = wrapperResultFixture()
  const session = createLocalShellSession(f.workspace)
  try {
    const content = Buffer.alloc(2 * 1024 * 1024 + 1, 0x71)
    writeFileSync(join(f.outputRoot, 'progress.bin'), content)
    f.dependencies.connectImpl = async () => session
    const progress: WrapperResultDownloadProgress[] = []

    await downloadWrapperResultToPath(request('progress.bin'), join(f.outside, 'progress.bin'), {
      ...f.dependencies,
      onProgress: (event) => progress.push(event)
    })

    assert.deepEqual(
      progress.map((event) => event.phase),
      ['downloading', 'verifying', 'saving']
    )
    assert.deepEqual(Object.keys(progress[0] ?? {}).sort(), [
      'bytesDownloaded',
      'phase',
      'requestId',
      'totalBytes'
    ])
    const serialized = JSON.stringify(progress)
    assert.doesNotMatch(serialized, /cluster-a|host-a/)
    assert.equal(serialized.includes(f.workspace), false)
    assert.equal(serialized.includes(f.outputRoot), false)
    assert.equal(serialized.includes(f.outside), false)
    assert.deepEqual(
      progress.map((event) => event.bytesDownloaded),
      [...progress.map((event) => event.bytesDownloaded)].sort((left, right) => left - right)
    )
  } finally {
    await session.close()
    f.cleanup()
  }
})

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
    assert.ok(progress.length >= 1)
    assert.ok(progress.length <= 3)
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

test('the stream data plane verifies the server SHA-256 with an available remote tool', async () => {
  const f = wrapperResultFixture()
  try {
    const destination = join(f.outside, 'no-remote-digest.html')
    const saved = await downloadWrapperResultToPath(
      request('report.html'),
      destination,
      f.dependencies
    )
    assert.equal(saved.remoteDigestVerified, true)
    assert.ok(f.commands.some((command) => command.includes('PHI_HASH=')))
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

test('cancelled and disconnected transfers retain resumable state without replacing a target', async () => {
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
    assert.ok(readdirSync(f.outside).some((name) => name.endsWith('.part')))

    const destination = join(f.outside, 'preserved.bin')
    writeFileSync(destination, 'previous download')
    const connect = f.dependencies.connectImpl!
    f.dependencies.connectImpl = async (config) => {
      const session = await connect(config)
      const openStdio = session.openStdio!.bind(session)
      return {
        ...session,
        openStdio: async (command) => {
          if (command.includes('PHI_BEFORE=')) throw new Error('SSH disconnected')
          return openStdio(command)
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
    const targetDestination = join(f.outside, 'target-race.bin')
    writeFileSync(targetDestination, 'original')
    let replaced = false
    await assert.rejects(
      downloadWrapperResultToPath(request('changing.bin'), targetDestination, {
        ...f.dependencies,
        onProgress: (next) => {
          if (!replaced && next.phase === 'downloading' && next.bytesDownloaded > 0) {
            replaced = true
            writeFileSync(targetDestination, 'someone else changed this file')
          }
        }
      }),
      /目标文件在下载期间发生变化/
    )
    assert.equal(readFileSync(targetDestination, 'utf8'), 'someone else changed this file')
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
      const openStdio = session.openStdio!.bind(session)
      return {
        ...session,
        openStdio: async (command) => {
          if (command.includes('PHI_BEFORE=')) {
            entered()
            return openStdio('sleep 60')
          }
          return openStdio(command)
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
