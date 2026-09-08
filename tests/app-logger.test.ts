import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cleanupOldLogs, getPhiLogDir, writeAppLog } from '../src/main/agent/app-logger'

function withPhiDir(callback: (phiDir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = join(tmpdir(), `phi-app-logger-${Date.now()}-${Math.random()}`)
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    callback(phiDir)
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous
    }
    rmSync(phiDir, { recursive: true, force: true })
  }
}

test('writeAppLog writes compact redacted jsonl entries', () => {
  withPhiDir(() => {
    writeAppLog(
      {
        level: 'error',
        event: 'tool_failed',
        sessionId: 'session-1',
        runId: 'run-1',
        metadata: {
          toolName: 'bash',
          output: 'x'.repeat(600),
          stdout: 'public stdout',
          stderr: 'public stderr',
          result: { output: 'nested output' },
          message: 'failed with api_key=sk-live-secret12345',
          apiKey: 'secret',
          nested: { token: 'hidden', safe: 'shown' }
        }
      },
      new Date('2026-09-06T08:00:00.000Z')
    )

    const logPath = join(getPhiLogDir(), '2026-09-06.jsonl')
    const entry = JSON.parse(readFileSync(logPath, 'utf-8')) as {
      event: string
      level: string
      metadata: Record<string, unknown>
    }

    assert.equal(entry.event, 'tool_failed')
    assert.equal(entry.level, 'error')
    assert.equal(entry.metadata.output, '[omitted 600 chars]')
    assert.equal(entry.metadata.stdout, '[omitted 13 chars]')
    assert.equal(entry.metadata.stderr, '[omitted 13 chars]')
    assert.equal(entry.metadata.result, '[omitted]')
    assert.equal(entry.metadata.message, 'failed with api_key=[redacted]')
    assert.equal('apiKey' in entry.metadata, false)
    assert.deepEqual(entry.metadata.nested, { safe: 'shown' })
  })
})

test('cleanupOldLogs removes jsonl files older than retention window only', () => {
  withPhiDir(() => {
    const logDir = getPhiLogDir()
    mkdirSync(logDir, { recursive: true })
    const oldPath = join(logDir, 'old.jsonl')
    const freshPath = join(logDir, 'fresh.jsonl')
    const ignoredPath = join(logDir, 'note.txt')
    writeFileSync(oldPath, '{}\n', 'utf-8')
    writeFileSync(freshPath, '{}\n', 'utf-8')
    writeFileSync(ignoredPath, 'keep', 'utf-8')
    utimesSync(oldPath, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'))
    utimesSync(
      freshPath,
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-01T00:00:00.000Z')
    )

    assert.equal(cleanupOldLogs(new Date('2026-09-06T00:00:00.000Z')), 1)
    assert.equal(existsSync(oldPath), false)
    assert.equal(existsSync(freshPath), true)
    assert.equal(existsSync(ignoredPath), true)
  })
})
