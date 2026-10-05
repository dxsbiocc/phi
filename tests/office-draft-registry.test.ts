import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OfficeDraftRegistry } from '../src/main/agent/office/office-draft-registry'
import { createPhiSession } from '../src/main/agent/session/session-store'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function registerSourceDraft(
  sessionDir: string,
  sessionId: string,
  artifactId: string,
  sourcePath: string,
  projectId: string | null = null
): void {
  const artifactDir = join(sessionDir, 'artifacts', 'office', artifactId)
  const draftPath = join(artifactDir, 'book.xlsx')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(draftPath, `draft-${artifactId}`)
  writeFileSync(
    join(artifactDir, 'artifact.json'),
    JSON.stringify({
      artifactId,
      sessionId,
      projectId,
      sourcePath,
      sourceHash: sha256('source-v1'),
      draftPath
    })
  )
}

test('resolves a source symlink alias to the registered draft with the same source hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-draft-registry-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const projectRoot = join(root, 'project')
    const sourcePath = join(projectRoot, 'book.xlsx')
    const aliasPath = join(projectRoot, 'book-alias.xlsx')
    mkdirSync(projectRoot)
    writeFileSync(sourcePath, 'source-v1')
    symlinkSync(sourcePath, aliasPath)
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: projectRoot,
      cwdRealPath: projectRoot,
      permissionMode: 'ask'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'artifact-1')
    const draftPath = join(artifactDir, 'book.xlsx')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(draftPath, 'draft-with-unsaved-edits')
    writeFileSync(
      join(artifactDir, 'artifact.json'),
      JSON.stringify({
        artifactId: 'artifact-1',
        sessionId: session.sessionId,
        projectId: 'project-1',
        sourcePath,
        sourceHash: sha256('source-v1'),
        draftPath
      })
    )

    const result = await new OfficeDraftRegistry().resolve({
      sessionId: session.sessionId,
      projectId: 'project-1',
      sourcePath: aliasPath
    })

    assert.equal(result.kind, 'registered')
    if (result.kind !== 'registered') throw new Error('registered draft not found')
    assert.equal(result.artifact.artifactId, 'artifact-1')
    assert.equal(result.artifact.kind, 'xlsx')
    assert.equal(result.match, 'source')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports source_changed without modifying the previous draft when the source hash changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-draft-registry-changed-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'book.xlsx')
    writeFileSync(sourcePath, 'source-v2')
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'artifact-old')
    const draftPath = join(artifactDir, 'book.xlsx')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(draftPath, 'old-draft-content')
    writeFileSync(
      join(artifactDir, 'artifact.json'),
      JSON.stringify({
        artifactId: 'artifact-old',
        sessionId: session.sessionId,
        projectId: null,
        sourcePath,
        sourceHash: sha256('source-v1'),
        draftPath
      })
    )

    const result = await new OfficeDraftRegistry().resolve({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath
    })

    assert.equal(result.kind, 'source_changed')
    if (result.kind !== 'source_changed') throw new Error('source change not detected')
    assert.equal(result.previousArtifact.artifactId, 'artifact-old')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('skips corrupt registrations, caches a session scan, and never reuses another session draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-draft-registry-cache-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'book.xlsx')
    writeFileSync(sourcePath, 'source-v1')
    const first = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const second = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const corruptDir = join(first.dir, 'artifacts', 'office', 'corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'artifact.json'), '{broken')
    registerSourceDraft(second.dir, second.sessionId, 'other-session', sourcePath)
    const warnings: Readonly<Record<string, string>>[] = []
    const registry = new OfficeDraftRegistry({ warn: (metadata) => warnings.push(metadata) })

    assert.equal(
      (
        await registry.resolve({
          sessionId: first.sessionId,
          projectId: null,
          sourcePath
        })
      ).kind,
      'none'
    )
    registerSourceDraft(first.dir, first.sessionId, 'created-after-scan', sourcePath)
    assert.equal(
      (
        await registry.resolve({
          sessionId: first.sessionId,
          projectId: null,
          sourcePath
        })
      ).kind,
      'none'
    )
    registry.invalidate(first.sessionId)
    const refreshed = await registry.resolve({
      sessionId: first.sessionId,
      projectId: null,
      sourcePath
    })

    assert.equal(refreshed.kind, 'registered')
    if (refreshed.kind !== 'registered') throw new Error('draft not found after invalidation')
    assert.equal(refreshed.artifact.artifactId, 'created-after-scan')
    assert.equal(warnings.length, 2)
    assert.ok(warnings.every((warning) => !JSON.stringify(warning).includes(corruptDir)))
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a registered draft path when artifact kind and extension disagree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-draft-registry-kind-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'legacy-docx')
    const draftPath = join(artifactDir, 'legacy.docx')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(draftPath, 'docx')
    writeFileSync(
      join(artifactDir, 'artifact.json'),
      JSON.stringify({
        artifactId: 'legacy-docx',
        sessionId: session.sessionId,
        projectId: null,
        origin: 'blank',
        sourcePath: null,
        sourceHash: null,
        draftPath
      })
    )

    await assert.rejects(
      new OfficeDraftRegistry().resolve({
        sessionId: session.sessionId,
        projectId: null,
        sourcePath: draftPath,
        fresh: true
      }),
      { code: 'document_kind_mismatch' }
    )
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('restores an imported XLSX registration without requiring the CSV to be an Office file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-draft-registry-import-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'phi')
  try {
    const sourcePath = join(root, 'source.csv')
    const sourceBytes = 'name,value\n中文,42\n'
    writeFileSync(sourcePath, sourceBytes)
    const session = createPhiSession({
      kind: 'ordinary',
      cwd: root,
      cwdRealPath: root,
      permissionMode: 'auto'
    })
    const artifactDir = join(session.dir, 'artifacts', 'office', 'imported')
    const draftPath = join(artifactDir, 'source.xlsx')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(draftPath, 'xlsx')
    writeFileSync(
      join(artifactDir, 'artifact.json'),
      JSON.stringify({
        artifactId: 'imported',
        sessionId: session.sessionId,
        projectId: null,
        kind: 'xlsx',
        origin: 'import',
        sourcePath,
        sourceHash: sha256(sourceBytes),
        draftPath,
        importSource: {
          path: 'source.csv',
          format: 'csv',
          delimiter: ',',
          rows: 2,
          columns: 2,
          sha256: sha256(sourceBytes)
        }
      })
    )

    const result = await new OfficeDraftRegistry().resolve({
      sessionId: session.sessionId,
      projectId: null,
      sourcePath: draftPath
    })

    assert.equal(result.kind, 'registered')
    if (result.kind !== 'registered') throw new Error('imported draft not restored')
    assert.equal(result.artifact.origin, 'import')
    if (result.artifact.origin !== 'import') throw new Error('wrong artifact origin')
    assert.deepEqual(result.artifact.importSource, {
      path: 'source.csv',
      format: 'csv',
      delimiter: ',',
      rows: 2,
      columns: 2,
      sha256: sha256(sourceBytes)
    })
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
