import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateOfficeExportTarget } from '../src/main/agent/office/office-export-target'

test('export target accepts a new matching file inside a real project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-target-'))
  try {
    const target = join(root, '预算表-数据.csv')
    const validated = await validateOfficeExportTarget(root, target, 'csv')
    assert.equal(validated.projectRoot, root)
    assert.equal(validated.targetPath, target)
    assert.equal(validated.outputPath, '预算表-数据.csv')
    assert.equal(validated.fileName, '预算表-数据.csv')
    assert.equal(validated.realProjectRoot, await realpath(root))
    assert.equal(validated.realParentPath, await realpath(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('export target rejects existing, wrong-extension, outside, and private paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-target-errors-'))
  const outside = await mkdtemp(join(tmpdir(), 'office-export-outside-'))
  try {
    const existing = join(root, 'exists.tsv')
    await writeFile(existing, 'keep')
    await assert.rejects(validateOfficeExportTarget(root, existing, 'tsv'), {
      code: 'target_exists'
    })
    await assert.rejects(validateOfficeExportTarget(root, join(root, 'bad.tsv'), 'csv'), {
      code: 'invalid_extension'
    })
    await assert.rejects(validateOfficeExportTarget(root, join(outside, 'escape.csv'), 'csv'), {
      code: 'outside_project'
    })
    await assert.rejects(
      validateOfficeExportTarget(root, join(root, 'private.csv'), 'csv', async () => {
        throw new Error('private path details')
      }),
      { code: 'unsafe_path' }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('export target rejects symbolic-link targets and parent directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-target-symlink-'))
  const realDirectory = join(root, 'real')
  try {
    await mkdir(realDirectory)
    await writeFile(join(realDirectory, 'existing.csv'), 'keep')
    await symlink(join(realDirectory, 'existing.csv'), join(root, 'linked.csv'))
    await symlink(realDirectory, join(root, 'linked-dir'))

    await assert.rejects(validateOfficeExportTarget(root, join(root, 'linked.csv'), 'csv'), {
      code: 'unsafe_path'
    })
    await assert.rejects(
      validateOfficeExportTarget(root, join(root, 'linked-dir', 'new.csv'), 'csv'),
      { code: 'unsafe_path' }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('export target accepts the same project spelled through a symlinked alias and still rejects escapes', async () => {
  // macOS tmp is /var -> /private/var, and users keep projects under symlinked folders.
  const real = await mkdtemp(join(tmpdir(), 'office-export-real-'))
  const aliasParent = await mkdtemp(join(tmpdir(), 'office-export-alias-'))
  const outside = await mkdtemp(join(tmpdir(), 'office-export-alias-outside-'))
  try {
    const alias = join(aliasParent, 'project-link')
    await symlink(real, alias)

    const viaAlias = await validateOfficeExportTarget(real, join(alias, 'a.csv'), 'csv')
    assert.equal(viaAlias.outputPath, 'a.csv')
    const rootViaAlias = await validateOfficeExportTarget(alias, join(real, 'b.csv'), 'csv')
    assert.equal(rootViaAlias.outputPath, 'b.csv')

    await symlink(outside, join(real, 'escape'))
    await assert.rejects(validateOfficeExportTarget(real, join(alias, 'escape', 'x.csv'), 'csv'), {
      code: 'outside_project'
    })
  } finally {
    await Promise.all(
      [real, aliasParent, outside].map((path) => rm(path, { recursive: true, force: true }))
    )
  }
})
