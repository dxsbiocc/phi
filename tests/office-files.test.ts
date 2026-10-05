import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createOfficeDraft,
  MAX_OFFICE_COLUMNS,
  MAX_OFFICE_FILE_BYTES,
  MAX_OFFICE_PARAGRAPHS,
  MAX_OFFICE_ROWS,
  MAX_OFFICE_SLIDES,
  OfficeFileError,
  type OfficeArtifact
} from '../src/main/agent/office/office-files'
import { createPhiSession } from '../src/main/agent/session/session-store'
import { OfficePptxPackageError } from '../src/main/agent/office/office-pptx-package'

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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

function assertStoredArtifact(
  artifact: OfficeArtifact,
  expected: OfficeArtifact,
  sourceBytes: Buffer
): void {
  assert.deepEqual(artifact, expected)
  assert.deepEqual(readFileSync(artifact.draftPath), sourceBytes)
  assert.deepEqual(
    JSON.parse(readFileSync(join(artifact.draftPath, '..', 'artifact.json'), 'utf8')),
    artifact
  )
  assert.equal(existsSync(artifact.draftPath), true)
}

test('copies an allowed local XLSX into session artifacts and records its identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const projectRoot = join(root, 'project')
    const sourcePath = join(projectRoot, 'source.xlsx')
    const sourceBytes = Buffer.from('small xlsx fixture')
    mkdirSync(projectRoot)
    writeFileSync(sourcePath, sourceBytes)
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: projectRoot, realPath: projectRoot },
      cwd: projectRoot,
      cwdRealPath: projectRoot,
      permissionMode: 'ask'
    })

    const artifact = await createOfficeDraft(
      {
        sessionId: session.sessionId,
        projectId: 'project-1',
        projectLocation: { kind: 'local', path: projectRoot, realPath: projectRoot },
        sourcePath,
        allowRoots: [projectRoot]
      },
      {
        artifactId: () => 'artifact-1',
        inspectWorkbook: async () => ({ rows: 2, columns: 3 })
      }
    )

    assertStoredArtifact(
      artifact,
      {
        artifactId: 'artifact-1',
        sessionId: session.sessionId,
        projectId: 'project-1',
        kind: 'xlsx',
        sourcePath,
        sourceHash: sha256(sourceBytes),
        draftPath: join(session.dir, 'artifacts', 'office', 'artifact-1', 'source.xlsx')
      },
      sourceBytes
    )
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('copies and inspects an allowed DOCX without using workbook dimensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-docx-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'source.DOCX')
    writeFileSync(sourcePath, 'small docx fixture')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    let inspectedKind: string | undefined

    const artifact = await createOfficeDraft(
      {
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      },
      {
        artifactId: () => 'artifact-docx',
        validatePackage: () => undefined,
        inspectDocument: async (_draftPath, kind) => {
          inspectedKind = kind
          return { paragraphs: 2, sampleTexts: ['中文第一段', '第二段'] }
        }
      }
    )

    assert.equal(artifact.kind, 'docx')
    assert.equal(inspectedKind, 'docx')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects and removes a DOCX above the paragraph limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-docx-paragraphs-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'large.docx')
    writeFileSync(sourcePath, 'unchanged docx')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'docx-too-large')

    const error = await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'docx-too-large',
          validatePackage: () => undefined,
          inspectDocument: async () => ({
            paragraphs: MAX_OFFICE_PARAGRAPHS + 1,
            sampleTexts: []
          })
        }
      ),
      'document_too_large'
    )

    assert.match(error.message, /5,000 段/u)
    assert.equal(existsSync(artifactDir), false)
    assert.equal(readFileSync(sourcePath, 'utf8'), 'unchanged docx')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a DOCX when view or validate inspection fails without leaving an artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-docx-validate-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'invalid.docx')
    writeFileSync(sourcePath, 'docx bytes')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'docx-invalid')

    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'docx-invalid',
          validatePackage: () => undefined,
          inspectDocument: async () => {
            throw new Error('/private/docx validate stderr')
          }
        }
      ),
      'inspection_failed'
    )

    assert.equal(existsSync(artifactDir), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('copies and inspects an allowed PPTX without using workbook or paragraph dimensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-pptx-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'source.PPTX')
    writeFileSync(sourcePath, 'small pptx fixture')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    let inspectedKind: string | undefined

    const artifact = await createOfficeDraft(
      {
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      },
      {
        artifactId: () => 'artifact-pptx',
        validatePackage: () => undefined,
        inspectDocument: async (_draftPath, kind) => {
          inspectedKind = kind
          return { slides: 3 }
        }
      }
    )

    assert.equal(artifact.kind, 'pptx')
    assert.equal(inspectedKind, 'pptx')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects and removes a PPTX above the slide limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-pptx-slides-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'large.pptx')
    writeFileSync(sourcePath, 'unchanged pptx')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'pptx-too-large')

    const error = await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'pptx-too-large',
          validatePackage: () => undefined,
          inspectDocument: async () => ({ slides: MAX_OFFICE_SLIDES + 1 })
        }
      ),
      'document_too_large'
    )

    assert.match(error.message, /200 张幻灯片/u)
    assert.equal(existsSync(artifactDir), false)
    assert.equal(readFileSync(sourcePath, 'utf8'), 'unchanged pptx')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports the PPTX package slide cap before creating an artifact directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-pptx-package-limit-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'large.pptx')
    writeFileSync(sourcePath, 'pptx package bytes')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'pptx-package-too-large')

    const error = await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'pptx-package-too-large',
          validatePackage: () => {
            throw new OfficePptxPackageError('too_many_slides', 'too many pptx slides')
          },
          inspectDocument: async () => ({ slides: 0 })
        }
      ),
      'document_too_large'
    )

    assert.match(error.message, /200 张幻灯片/u)
    assert.equal(existsSync(artifactDir), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an invalid XLSX package before creating an artifact directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-invalid-package-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'broken.xlsx')
    const sourceBytes = Buffer.from('not-a-zip')
    writeFileSync(sourcePath, sourceBytes)
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'invalid-package')

    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'invalid-package',
          validatePackage: () => {
            throw new Error('invalid zip')
          },
          inspectWorkbook: async () => ({ rows: 1, columns: 1 })
        }
      ),
      'inspection_failed'
    )
    assert.equal(existsSync(artifactDir), false)
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects remote SSH project files without attempting a local fallback', async () => {
  let inspected = false
  await assert.rejects(
    createOfficeDraft(
      {
        sessionId: 'session-1',
        projectId: 'remote-project',
        projectLocation: {
          kind: 'ssh',
          hostProfileId: 'host-1',
          remoteRoot: '/remote/project',
          canonicalRoot: '/remote/project'
        },
        sourcePath: '/remote/project/data.xlsx',
        allowRoots: ['/remote/project']
      },
      {
        inspectWorkbook: async () => {
          inspected = true
          return { rows: 1, columns: 1 }
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof OfficeFileError)
      assert.equal(error.code, 'remote_not_supported')
      assert.equal(error.message, '远程文件暂不支持 Office 实时预览')
      return true
    }
  )
  assert.equal(inspected, false)
})

test('rejects non-XLSX sources with a stable error code', async () => {
  const error = await expectOfficeError(
    createOfficeDraft(
      {
        sessionId: 'session-1',
        projectId: null,
        sourcePath: '/allowed/data.xls',
        allowRoots: ['/allowed']
      },
      { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
    ),
    'invalid_extension'
  )
  assert.match(error.message, /\.xlsx/)
})

test('reports a missing XLSX before attempting workbook inspection', async () => {
  let inspected = false
  await expectOfficeError(
    createOfficeDraft(
      {
        sessionId: 'session-1',
        projectId: null,
        sourcePath: '/allowed/missing.xlsx',
        allowRoots: ['/allowed']
      },
      {
        inspectWorkbook: async () => {
          inspected = true
          return { rows: 1, columns: 1 }
        }
      }
    ),
    'source_not_found'
  )
  assert.equal(inspected, false)
})

test('rejects a directory whose name ends in .xlsx', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-dir-'))
  const sourcePath = join(root, 'folder.xlsx')
  mkdirSync(sourcePath)
  try {
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: 'session-1',
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
      ),
      'source_not_file'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a local XLSX outside the existing local read allow-roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-roots-'))
  const allowed = join(root, 'allowed')
  const sourcePath = join(root, 'outside.xlsx')
  mkdirSync(allowed)
  writeFileSync(sourcePath, 'outside')
  try {
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: 'session-1',
          projectId: null,
          sourcePath,
          allowRoots: [allowed]
        },
        { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
      ),
      'source_not_allowed'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a symlink inside an allow-root when its real file escapes the root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-symlink-'))
  const allowed = join(root, 'allowed')
  const outside = join(root, 'outside.xlsx')
  const sourcePath = join(allowed, 'linked.xlsx')
  mkdirSync(allowed)
  writeFileSync(outside, 'outside')
  symlinkSync(outside, sourcePath)
  try {
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: 'session-1',
          projectId: null,
          sourcePath,
          allowRoots: [allowed]
        },
        { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
      ),
      'symlink_escape'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an XLSX above the byte limit before copying or inspecting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-large-'))
  const sourcePath = join(root, 'large.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, '')
  truncateSync(sourcePath, MAX_OFFICE_FILE_BYTES + 1)
  let inspected = false
  try {
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: 'session-1',
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          inspectWorkbook: async () => {
            inspected = true
            return { rows: 1, columns: 1 }
          }
        }
      ),
      'file_too_large'
    )
    assert.equal(inspected, false)
    assert.equal(existsSync(join(root, 'phi')), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects and removes a copied draft above the workbook row limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-rows-'))
  const projectRoot = join(root, 'project')
  const sourcePath = join(projectRoot, 'large-range.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  mkdirSync(projectRoot)
  writeFileSync(sourcePath, 'unchanged source')
  try {
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: projectRoot,
      cwdRealPath: projectRoot,
      permissionMode: 'ask'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'too-many-rows')
    const error = await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: 'project-1',
          sourcePath,
          allowRoots: [projectRoot]
        },
        {
          artifactId: () => 'too-many-rows',
          inspectWorkbook: async (draftPath) => {
            assert.equal(existsSync(draftPath), true)
            return { rows: MAX_OFFICE_ROWS + 1, columns: 1 }
          }
        }
      ),
      'workbook_too_large'
    )
    assert.match(error.message, /1,000.*100.*80,000/)
    assert.equal(existsSync(artifactDir), false)
    assert.equal(readFileSync(sourcePath, 'utf8'), 'unchanged source')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts a 1,000 by 80 workbook under the wider open admission limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-wide-admission-'))
  const sourcePath = join(root, 'wide.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'wide workbook')
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifact = await createOfficeDraft(
      {
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        allowRoots: [root]
      },
      {
        artifactId: () => 'wide-admission',
        inspectWorkbook: async () => ({ rows: 1_000, columns: 80 })
      }
    )

    assert.equal(existsSync(artifact.draftPath), true)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a workbook above the column limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-columns-'))
  const sourcePath = join(root, 'wide.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'wide workbook')
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'too-many-columns',
          inspectWorkbook: async () => ({ rows: 1, columns: MAX_OFFICE_COLUMNS + 1 })
        }
      ),
      'workbook_too_large'
    )
    assert.equal(existsSync(join(session.dir, 'artifacts', 'office', 'too-many-columns')), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a workbook above the 80,000-cell admission limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-cells-'))
  const sourcePath = join(root, 'dense.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'dense workbook')
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'too-many-cells',
          inspectWorkbook: async () => ({ rows: 801, columns: 100 })
        }
      ),
      'workbook_too_large'
    )
    assert.equal(existsSync(join(session.dir, 'artifacts', 'office', 'too-many-cells')), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not create artifacts for an unknown session identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-session-'))
  const sourcePath = join(root, 'source.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'xlsx')
  try {
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: 'missing-session',
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
      ),
      'session_not_found'
    )
    assert.equal(existsSync(join(root, 'phi')), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a project identity that does not match the session manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-identity-'))
  const sourcePath = join(root, 'source.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'xlsx')
  try {
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'ask'
    })
    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: 'project-2',
          sourcePath,
          allowRoots: [root]
        },
        { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
      ),
      'session_identity_mismatch'
    )
    assert.equal(existsSync(join(session.dir, 'artifacts', 'office')), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses the session manifest to reject SSH projects even when location is omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-remote-session-'))
  const sourcePath = join(root, 'source.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'xlsx')
  try {
    const session = createPhiSession({
      kind: 'project',
      projectId: 'remote-project',
      projectLocation: {
        kind: 'ssh',
        hostProfileId: 'host-1',
        remoteRoot: '/remote/project',
        canonicalRoot: '/remote/project'
      },
      cwd: '/remote/project',
      cwdRealPath: '/remote/project',
      permissionMode: 'ask'
    })
    const error = await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: 'remote-project',
          sourcePath,
          allowRoots: [root]
        },
        { inspectWorkbook: async () => ({ rows: 1, columns: 1 }) }
      ),
      'remote_not_supported'
    )
    assert.equal(error.message, '远程文件暂不支持 Office 实时预览')
    assert.equal(existsSync(join(session.dir, 'artifacts', 'office')), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('an artifact id collision never overwrites or removes an existing artifact directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-files-collision-'))
  const sourcePath = join(root, 'source.xlsx')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  writeFileSync(sourcePath, 'xlsx')
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'collision')
    const markerPath = join(artifactDir, 'existing.txt')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(markerPath, 'keep me')
    let inspected = false

    await expectOfficeError(
      createOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: null,
          sourcePath,
          allowRoots: [root]
        },
        {
          artifactId: () => 'collision',
          inspectWorkbook: async () => {
            inspected = true
            return { rows: 1, columns: 1 }
          }
        }
      ),
      'copy_failed'
    )
    assert.equal(inspected, false)
    assert.equal(readFileSync(markerPath, 'utf8'), 'keep me')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
