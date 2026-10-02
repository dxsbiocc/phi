import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  getEnablementPath,
  migrateEnablementFromHistory,
  readEnablementState,
  type EnablementLogger
} from '../src/main/agent/enablement'

interface TestLogger extends EnablementLogger {
  infos: Array<{ message: string; metadata?: Record<string, unknown> }>
  warnings: Array<{ message: string; metadata?: Record<string, unknown> }>
}

function createLogger(): TestLogger {
  const infos: TestLogger['infos'] = []
  const warnings: TestLogger['warnings'] = []
  return {
    infos,
    warnings,
    info(message, metadata) {
      infos.push({ message, metadata })
    },
    warn(message, metadata) {
      warnings.push({ message, metadata })
    }
  }
}

function withSandbox(callback: (agentDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-enablement-migration-'))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  try {
    callback(agentDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeHistory(
  agentDir: string,
  sessionId: string,
  lines: Array<unknown | string>,
  modifiedAt?: Date
): string {
  const sessionDir = join(agentDir, 'sessions', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const path = join(sessionDir, 'messages.jsonl')
  const text = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n')
  writeFileSync(path, `${text}\n`, 'utf8')
  if (modifiedAt) utimesSync(path, modifiedAt, modifiedAt)
  return path
}

test('first-start migration enables only bundled skills explicitly loaded or invoked', () => {
  withSandbox((agentDir) => {
    const logger = createLogger()
    writeHistory(agentDir, 'session-a', [
      { type: 'run_started', loadedSkills: ['pptx', 'installed-only'] },
      { type: 'skill_invoked', skillName: 'scanpy' },
      {
        type: 'tool_call_started',
        toolName: 'skill_run',
        args: { skill: 'rdkit', script: 'run.py' }
      },
      { type: 'assistant_message_finalized', content: 'Try networkx next.' },
      { type: 'tool_call_started', toolName: 'bash', args: { skill: 'networkx' } }
    ])

    const result = migrateEnablementFromHistory(['pptx', 'scanpy', 'rdkit', 'networkx'], {
      agentDir,
      logger
    })
    assert.deepEqual(result.enabledSkills, ['pptx', 'rdkit', 'scanpy'])
    assert.equal(result.migrated, true)
    assert.deepEqual(readEnablementState({ agentDir, logger }).global, {
      'skill:pptx': true,
      'skill:rdkit': true,
      'skill:scanpy': true
    })
    assert.deepEqual(logger.infos[0].metadata?.enabledSkills, ['pptx', 'rdkit', 'scanpy'])

    writeHistory(agentDir, 'session-b', [{ loadedSkill: 'networkx' }])
    assert.deepEqual(migrateEnablementFromHistory(['networkx'], { agentDir, logger }), {
      migrated: false,
      enabledSkills: [],
      sessionsScanned: 0,
      bytesScanned: 0
    })
    assert.equal(readEnablementState({ agentDir, logger }).global['skill:networkx'], undefined)
  })
})

test('migration scans only the newest configured number of sessions', () => {
  withSandbox((agentDir) => {
    const logger = createLogger()
    writeHistory(agentDir, 'older', [{ loadedSkill: 'pptx' }], new Date('2026-01-01T00:00:00.000Z'))
    writeHistory(
      agentDir,
      'newer',
      [{ invokedSkill: 'scanpy' }],
      new Date('2026-01-02T00:00:00.000Z')
    )

    const result = migrateEnablementFromHistory(['pptx', 'scanpy'], {
      agentDir,
      logger,
      limits: { maxSessions: 1 }
    })
    assert.equal(result.sessionsScanned, 1)
    assert.deepEqual(result.enabledSkills, ['scanpy'])
  })
})

test('migration never reads beyond the configured byte cap', () => {
  withSandbox((agentDir) => {
    const logger = createLogger()
    const firstLine = JSON.stringify({ loadedSkill: 'scanpy' })
    const secondLine = JSON.stringify({ loadedSkill: 'pptx' })
    writeHistory(agentDir, 'session', [firstLine, secondLine])
    const maxBytes = Buffer.byteLength(`${firstLine}\n`)

    const result = migrateEnablementFromHistory(['scanpy', 'pptx'], {
      agentDir,
      logger,
      limits: { maxBytes }
    })
    assert.equal(result.bytesScanned, maxBytes)
    assert.deepEqual(result.enabledSkills, ['scanpy'])
  })
})

test('malformed files and lines do not prevent later valid history from migrating', () => {
  withSandbox((agentDir) => {
    const logger = createLogger()
    writeHistory(agentDir, 'valid', [
      '{not json',
      { loaded_skills: ['pptx'] },
      { invoked_skills: ['scanpy'] }
    ])
    const brokenPath = join(agentDir, 'sessions', 'broken', 'messages.jsonl')
    mkdirSync(brokenPath, { recursive: true })

    const result = migrateEnablementFromHistory(['pptx', 'scanpy'], { agentDir, logger })
    assert.deepEqual(result.enabledSkills, ['pptx', 'scanpy'])
    assert.equal(result.sessionsScanned, 2)
    assert.equal(
      logger.warnings.some((entry) => entry.message.includes('malformed')),
      true
    )
    assert.equal(
      logger.warnings.some((entry) => entry.message.includes('Could not scan')),
      true
    )
  })
})

test('a first start without history still writes an empty migration marker state', () => {
  withSandbox((agentDir) => {
    const logger = createLogger()
    const result = migrateEnablementFromHistory(['pptx'], { agentDir, logger })
    assert.deepEqual(result, {
      migrated: true,
      enabledSkills: [],
      sessionsScanned: 0,
      bytesScanned: 0
    })
    assert.deepEqual(JSON.parse(readFileSync(getEnablementPath(agentDir), 'utf8')), {
      version: 1,
      global: {},
      projects: {}
    })
  })
})

test('invalid migration limits are rejected before state is written', () => {
  withSandbox((agentDir) => {
    const logger = createLogger()
    assert.throws(
      () =>
        migrateEnablementFromHistory(['pptx'], {
          agentDir,
          logger,
          limits: { maxSessions: -1 }
        }),
      /non-negative integers/
    )
    assert.throws(() => readFileSync(getEnablementPath(agentDir), 'utf8'), /ENOENT/)
  })
})
