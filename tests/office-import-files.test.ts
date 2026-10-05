import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { createPhiSession } from '../src/main/agent/session/session-store'
import { OFFICE_IMPORT_LIMITS } from '../src/main/agent/office/office-import-limits'
import {
  createImportedOfficeDraft,
  type OfficeImportWorkbookInput
} from '../src/main/agent/office/office-import-files'

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('Office imported draft files', () => {
  it('creates a private XLSX, records import metadata last, and preserves the source bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-files-'))
    const projectRoot = join(root, 'project')
    const sourcePath = join(projectRoot, '销售 数据.csv')
    const sourceBytes = Buffer.from('name,count,code\n中文,42,007\n', 'utf8')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    mkdirSync(projectRoot)
    writeFileSync(sourcePath, sourceBytes)
    try {
      const session = createPhiSession({
        kind: 'project',
        projectId: 'project-1',
        cwd: projectRoot,
        cwdRealPath: projectRoot,
        permissionMode: 'ask'
      })
      let imported: OfficeImportWorkbookInput | undefined
      const artifact = await createImportedOfficeDraft(
        {
          sessionId: session.sessionId,
          projectId: 'project-1',
          sourcePath,
          allowRoots: [projectRoot],
          format: 'csv'
        },
        {
          artifactId: () => 'import-1',
          importWorkbook: async (input) => {
            imported = input
            assert.equal(existsSync(join(dirname(input.draftPath), 'artifact.json')), false)
            writeFileSync(input.draftPath, 'xlsx bytes')
          },
          releaseWorkbook: async () => undefined
        }
      )

      assert.ok(imported)
      assert.equal(basename(artifact.draftPath), '销售 数据.xlsx')
      assert.deepEqual(imported.values, [
        ['name', 'count', 'code'],
        ['中文', 42, '007']
      ])
      assert.equal(artifact.origin, 'import')
      assert.equal(artifact.importSource.path, '销售 数据.csv')
      assert.deepEqual(artifact.importSource, {
        path: '销售 数据.csv',
        format: 'csv',
        delimiter: ',',
        rows: 2,
        columns: 3,
        sha256: sha256(sourceBytes)
      })
      assert.deepEqual(
        JSON.parse(readFileSync(join(dirname(artifact.draftPath), 'artifact.json'), 'utf8')),
        artifact
      )
      assert.deepEqual(readFileSync(sourcePath), sourceBytes)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects extension mismatches before creating an artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-extension-'))
    const sourcePath = join(root, 'source.csv')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    writeFileSync(sourcePath, 'a,b\n')
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      await assert.rejects(
        createImportedOfficeDraft(
          {
            sessionId: session.sessionId,
            projectId: null,
            sourcePath,
            allowRoots: [root],
            format: 'tsv'
          },
          {
            artifactId: () => 'bad-extension',
            importWorkbook: async () => assert.fail('must not import'),
            releaseWorkbook: async () => undefined
          }
        ),
        { code: 'invalid_extension' }
      )
      assert.equal(existsSync(join(session.dir, 'artifacts', 'office')), false)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('detects a source change during import and removes only its own partial artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-change-'))
    const sourcePath = join(root, 'source.tsv')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    writeFileSync(sourcePath, 'a\tb\n1\t2\n')
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      const unrelated = join(session.dir, 'artifacts', 'office', 'unrelated')
      mkdirSync(unrelated, { recursive: true })
      writeFileSync(join(unrelated, 'keep.txt'), 'keep')
      let released = false
      await assert.rejects(
        createImportedOfficeDraft(
          {
            sessionId: session.sessionId,
            projectId: null,
            sourcePath,
            allowRoots: [root],
            format: 'tsv'
          },
          {
            artifactId: () => 'changed',
            importWorkbook: async ({ draftPath }) => {
              writeFileSync(draftPath, 'xlsx bytes')
              writeFileSync(sourcePath, 'changed\n')
            },
            releaseWorkbook: async () => {
              released = true
            }
          }
        ),
        { code: 'source_changed_during_import' }
      )
      assert.equal(released, true)
      assert.equal(existsSync(join(session.dir, 'artifacts', 'office', 'changed')), false)
      assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'keep')
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds the second source read when the file grows during import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-growth-'))
    const sourcePath = join(root, 'source.csv')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    writeFileSync(sourcePath, 'a,b\n1,2\n')
    try {
      const session = createPhiSession({
        kind: 'ordinary',
        cwd: root,
        cwdRealPath: root,
        permissionMode: 'auto'
      })
      let released = false
      await assert.rejects(
        createImportedOfficeDraft(
          {
            sessionId: session.sessionId,
            projectId: null,
            sourcePath,
            allowRoots: [root],
            format: 'csv'
          },
          {
            artifactId: () => 'grown',
            importWorkbook: async ({ draftPath }) => {
              writeFileSync(draftPath, 'xlsx bytes')
              writeFileSync(sourcePath, Buffer.alloc(OFFICE_IMPORT_LIMITS.maxFileBytes + 1, 0x61))
            },
            releaseWorkbook: async () => {
              released = true
            }
          }
        ),
        { code: 'source_changed_during_import' }
      )
      assert.equal(released, true)
      assert.equal(existsSync(join(session.dir, 'artifacts', 'office', 'grown')), false)
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects symlink escape and Phi private draft sources before importing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-import-path-safety-'))
    const projectRoot = join(root, 'project')
    const outsideRoot = join(root, 'outside')
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
    mkdirSync(projectRoot)
    mkdirSync(outsideRoot)
    const outsideSource = join(outsideRoot, 'outside.csv')
    const alias = join(projectRoot, 'alias.csv')
    writeFileSync(outsideSource, 'a,b\n')
    symlinkSync(outsideSource, alias)
    try {
      const session = createPhiSession({
        kind: 'project',
        projectId: 'project-1',
        cwd: projectRoot,
        cwdRealPath: projectRoot,
        permissionMode: 'ask'
      })
      const privateDir = join(session.dir, 'artifacts', 'office', 'existing')
      const privateSource = join(privateDir, 'private.csv')
      mkdirSync(privateDir, { recursive: true })
      writeFileSync(privateSource, 'a,b\n')
      const dependency = {
        importWorkbook: async () => assert.fail('must not import'),
        releaseWorkbook: async () => undefined
      }

      await assert.rejects(
        createImportedOfficeDraft(
          {
            sessionId: session.sessionId,
            projectId: 'project-1',
            sourcePath: alias,
            allowRoots: [projectRoot],
            format: 'csv'
          },
          dependency
        ),
        { code: 'symlink_escape' }
      )
      await assert.rejects(
        createImportedOfficeDraft(
          {
            sessionId: session.sessionId,
            projectId: 'project-1',
            sourcePath: privateSource,
            allowRoots: [root],
            format: 'csv'
          },
          dependency
        ),
        { code: 'private_draft_path' }
      )
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })
})
