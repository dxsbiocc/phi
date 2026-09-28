import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exportPhiSession } from '../src/main/agent/session/session-export'
import {
  appendSessionEvent,
  createPhiSession,
  updateSessionManifest
} from '../src/main/agent/session/session-store'

async function withFixture(
  run: (input: {
    phiDir: string
    destination: string
    sessionId: string
    sessionDir: string
    runtimePath: string
    blobHash: string
  }) => Promise<void>
): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const root = mkdtempSync(join(tmpdir(), 'phi-session-export-test-'))
  const phiDir = join(root, 'phi')
  const destination = join(root, 'exports')
  mkdirSync(phiDir)
  mkdirSync(destination)
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    const runtimeDir = join(phiDir, 'runtime')
    mkdirSync(runtimeDir)
    const runtimePath = join(runtimeDir, 'runtime-session.jsonl')
    const blob = Buffer.from('image bytes')
    const blobHash = createHash('sha256').update(blob).digest('hex')
    mkdirSync(join(phiDir, 'blobs'))
    writeFileSync(join(phiDir, 'blobs', blobHash), blob)
    writeFileSync(runtimePath, `{"type":"image","data":"blob:sha256:${blobHash}"}\n`)
    mkdirSync(join(runtimeDir, 'runtime-session'))
    writeFileSync(join(runtimeDir, 'runtime-session', 'tool.txt'), 'runtime artifact')

    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: join(root, 'project'),
      cwdRealPath: join(root, 'project'),
      permissionMode: 'ask',
      runtimeSessionPath: runtimePath
    })
    appendSessionEvent(session.sessionId, { type: 'user_message', content: 'private prompt' })
    writeFileSync(join(session.dir, 'tool-outputs', 'output.txt'), 'private tool output')
    mkdirSync(join(session.dir, 'artifacts', 'prompt-images'))
    writeFileSync(join(session.dir, 'artifacts', 'prompt-images', 'image.png'), blob)
    await run({
      phiDir,
      destination,
      sessionId: session.sessionId,
      sessionDir: session.dir,
      runtimePath,
      blobHash
    })
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test('full export copies only one Phi session, its runtime history, artifacts, and referenced blobs', async () => {
  await withFixture(async ({ destination, sessionId, sessionDir, blobHash }) => {
    const result = await exportPhiSession(sessionId, destination)
    assert.ok(result.path.startsWith(realpathSync(destination)))
    assert.equal(result.runtimeIncluded, true)
    assert.equal(result.blobCount, 1)
    assert.match(
      readFileSync(join(result.path, 'phi-session', 'messages.jsonl'), 'utf8'),
      /private prompt/
    )
    assert.equal(
      readFileSync(join(result.path, 'phi-session', 'tool-outputs', 'output.txt'), 'utf8'),
      'private tool output'
    )
    assert.equal(
      readFileSync(
        join(result.path, 'phi-session', 'artifacts', 'prompt-images', 'image.png')
      ).toString(),
      'image bytes'
    )
    assert.match(
      readFileSync(join(result.path, 'runtime', 'runtime-session.jsonl'), 'utf8'),
      /blob:sha256:/
    )
    assert.equal(
      readFileSync(join(result.path, 'runtime', 'artifacts', 'tool.txt'), 'utf8'),
      'runtime artifact'
    )
    assert.equal(
      readFileSync(join(result.path, 'runtime', 'blobs', blobHash)).toString(),
      'image bytes'
    )
    assert.equal(
      JSON.parse(readFileSync(join(result.path, 'export-info.json'), 'utf8')).sessionId,
      sessionId
    )
    assert.equal(existsSync(join(sessionDir, 'messages.jsonl')), true)
    assert.equal(readdirSync(destination).length, 1)
  })
})

test('full export rejects an active session and destinations inside Phi data', async () => {
  await withFixture(async ({ destination, phiDir, sessionId }) => {
    await assert.rejects(exportPhiSession(sessionId, phiDir), /Phi 数据目录之外/)
    updateSessionManifest(sessionId, { status: 'running', currentRunId: 'run-1' })
    await assert.rejects(exportPhiSession(sessionId, destination), /运行结束/)
    assert.deepEqual(readdirSync(destination), [])
  })
})

test('full export refuses symlinked session data and cleans its temporary folder', async () => {
  await withFixture(async ({ destination, sessionId, sessionDir }) => {
    symlinkSync(join(sessionDir, 'messages.jsonl'), join(sessionDir, 'artifacts', 'linked.jsonl'))
    await assert.rejects(exportPhiSession(sessionId, destination), /链接或特殊文件/)
    assert.deepEqual(readdirSync(destination), [])
  })
})

test('full export fails when a referenced blob is missing instead of claiming completeness', async () => {
  await withFixture(async ({ destination, phiDir, sessionId, blobHash }) => {
    rmSync(join(phiDir, 'blobs', blobHash))
    await assert.rejects(exportPhiSession(sessionId, destination))
    assert.deepEqual(readdirSync(destination), [])
  })
})

test('full export rejects a corrupted referenced blob', async () => {
  await withFixture(async ({ destination, phiDir, sessionId, blobHash }) => {
    writeFileSync(join(phiDir, 'blobs', blobHash), 'corrupted')
    await assert.rejects(exportPhiSession(sessionId, destination), /资源校验失败/)
    assert.deepEqual(readdirSync(destination), [])
  })
})

test('full export refuses a runtime history path outside Phi ownership', async () => {
  await withFixture(async ({ destination, sessionId }) => {
    const outside = join(destination, 'outside.jsonl')
    writeFileSync(outside, '{"private":"external"}\n')
    updateSessionManifest(sessionId, { runtimeSessionPath: outside })
    await assert.rejects(exportPhiSession(sessionId, destination), /Phi 数据目录之外/)
    assert.deepEqual(readdirSync(destination), ['outside.jsonl'])
  })
})

test('full export refuses a missing referenced runtime history', async () => {
  await withFixture(async ({ destination, runtimePath, sessionId }) => {
    rmSync(runtimePath)
    await assert.rejects(exportPhiSession(sessionId, destination), /已不存在/)
    assert.deepEqual(readdirSync(destination), [])
  })
})
