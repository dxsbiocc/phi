import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertOfficeSourcePathIsNotPrivate,
  createBlankOfficeDraft,
  createOfficeDraft,
  loadRegisteredBlankOfficeDraft,
  OfficeFileError,
  removeBlankOfficeDraft,
  validateRegisteredOfficeDraft
} from '../src/main/agent/office/office-files'
import { createPhiSession, type PhiSessionRecord } from '../src/main/agent/session/session-store'

async function expectOfficeError(
  promise: Promise<unknown>,
  code: InstanceType<typeof OfficeFileError>['code']
): Promise<OfficeFileError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof OfficeFileError)
  assert.equal(caught.code, code)
  return caught
}

async function withOrdinarySession(
  prefix: string,
  run: (root: string, session: PhiSessionRecord) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    await run(root, session)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
}

function invalidName(name: string): Promise<OfficeFileError> {
  return expectOfficeError(
    createBlankOfficeDraft(
      { sessionId: 'missing-session', projectId: null, name },
      { createWorkbook: async () => undefined }
    ),
    'invalid_name'
  )
}

test('creates a blank XLSX in its own session artifact directory and records blank identity', () =>
  withOrdinarySession('office-files-blank-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null, name: '预算草稿' },
      {
        artifactId: () => 'blank-1',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )

    assert.deepEqual(artifact, {
      artifactId: 'blank-1',
      sessionId: session.sessionId,
      projectId: null,
      kind: 'xlsx',
      origin: 'blank',
      sourcePath: null,
      sourceHash: null,
      draftPath: join(session.dir, 'artifacts', 'office', 'blank-1', '预算草稿.xlsx')
    })
    assert.equal(readFileSync(artifact.draftPath, 'utf8'), 'blank workbook')
    assert.deepEqual(
      JSON.parse(readFileSync(join(artifact.draftPath, '..', 'artifact.json'), 'utf8')),
      artifact
    )
  }))

test('creates a blank DOCX with a kind-specific default name and identity', () =>
  withOrdinarySession('office-files-blank-docx-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null, kind: 'docx' },
      {
        artifactId: () => 'blank-docx',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank document')
      }
    )

    assert.equal(artifact.kind, 'docx')
    assert.equal(
      artifact.draftPath,
      join(session.dir, 'artifacts', 'office', 'blank-docx', '未命名文档.docx')
    )
    assert.equal(
      JSON.parse(readFileSync(join(artifact.draftPath, '..', 'artifact.json'), 'utf8')).kind,
      'docx'
    )
  }))

test('creates a blank PPTX with a kind-specific default name and identity', () =>
  withOrdinarySession('office-files-blank-pptx-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null, kind: 'pptx' },
      {
        artifactId: () => 'blank-pptx',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank presentation')
      }
    )

    assert.equal(artifact.kind, 'pptx')
    assert.equal(
      artifact.draftPath,
      join(session.dir, 'artifacts', 'office', 'blank-pptx', '未命名演示文稿.pptx')
    )
    assert.equal(
      JSON.parse(readFileSync(join(artifact.draftPath, '..', 'artifact.json'), 'utf8')).kind,
      'pptx'
    )
  }))

test('rejects a blank document name whose Office extension conflicts with kind', () =>
  withOrdinarySession('office-files-blank-kind-mismatch-', async (_root, session) => {
    const error = await expectOfficeError(
      createBlankOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          kind: 'docx',
          name: '错误类型.xlsx'
        },
        { createWorkbook: async () => undefined }
      ),
      'invalid_extension'
    )
    assert.match(error.message, /\.docx/u)
  }))

test('rejects a blank presentation name whose Office extension conflicts with kind', () =>
  withOrdinarySession('office-files-blank-pptx-kind-mismatch-', async (_root, session) => {
    const error = await expectOfficeError(
      createBlankOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          kind: 'pptx',
          name: '错误类型.docx'
        },
        { createWorkbook: async () => undefined }
      ),
      'invalid_extension'
    )
    assert.match(error.message, /\.pptx/u)
  }))

test('rejects a blank workbook name carrying the pptx extension', () =>
  withOrdinarySession('office-files-blank-xlsx-pptx-mismatch-', async (_root, session) => {
    const error = await expectOfficeError(
      createBlankOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          kind: 'xlsx',
          name: '错误类型.pptx'
        },
        { createWorkbook: async () => undefined }
      ),
      'invalid_extension'
    )
    assert.match(error.message, /\.xlsx/u)
  }))

test('rejects an explicitly empty blank workbook name', async () => {
  const error = await invalidName('   ')
  assert.match(error.message, /名称/)
})

test('rejects a blank workbook name longer than 64 characters', async () => {
  await invalidName('a'.repeat(65))
})

test('rejects path separators in blank workbook names', async (t) => {
  for (const name of ['folder/book', 'folder\\book']) {
    await t.test(name, () => invalidName(name))
  }
})

test('rejects control characters in blank workbook names', async (t) => {
  for (const name of ['book\0name', 'book\nname', 'book\u007fname', 'book\u0085name']) {
    await t.test(JSON.stringify(name), () => invalidName(name))
  }
})

test('rejects parent-directory tokens in blank workbook names', async () => {
  await invalidName('book..draft')
})

test('a blank artifact directory collision preserves existing content without calling create', () =>
  withOrdinarySession('office-files-blank-collision-', async (_root, session) => {
    const artifactDir = join(session.dir, 'artifacts', 'office', 'collision')
    const markerPath = join(artifactDir, 'existing.txt')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(markerPath, 'keep me')
    let created = false

    await expectOfficeError(
      createBlankOfficeDraft(
        { sessionId: session.sessionId, projectId: null },
        {
          artifactId: () => 'collision',
          createWorkbook: async () => {
            created = true
          }
        }
      ),
      'artifact_exists'
    )
    assert.equal(created, false)
    assert.equal(readFileSync(markerPath, 'utf8'), 'keep me')
  }))

test('a failed OfficeCLI create removes its partial artifact directory and returns a stable code', () =>
  withOrdinarySession('office-files-blank-failure-', async (_root, session) => {
    const artifactDir = join(session.dir, 'artifacts', 'office', 'failed-create')
    const error = await expectOfficeError(
      createBlankOfficeDraft(
        { sessionId: session.sessionId, projectId: null },
        {
          artifactId: () => 'failed-create',
          createWorkbook: async (draftPath) => {
            writeFileSync(draftPath, 'partial workbook')
            throw new Error('file_exists: target already exists')
          }
        }
      ),
      'create_failed'
    )

    assert.match(error.message, /创建/)
    assert.equal(existsSync(artifactDir), false)
  }))

test('removes only the directory owned by a blank artifact', () =>
  withOrdinarySession('office-files-blank-remove-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'remove-me',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )
    const artifactDir = join(session.dir, 'artifacts', 'office', artifact.artifactId)

    await removeBlankOfficeDraft(artifact)

    assert.equal(existsSync(artifactDir), false)
  }))

test('refuses a forged blank cleanup path without deleting it', () =>
  withOrdinarySession('office-files-blank-remove-forged-', async (root, session) => {
    const victimDir = join(root, 'victim')
    const victimPath = join(victimDir, 'keep.xlsx')
    mkdirSync(victimDir)
    writeFileSync(victimPath, 'keep me')

    await expectOfficeError(
      removeBlankOfficeDraft({
        artifactId: 'forged',
        sessionId: session.sessionId,
        projectId: null,
        origin: 'blank',
        sourcePath: null,
        sourceHash: null,
        draftPath: victimPath
      }),
      'cleanup_path_mismatch'
    )
    assert.equal(readFileSync(victimPath, 'utf8'), 'keep me')
  }))

test('validates the real path of an existing registered blank draft', () =>
  withOrdinarySession('office-files-blank-validate-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'registered',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )

    assert.equal(
      await validateRegisteredOfficeDraft(artifact, session.sessionId),
      realpathSync(artifact.draftPath)
    )
  }))

test('loads a registered blank draft identity from its artifact directory', () =>
  withOrdinarySession('office-files-blank-load-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null, name: '恢复草稿' },
      {
        artifactId: () => 'registered-restart',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )

    assert.deepEqual(
      await loadRegisteredBlankOfficeDraft({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: artifact.draftPath,
        allowRoots: [session.dir]
      }),
      artifact
    )
  }))

test('rejects a registered draft replaced by a symlink', () =>
  withOrdinarySession('office-files-blank-symlink-', async (root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'registered',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )
    const outside = join(root, 'outside.xlsx')
    writeFileSync(outside, 'outside')
    rmSync(artifact.draftPath)
    symlinkSync(outside, artifact.draftPath)

    await expectOfficeError(
      validateRegisteredOfficeDraft(artifact, session.sessionId),
      'draft_symlink'
    )
  }))

test('rejects a registered draft when it is presented as another session artifact', () =>
  withOrdinarySession('office-files-registered-other-session-', async (root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'registered',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )
    const other = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })

    await expectOfficeError(
      validateRegisteredOfficeDraft(artifact, other.sessionId),
      'session_identity_mismatch'
    )
  }))

test('rejects an unregistered open of a session-private Office draft path', () =>
  withOrdinarySession('office-files-private-direct-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'private',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )

    await expectOfficeError(
      assertOfficeSourcePathIsNotPrivate(artifact.draftPath),
      'private_draft_path'
    )
  }))

test('the source-copy path cannot make a copy of a private draft', () =>
  withOrdinarySession('office-files-private-copy-', async (_root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'private',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )

    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath: artifact.draftPath,
          allowRoots: [session.dir]
        },
        {
          artifactId: () => 'copy-of-copy',
          inspectWorkbook: async () => ({ rows: 0, columns: 0 })
        }
      ),
      'private_draft_path'
    )
  }))

test('rejects an unregistered open of another session private draft', () =>
  withOrdinarySession('office-files-private-other-session-', async (root) => {
    const other = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifact = await createBlankOfficeDraft(
      { sessionId: other.sessionId, projectId: null },
      {
        artifactId: () => 'other-private',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )

    await expectOfficeError(
      assertOfficeSourcePathIsNotPrivate(artifact.draftPath),
      'private_draft_path'
    )
  }))

test('rejects an external symlink that resolves to a private Office draft', () =>
  withOrdinarySession('office-files-private-realpath-', async (root, session) => {
    const artifact = await createBlankOfficeDraft(
      { sessionId: session.sessionId, projectId: null },
      {
        artifactId: () => 'private',
        createWorkbook: async (draftPath) => writeFileSync(draftPath, 'blank workbook')
      }
    )
    const aliasPath = join(root, 'apparently-external.xlsx')
    symlinkSync(artifact.draftPath, aliasPath)

    await expectOfficeError(assertOfficeSourcePathIsNotPrivate(aliasPath), 'private_draft_path')
  }))

test('allows an ordinary source path outside Phi session artifacts', () =>
  withOrdinarySession('office-files-public-source-', async (root) => {
    const sourcePath = join(root, 'source.xlsx')
    writeFileSync(sourcePath, 'source workbook')

    await assertOfficeSourcePathIsNotPrivate(sourcePath)
  }))
