import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { officePlatformId } from '../scripts/office/fetch-officecli.mjs'
import { runOfficeCli } from '../src/main/agent/office/office-driver'
import { officeBinaryCandidates } from '../src/main/agent/office/office-runtime'
import { createOfficeService } from '../src/main/agent/office/office-service'
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write'
import { createPhiSession } from '../src/main/agent/session/session-store'

const platformId = officePlatformId()
const binary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}
const fixture = join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx')

test(
  'real explicit save and save-as produce externally readable immutable XLSX bytes',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office save integration '))
    const restoreAgentDir = withAgentDir(root)
    const sourcePath = join(root, 'source.xlsx')
    const targetPath = join(root, 'output.xlsx')
    copyFileSync(fixture, sourcePath)
    const sourceHash = digest(sourcePath)
    const receipts: Array<{ command: string; stdout: string; exitCode: number | null }> = []
    const run: typeof runOfficeCli = async (binaryPath, args, runOptions) => {
      const result = await runOfficeCli(binaryPath, args, runOptions)
      if (args[0] === 'save' || args[0] === 'validate') {
        receipts.push({ command: args[0], stdout: result.stdout, exitCode: result.exitCode })
      }
      return result
    }
    const service = createOfficeService({ runOfficeCli: run })
    const reader = createOfficeService({ runOfficeCli: run })
    let draftPath = ''
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const opened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      })
      assert.equal(opened.state, 'ready')
      if (opened.state !== 'ready') throw new Error(opened.message)
      draftPath = opened.document.draftPath
      service.bindRunTarget({
        runId: 'save-run',
        artifactId: opened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })

      await service.applyCellEdit(
        'save-run',
        { sheet: 'Sheet1', cell: 'A1', value: 'LatestValue', baseRevision: 0 },
        { operationId: 'save-value' }
      )
      await service.applyWriteRequest(
        'save-run',
        validateOfficeWriteRequest({
          operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'C1', formula: '=SUM(B1:B2)' },
          baseRevision: 1
        }),
        { operationId: 'save-formula' }
      )
      await service.applyWriteRequest(
        'save-run',
        validateOfficeWriteRequest({
          operation: { type: 'add_sheet', name: '保存核对' },
          baseRevision: 2
        }),
        { operationId: 'save-sheet' }
      )

      const saved = await service.saveDocument(opened.document.artifactId, session.sessionId)
      assert.equal(saved.revision, 3)
      const externalText = xlsxXmlText(draftPath)
      assert.match(externalText, /LatestValue/u)
      assert.match(externalText, /SUM\(B1:B2\)/u)
      assert.match(externalText, /保存核对/u)
      assert.equal(digest(sourcePath), sourceHash)

      const output = await service.saveAsDocument(
        opened.document.artifactId,
        session.sessionId,
        root,
        targetPath
      )
      assert.equal(output.revision, 3)
      assert.equal(output.sha256, digest(targetPath))
      // `validate` on the temporary copy starts a resident; it must be gone before Save As
      // returns, or it outlives the deleted copy and could write that path back into the project.
      assert.deepEqual(
        residentCommandsMentioning(root, '.tmp.xlsx'),
        [],
        'Save As 遗留了临时副本的 resident'
      )
      assert.deepEqual(
        readdirSync(root).filter((name) => name.includes('.tmp.xlsx')),
        []
      )
      const beforeValidate = digest(targetPath)
      const validated = await runOfficeCli(binary!, ['validate', targetPath, '--json'], {
        timeoutMs: 30_000
      })
      assert.equal(validated.exitCode, 0, validated.stderr || validated.stdout)
      assert.equal((JSON.parse(validated.stdout) as { success?: unknown }).success, true)
      assert.equal(digest(targetPath), beforeValidate, 'officecli validate 改动了输出字节')
      await runOfficeCli(binary!, ['close', targetPath, '--json'], { timeoutMs: 30_000 })

      const reopened = await reader.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: targetPath,
        allowRoots: [root]
      })
      assert.equal(reopened.state, 'ready')
      if (reopened.state !== 'ready') throw new Error(reopened.message)
      reader.bindRunTarget({
        runId: 'output-reader',
        artifactId: reopened.document.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const read = await reader.readRange('output-reader', { sheet: 'Sheet1', range: 'A1' })
      assert.ok('cells' in read)
      assert.equal(read.cells[0]?.value, 'LatestValue')

      const outputHash = digest(targetPath)
      await service.applyCellEdit(
        'save-run',
        { sheet: 'Sheet1', cell: 'A2', value: 'LaterDraftChange', baseRevision: 3 },
        { operationId: 'after-output' }
      )
      assert.equal(digest(targetPath), outputHash)
      await assert.rejects(
        service.saveAsDocument(opened.document.artifactId, session.sessionId, root, targetPath),
        { code: 'target_exists' }
      )
      assert.equal(digest(targetPath), outputHash)
      assert.equal(digest(sourcePath), sourceHash)
      assert.equal(
        readdirSync(root).some((name) => name.includes('.phi-')),
        false
      )
      assert.ok(receipts.every((receipt) => receipt.exitCode === 0))
      assert.ok(receipts.some((receipt) => receipt.command === 'save'))
      assert.ok(receipts.some((receipt) => receipt.command === 'validate'))
    } finally {
      await reader.dispose().catch(() => undefined)
      await service.dispose().catch(() => undefined)
      restoreAgentDir()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

function xlsxXmlText(path: string): string {
  return ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml', 'xl/workbook.xml']
    .map((entry) => {
      try {
        return execFileSync('/usr/bin/unzip', ['-p', path, entry], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
      } catch {
        return ''
      }
    })
    .join('\n')
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function withAgentDir(root: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

/** Resident daemons keep the document in memory, so lsof cannot see them; ps can. */
function residentCommandsMentioning(directory: string, fragment: string): string[] {
  try {
    return execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })
      .split('\n')
      .filter(
        (line) =>
          line.includes('__resident-serve__') && line.includes(directory) && line.includes(fragment)
      )
  } catch {
    // Some sandboxes forbid ps; the smoke script checks the same property there.
    return []
  }
}
