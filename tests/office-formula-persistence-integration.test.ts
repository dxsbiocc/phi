import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { createPhiSession } from '../src/main/agent/session/session-store'
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const binary = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

function officeOwners(path: string): string {
  try {
    return execFileSync('/usr/sbin/lsof', ['-t', '-a', '-c', 'officecli', '--', path], {
      encoding: 'utf8'
    })
  } catch {
    return ''
  }
}

test(
  'saved formula survives resident close, registered-draft rebind, and validation',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office formula persistence '))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'ask'
    })
    const first = createOfficeService()
    let second: ReturnType<typeof createOfficeService> | undefined
    let draftPath = ''
    try {
      const created = await first.create({
        requestId: 'formula-persistence-create',
        sessionId: session.sessionId,
        projectId: null,
        name: '公式持久化.xlsx'
      })
      assert.equal(created.state, 'ready')
      if (created.state !== 'ready') throw new Error(created.message)
      draftPath = created.document.draftPath
      first.bindRunTarget({
        runId: 'formula-before-restart',
        artifactId: created.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const values = validateOfficeWriteRequest({
        operation: { type: 'set_range', sheet: 'Sheet1', range: 'A1:A2', values: [[1], [2]] },
        baseRevision: 0
      })
      const initialized = await first.applyWriteRequest('formula-before-restart', values, {
        operationId: 'formula-persistence-values'
      })
      assert.equal(initialized.revision, 1)
      const formula = validateOfficeWriteRequest({
        operation: {
          type: 'set_formula',
          sheet: 'Sheet1',
          cell: 'E1',
          formula: '=SUM(A1:A2)'
        },
        baseRevision: 1
      })
      const applied = await first.applyWriteRequest('formula-before-restart', formula, {
        operationId: 'formula-persistence-write'
      })
      assert.equal(applied.revision, 2)
      await first.dispose()
      assert.equal(officeOwners(draftPath), '')

      second = createOfficeService()
      const reopened = await second.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        allowRoots: [root]
      })
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      assert.equal(reopened.document.artifactId, created.document.artifactId)
      second.bindRunTarget({
        runId: 'formula-after-restart',
        artifactId: reopened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const read = await second.readRange('formula-after-restart', {
        sheet: 'Sheet1',
        range: 'E1'
      })
      assert.equal(read.revision, 2)
      assert.ok('cells' in read)
      assert.deepEqual(read.cells[0], {
        ref: 'E1',
        value: 3,
        formula: '=SUM(A1:A2)',
        valueType: 'number',
        evaluated: true
      })
      const replay = await second.applyWriteRequest('formula-after-restart', formula, {
        operationId: 'formula-persistence-write'
      })
      assert.equal(replay.deduplicated, true)
      assert.equal(replay.revision, 2)
      await second.dispose()
      second = undefined
      assert.equal(officeOwners(draftPath), '')

      const validation = await runOfficeCli(binary!, ['validate', draftPath, '--json'], {
        timeoutMs: 30_000
      })
      assert.equal(validation.exitCode, 0, validation.stderr || validation.stdout)
      await runOfficeCli(binary!, ['close', draftPath, '--json'], { timeoutMs: 15_000 }).catch(
        () => undefined
      )
      assert.equal(officeOwners(draftPath), '')
    } finally {
      await second?.dispose().catch(() => undefined)
      await first.dispose().catch(() => undefined)
      if (draftPath) {
        await runOfficeCli(binary!, ['close', draftPath, '--json'], { timeoutMs: 15_000 }).catch(
          () => undefined
        )
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('real formula writes stay isolated across two Office sessions', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office formula isolation '))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  const service = createOfficeService()
  let draftPaths: string[] = []
  try {
    const sessions = [1, 2].map(() =>
      createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'ask'
      })
    )
    const created = await Promise.all(
      sessions.map((session, index) =>
        service.create({
          requestId: `formula-isolation-${index}`,
          sessionId: session.sessionId,
          projectId: null,
          name: `隔离-${index + 1}.xlsx`
        })
      )
    )
    assert.ok(created.every((entry) => entry.state === 'ready'))
    if (created.some((entry) => entry.state !== 'ready')) throw new Error('create failed')
    const ready = created as Array<Extract<(typeof created)[number], { state: 'ready' }>>
    draftPaths = ready.map((entry) => entry.document.draftPath)
    for (const [index, entry] of ready.entries()) {
      service.bindRunTarget({
        runId: `formula-isolation-run-${index}`,
        artifactId: entry.document.artifactId,
        sessionId: sessions[index]!.sessionId,
        projectId: null
      })
      const request = validateOfficeWriteRequest({
        operation: {
          type: 'set_formula',
          sheet: 'Sheet1',
          cell: 'E1',
          formula: index === 0 ? '=1+1' : '=2+2'
        },
        baseRevision: 0
      })
      const result = await service.applyWriteRequest(`formula-isolation-run-${index}`, request, {
        operationId: `formula-isolation-operation-${index}`
      })
      assert.equal(
        'computedValue' in result ? result.computedValue : undefined,
        index === 0 ? 2 : 4
      )
    }
    const reads = await Promise.all(
      ready.map((_entry, index) =>
        service.readRange(`formula-isolation-run-${index}`, { sheet: 'Sheet1', range: 'E1' })
      )
    )
    assert.deepEqual(
      reads.map((read) => ('cells' in read ? read.cells[0]?.value : undefined)),
      [2, 4]
    )
    assert.notEqual(draftPaths[0], draftPaths[1])
  } finally {
    await service.dispose().catch(() => undefined)
    for (const draftPath of draftPaths) {
      await runOfficeCli(binary!, ['close', draftPath, '--json'], { timeoutMs: 15_000 }).catch(
        () => undefined
      )
      assert.equal(officeOwners(draftPath), '')
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
