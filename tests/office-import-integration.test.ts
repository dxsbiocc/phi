import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { createPhiSession } from '../src/main/agent/session/session-store'
import { officeBinaryCandidates, officePlatformId } from '../src/main/agent/office/office-runtime'
import { createImportedOfficeDraft } from '../src/main/agent/office/office-import-files'
import {
  OfficeImportWorkbookDriver,
  OfficeImportWorkbookVerifier
} from '../src/main/agent/office/office-import-driver'
import {
  adoptCreatedOfficeResident,
  releaseTransientOfficeResident
} from '../src/main/agent/office/office-process'
import { validateRegisteredOfficeDraft } from '../src/main/agent/office/office-files'
import { OfficeDraftRegistry } from '../src/main/agent/office/office-draft-registry'
import { parseOfficeDelimitedBytes } from '../src/main/agent/office/office-import-csv'
import { convertOfficeImportRows } from '../src/main/agent/office/office-import-values'
import { OfficePreviewProcessManager } from '../src/main/agent/office/office-watch'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import type { OfficeImportedArtifact } from '../src/main/agent/office/office-files'
import { createOfficeService } from '../src/main/agent/office/office-service'

const platformId = officePlatformId(process.platform, process.arch)
const binary = platformId
  ? officeBinaryCandidates(platformId, {
      bundledOfficeDir: join(process.cwd(), 'resources', 'office')
    })[0]
  : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && Boolean(binary && existsSync(binary))
const options = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
} as const

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function withImportSession(
  name: string,
  run: (input: { root: string; sourcePath: string; sessionId: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'office-import-integration-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  const sourcePath = join(root, name)
  await copyFile(join(process.cwd(), 'tests', 'fixtures', 'office', name), sourcePath)
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    await run({ root, sourcePath, sessionId: session.sessionId })
  } finally {
    if (binary) await releaseTransientOfficeResident(binary, sourcePath).catch(() => undefined)
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
}

for (const fixture of [
  { name: 'import-sample.csv', format: 'csv' as const },
  { name: 'import-sample.tsv', format: 'tsv' as const },
  { name: 'import-sample.tab', format: 'tsv' as const }
]) {
  test(`real OfficeCLI imports and fully verifies ${fixture.name}`, options, async () => {
    await withImportSession(fixture.name, async ({ root, sourcePath, sessionId }) => {
      const sourceBefore = readFileSync(sourcePath)
      const parsed = parseOfficeDelimitedBytes(sourceBefore, fixture.format)
      const driver = new OfficeImportWorkbookDriver()
      const artifact = await createImportedOfficeDraft(
        {
          sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root],
          format: fixture.format
        },
        {
          artifactId: () => `real-${fixture.format}-${basename(sourcePath).replace(/\W/gu, '-')}`,
          importWorkbook: (input) => driver.prepare(binary!, input),
          releaseWorkbook: (draftPath) => releaseTransientOfficeResident(binary!, draftPath)
        }
      )

      await validateRegisteredOfficeDraft(artifact, sessionId)
      assert.equal(sha256(readFileSync(sourcePath)), sha256(sourceBefore))
      assert.equal(artifact.importSource.rows, parsed.rows)
      assert.equal(artifact.importSource.columns, parsed.columns)
      await releaseTransientOfficeResident(binary!, artifact.draftPath)
      await new OfficeImportWorkbookVerifier().verify(
        binary!,
        artifact.draftPath,
        'Sheet1',
        convertOfficeImportRows(parsed.values)
      )
      await releaseTransientOfficeResident(binary!, artifact.draftPath)

      const restored = await new OfficeDraftRegistry().findByArtifactId(
        sessionId,
        artifact.artifactId
      )
      assert.equal(restored?.origin, 'import')
      assert.equal(restored?.draftPath, artifact.draftPath)
    })
  })
}

test(
  'real import rejects oversized and invalid UTF-8 sources before creating a workbook',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-integration-invalid-'))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const sources = [
        { path: join(root, 'too-many.csv'), bytes: Buffer.from(`${'x,'.repeat(100)}x\n`) },
        { path: join(root, 'invalid.csv'), bytes: Buffer.from([0xc3, 0x28]) }
      ]
      const tooManyRows = Array.from({ length: 1_001 }, () => 'x').join('\n')
      sources[0]!.bytes = Buffer.from(tooManyRows)
      for (const [index, source] of sources.entries()) {
        writeFileSync(source.path, source.bytes)
        let imported = false
        await assert.rejects(
          createImportedOfficeDraft(
            {
              sessionId: session.sessionId,
              projectId: null,
              sourcePath: source.path,
              allowRoots: [root],
              format: 'csv'
            },
            {
              artifactId: () => `invalid-${index}`,
              importWorkbook: async () => {
                imported = true
              },
              releaseWorkbook: async () => undefined
            }
          ),
          { code: index === 0 ? 'import_too_large' : 'unsupported_encoding' }
        )
        assert.equal(imported, false)
        assert.equal(
          existsSync(join(session.dir, 'artifacts', 'office', `invalid-${index}`)),
          false
        )
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'real OfficeCLI retains the last value of a generated 1,000 x 80 import',
  options,
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-integration-wide-'))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, 'wide.csv')
    const rows = Array.from({ length: 1_000 }, (_, row) =>
      Array.from({ length: 80 }, (_, column) => `${row + 1}-${column + 1}`).join(',')
    )
    writeFileSync(sourcePath, rows.join('\n'))
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const driver = new OfficeImportWorkbookDriver()
      const startedAt = Date.now()
      const artifact = await createImportedOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root],
          format: 'csv'
        },
        {
          artifactId: () => 'wide-1000x80',
          importWorkbook: (input) => driver.prepare(binary!, input),
          releaseWorkbook: (draftPath) => releaseTransientOfficeResident(binary!, draftPath)
        }
      )
      const elapsedMs = Date.now() - startedAt
      assert.equal(artifact.importSource.rows, 1_000)
      assert.equal(artifact.importSource.columns, 80)
      assert.equal(readFileSync(sourcePath, 'utf8'), rows.join('\n'))
      assert.ok(elapsedMs > 0)
      const resident = await adoptCreatedOfficeResident(binary!, artifact)
      const previews = new OfficePreviewProcessManager()
      const previewStartedAt = Date.now()
      const preview = await previews.start(binary!, artifact)
      const previewStartMs = Date.now() - previewStartedAt
      try {
        const fetchStartedAt = Date.now()
        const response = await fetch(preview.previewUrl)
        const html = await response.text()
        const previewFetchMs = Date.now() - fetchStartedAt
        assert.equal(response.ok, true)
        assert.match(html, /1000-80/u)
        t.diagnostic(
          JSON.stringify({
            importMs: elapsedMs,
            previewStartMs,
            previewFetchMs,
            previewHtmlBytes: Buffer.byteLength(html),
            residentPid: resident.residentPid,
            watchPid: preview.watchPid
          })
        )
      } finally {
        await previews.stop({ ...artifact, ...preview })
        await releaseTransientOfficeResident(binary!, artifact.draftPath)
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('real imports of one source remain isolated across two sessions', options, async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-import-integration-isolation-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  const sourcePath = join(root, 'shared.csv')
  const sourceBytes = Buffer.from('name,value\n中文,42\n')
  writeFileSync(sourcePath, sourceBytes)
  const artifacts: OfficeImportedArtifact[] = []
  try {
    const sessions = Array.from({ length: 2 }, () =>
      createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
    )
    const driver = new OfficeImportWorkbookDriver()
    for (const session of sessions) {
      artifacts.push(
        await createImportedOfficeDraft(
          {
            sessionId: session.sessionId,
            projectId: null,
            sourcePath,
            allowRoots: [root],
            format: 'csv'
          },
          {
            artifactId: () => 'shared-import',
            importWorkbook: (input) => driver.prepare(binary!, input),
            releaseWorkbook: (draftPath) => releaseTransientOfficeResident(binary!, draftPath)
          }
        )
      )
    }
    assert.notEqual(artifacts[0]!.draftPath, artifacts[1]!.draftPath)
    const command = JSON.stringify([
      { command: 'set', path: '/Sheet1/A1', props: { value: 'changed', type: 'string' } }
    ])
    const changed = await runOfficeCli(
      binary!,
      ['batch', artifacts[0]!.draftPath, '--commands', command, '--json'],
      { env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' }) }
    )
    assert.equal(changed.exitCode, 0, changed.stderr)
    const expected = convertOfficeImportRows(
      parseOfficeDelimitedBytes(sourceBytes, 'csv').values
    ).map((row) => [...row])
    expected[0]![0] = 'changed'
    const verifier = new OfficeImportWorkbookVerifier()
    await verifier.verify(binary!, artifacts[0]!.draftPath, 'Sheet1', expected)
    await verifier.verify(
      binary!,
      artifacts[1]!.draftPath,
      'Sheet1',
      convertOfficeImportRows(parseOfficeDelimitedBytes(sourceBytes, 'csv').values)
    )
    assert.equal(sha256(readFileSync(sourcePath)), sha256(sourceBytes))
  } finally {
    if (binary) {
      await Promise.all(
        artifacts.map((artifact) =>
          releaseTransientOfficeResident(binary, artifact.draftPath).catch(() => undefined)
        )
      )
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'real imported draft saves, reopens, saves as, and delivers a readable XLSX',
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-integration-lifecycle-'))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    const sourcePath = join(root, 'lifecycle.csv')
    const sourceBytes = Buffer.from('name,value\n中文,42\n')
    writeFileSync(sourcePath, sourceBytes)
    const service = createOfficeService()
    const outputs: string[] = []
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: realpathSync(root),
        permissionMode: 'auto'
      })
      const imported = await service.importDocument({
        requestId: 'import-lifecycle',
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root],
        format: 'csv'
      })
      if (imported.state !== 'ready') throw new Error('imported document did not become ready')
      assert.equal(imported.state, 'ready')
      const artifact = imported.document
      const reopened = await service.open({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: artifact.draftPath,
        allowRoots: [root]
      })
      if (reopened.state !== 'ready') throw new Error('imported document did not reopen')
      assert.equal(reopened.state, 'ready')
      assert.equal(reopened.document.artifactId, artifact.artifactId)
      const saved = await service.saveDocument(artifact.artifactId, session.sessionId)
      assert.equal(saved.saved, true)

      const saveAsPath = join(root, 'saved-import.xlsx')
      const saveAs = await service.saveAsDocument(
        artifact.artifactId,
        session.sessionId,
        realpathSync(root),
        saveAsPath
      )
      outputs.push(saveAsPath)
      assert.equal(saveAs.outputPath, 'saved-import.xlsx')

      const runId = 'import-delivery-run'
      service.bindRunTarget({
        runId,
        artifactId: artifact.artifactId,
        sessionId: session.sessionId,
        projectId: null
      })
      const delivered = await service.deliverDocument(
        runId,
        root,
        realpathSync(root),
        'imported-delivery',
        { operationId: 'import-delivery-operation' }
      )
      outputs.push(delivered.absolutePath)
      assert.equal(delivered.kind, 'xlsx')

      const expected = convertOfficeImportRows(parseOfficeDelimitedBytes(sourceBytes, 'csv').values)
      const verifier = new OfficeImportWorkbookVerifier()
      for (const output of outputs) {
        await verifier.verify(binary!, output, 'Sheet1', expected)
        await releaseTransientOfficeResident(binary!, output)
      }
      assert.equal(sha256(readFileSync(sourcePath)), sha256(sourceBytes))
    } finally {
      await service.dispose().catch(() => undefined)
      for (const output of outputs) {
        await releaseTransientOfficeResident(binary!, output).catch(() => undefined)
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  }
)
