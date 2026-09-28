import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  persistPromptImages,
  readPromptImage,
  validatePromptImages
} from '../src/main/agent/session/prompt-images'
import { createPhiSession } from '../src/main/agent/session/session-store'

const png = {
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='
}

test('pasted images are validated, stored outside the event log, and readable after reopening', () => {
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
    const [ref] = persistPromptImages(session.sessionId, validatePromptImages([png]))
    assert.equal(ref.sessionId, session.sessionId)
    assert.match(ref.id, /^[0-9a-f]{64}$/)
    assert.deepEqual(readPromptImage(ref), png)
    assert.equal(readFileSync(join(session.dir, 'messages.jsonl'), 'utf8'), '')

    const path = join(session.dir, 'artifacts', 'prompt-images', `${ref.id}.png`)
    writeFileSync(path, Buffer.from('not a png'))
    assert.throws(() => readPromptImage(ref), /校验失败/)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(phiDir, { recursive: true, force: true })
  }
})

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
