import assert from 'node:assert/strict'
import fs, {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  persistPromptImages,
  readPromptImage,
  validatePromptImages
} from '../src/main/agent/session/prompt-images'
import { createPhiSession } from '../src/main/agent/session/session-store'
import { MAX_PROMPT_IMAGE_BYTES } from '../src/shared/promptImageTypes'

const png = {
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='
}

function withImageSession(run: (session: ReturnType<typeof createPhiSession>) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-prompt-images-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      permissionMode: 'auto'
    })
    run(session)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(phiDir, { recursive: true, force: true })
  }
}

test('pasted images are validated, stored outside the event log, and readable after reopening', () => {
  withImageSession((session) => {
    const [ref] = persistPromptImages(session.sessionId, validatePromptImages([png]))
    assert.equal(ref.sessionId, session.sessionId)
    assert.match(ref.id, /^[0-9a-f]{64}$/)
    assert.deepEqual(readPromptImage(ref), png)
    assert.equal(readFileSync(join(session.dir, 'messages.jsonl'), 'utf8'), '')

    const path = join(session.dir, 'artifacts', 'prompt-images', `${ref.id}.png`)
    writeFileSync(path, Buffer.from('not a png'))
    assert.throws(() => readPromptImage(ref), /校验失败/)
  })
})

test('re-archiving repairs a truncated or oversized file from the verified image', () => {
  withImageSession((session) => {
    const [ref] = persistPromptImages(session.sessionId, [png])
    const path = join(session.dir, 'artifacts', 'prompt-images', `${ref.id}.png`)

    for (const size of [2, MAX_PROMPT_IMAGE_BYTES + 1]) {
      truncateSync(path, size)
      assert.throws(() => readPromptImage(ref), /校验失败/)
      assert.deepEqual(persistPromptImages(session.sessionId, [png]), [ref])
      assert.deepEqual(readPromptImage(ref), png)
    }
  })
})

test(
  'legacy regular image files remain readable and re-archiving makes them private',
  {
    skip: process.platform === 'win32'
  },
  () => {
    withImageSession((session) => {
      const [ref] = persistPromptImages(session.sessionId, [png])
      const path = join(session.dir, 'artifacts', 'prompt-images', `${ref.id}.png`)
      chmodSync(path, 0o644)
      assert.deepEqual(readPromptImage(ref), png)
      assert.deepEqual(persistPromptImages(session.sessionId, [png]), [ref])
      assert.equal(lstatSync(path).mode & 0o777, 0o600)
    })
  }
)

test(
  'image history rejects symlinks, hardlinks, and symlinked archive directories',
  {
    skip: process.platform === 'win32'
  },
  () => {
    withImageSession((session) => {
      const [ref] = persistPromptImages(session.sessionId, [png])
      const directory = join(session.dir, 'artifacts', 'prompt-images')
      const path = join(directory, `${ref.id}.png`)
      const outside = join(session.dir, 'external.png')
      writeFileSync(outside, Buffer.from(png.data, 'base64'), { mode: 0o600 })

      for (const createLink of [symlinkSync, linkSync]) {
        rmSync(path)
        createLink(outside, path)
        assert.throws(() => readPromptImage(ref), /校验失败/)
        assert.throws(() => persistPromptImages(session.sessionId, [png]), /校验失败/)
      }
      assert.deepEqual(readFileSync(outside), Buffer.from(png.data, 'base64'))

      rmSync(directory, { recursive: true })
      symlinkSync(session.dir, directory, 'dir')
      assert.throws(() => readPromptImage(ref), /目录校验失败/)
      assert.throws(() => persistPromptImages(session.sessionId, [png]), /目录校验失败/)
    })
  }
)

test(
  'archive transfer reports file and directory sync failures and cleans its temp files',
  {
    skip: process.platform === 'win32'
  },
  (t) => {
    const sync = fs.fsyncSync
    let failOnDirectory = false
    t.mock.method(fs, 'fsyncSync', (fd: number): void => {
      if (fs.fstatSync(fd).isDirectory() === failOnDirectory) throw new Error('sync failed')
      sync(fd)
    })
    syncBuiltinESMExports()
    try {
      withImageSession((session) => {
        const directory = join(session.dir, 'artifacts', 'prompt-images')
        assert.throws(() => persistPromptImages(session.sessionId, [png]), /sync failed/)
        assert.deepEqual(readdirSync(directory), [])

        failOnDirectory = true
        assert.throws(() => persistPromptImages(session.sessionId, [png]), /sync failed/)
        assert.equal(readdirSync(directory).length, 1)
        assert.ok(readdirSync(directory).every((name) => !name.endsWith('.tmp')))

        t.mock.restoreAll()
        syncBuiltinESMExports()
        const [ref] = persistPromptImages(session.sessionId, [png])
        assert.deepEqual(readPromptImage(ref), png)
      })
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  }
)

test('pasted image input rejects oversized, mismatched, and malformed data', () => {
  assert.throws(
    () => validatePromptImages([{ mimeType: 'image/jpeg', data: png.data }]),
    /格式不符/
  )
  assert.throws(() => validatePromptImages([{ mimeType: 'image/png', data: '***' }]), /无效/)
  assert.throws(() => validatePromptImages(Array(5).fill(png)), /最多发送 4 张/)
  assert.throws(
    () => validatePromptImages([{ mimeType: 'image/png', data: 'A'.repeat(12_000_000) }]),
    /8 MB/
  )
})
