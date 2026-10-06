import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateOfficeSaveAsTarget } from '../src/main/agent/office/office-save-as-target'
import { createImmutableOfficeOutput } from '../src/main/agent/office/office-save-as-copy'
import { chooseOfficeSaveAsTarget } from '../src/main/agent/office/office-save-as-dialog'

test('save-as target accepts only a new sanitized xlsx inside the real project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-target-'))
  const outside = await mkdtemp(join(tmpdir(), 'office-save-as-outside-'))
  try {
    await mkdir(join(root, 'outputs'))
    assert.deepEqual(await validateOfficeSaveAsTarget(root, join(root, 'outputs', '报告.xlsx')), {
      projectRoot: root,
      targetPath: join(root, 'outputs', '报告.xlsx'),
      outputPath: 'outputs/报告.xlsx',
      fileName: '报告.xlsx'
    })

    await assert.rejects(validateOfficeSaveAsTarget(root, join(outside, 'escape.xlsx')), {
      code: 'outside_project'
    })
    await assert.rejects(validateOfficeSaveAsTarget(root, 'relative.xlsx'), {
      code: 'outside_project'
    })
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, 'report.csv')), {
      code: 'invalid_extension'
    })
    await writeFile(join(root, 'existing.xlsx'), 'keep')
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, 'existing.xlsx')), {
      code: 'target_exists'
    })

    await symlink(outside, join(root, 'linked'))
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, 'linked', 'escape.xlsx')), {
      code: 'outside_project'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('save-as target extension must match the document kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-kind-'))
  try {
    assert.equal(
      (await validateOfficeSaveAsTarget(root, join(root, '报告.docx'), 'docx')).fileName,
      '报告.docx'
    )
    assert.equal(
      (await validateOfficeSaveAsTarget(root, join(root, '演示.pptx'), 'pptx')).fileName,
      '演示.pptx'
    )
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, '报告.xlsx'), 'docx'), {
      code: 'invalid_extension'
    })
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, '报告.docx'), 'xlsx'), {
      code: 'invalid_extension'
    })
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, '报告.docx'), 'pptx'), {
      code: 'invalid_extension'
    })
    await assert.rejects(validateOfficeSaveAsTarget(root, join(root, '演示.pptx'), 'docx'), {
      code: 'invalid_extension'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('immutable output uses an atomic no-overwrite link and cleans temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-copy-'))
  const sourcePath = join(root, 'draft.xlsx')
  const targetPath = join(root, 'output.xlsx')
  const bytes = Buffer.from('immutable-xlsx')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  try {
    await writeFile(sourcePath, bytes)
    const committed = await createImmutableOfficeOutput(
      {
        binaryPath: '/officecli',
        sourcePath,
        targetPath,
        expectedSha256: sha256,
        signal: new AbortController().signal
      },
      async (verification) => ({ ...verification, recorded: true }),
      {
        verifyFile: async (path) => {
          assert.notEqual(path, targetPath)
          return { sha256, size: bytes.length }
        }
      }
    )

    assert.deepEqual(committed, { sha256, size: bytes.length, recorded: true })
    assert.deepEqual(await readFile(targetPath), bytes)
    assert.deepEqual((await readdir(root)).sort(), ['draft.xlsx', 'output.xlsx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a target created during the final link wins and is never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-race-'))
  const sourcePath = join(root, 'draft.xlsx')
  const targetPath = join(root, 'output.xlsx')
  const bytes = Buffer.from('draft')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  try {
    await writeFile(sourcePath, bytes)
    await assert.rejects(
      createImmutableOfficeOutput(
        {
          binaryPath: '/officecli',
          sourcePath,
          targetPath,
          expectedSha256: sha256,
          signal: new AbortController().signal
        },
        async () => undefined,
        {
          verifyFile: async () => ({ sha256, size: bytes.length }),
          link: async () => {
            await writeFile(targetPath, 'racer', { flag: 'wx' })
            throw Object.assign(new Error('exists'), { code: 'EEXIST' })
          }
        }
      ),
      { code: 'target_exists' }
    )
    assert.equal(await readFile(targetPath, 'utf8'), 'racer')
    assert.deepEqual((await readdir(root)).sort(), ['draft.xlsx', 'output.xlsx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('save-as target selection restricts smoke injection to unpackaged test hooks', async () => {
  let dialogs = 0
  const cancelled = await chooseOfficeSaveAsTarget(
    { projectRoot: '/project', fileName: 'report.xlsx' },
    {
      testHooksEnabled: true,
      isPackaged: false,
      smokePath: undefined,
      getWindow: () => undefined,
      showSaveDialog: async (_window, options) => {
        dialogs += 1
        assert.equal(options.defaultPath, '/project/report.xlsx')
        return { canceled: true }
      }
    }
  )
  assert.equal(cancelled, null)

  const injected = await chooseOfficeSaveAsTarget(
    { projectRoot: '/project', fileName: 'report.xlsx' },
    {
      testHooksEnabled: true,
      isPackaged: false,
      smokePath: '/project/smoke.xlsx',
      getWindow: () => undefined,
      showSaveDialog: async () => {
        throw new Error('must not open')
      }
    }
  )
  assert.equal(injected, '/project/smoke.xlsx')

  for (const gate of [
    { testHooksEnabled: false, isPackaged: false },
    { testHooksEnabled: true, isPackaged: true }
  ]) {
    const ignored = await chooseOfficeSaveAsTarget(
      { projectRoot: '/project', fileName: 'report.xlsx' },
      {
        ...gate,
        smokePath: '/project/must-be-ignored.xlsx',
        getWindow: () => undefined,
        showSaveDialog: async () => ({ canceled: false, filePath: '/project/dialog.xlsx' })
      }
    )
    assert.equal(ignored, '/project/dialog.xlsx')
  }

  const destroyed = {
    isDestroyed: () => true,
    get webContents(): never {
      throw new Error('Object has been destroyed')
    }
  }
  await chooseOfficeSaveAsTarget(
    { projectRoot: '/project', fileName: 'report.xlsx' },
    {
      testHooksEnabled: true,
      isPackaged: false,
      getWindow: () => destroyed,
      showSaveDialog: async (window) => {
        assert.equal(window, undefined)
        return { canceled: true }
      }
    }
  )
  assert.equal(dialogs, 1)
})

test('save-as dialog title and filter match the document kind', async () => {
  await chooseOfficeSaveAsTarget(
    { projectRoot: '/project', fileName: '报告.docx', kind: 'docx' },
    {
      testHooksEnabled: true,
      isPackaged: false,
      getWindow: () => undefined,
      showSaveDialog: async (_window, options) => {
        assert.equal(options.title, '另存为 DOCX')
        assert.equal(options.defaultPath, '/project/报告.docx')
        assert.deepEqual(options.filters, [{ name: 'Word 文档', extensions: ['docx'] }])
        return { canceled: true }
      }
    }
  )
  await chooseOfficeSaveAsTarget(
    { projectRoot: '/project', fileName: '演示.pptx', kind: 'pptx' },
    {
      testHooksEnabled: true,
      isPackaged: false,
      getWindow: () => undefined,
      showSaveDialog: async (_window, options) => {
        assert.equal(options.title, '另存为 PPTX')
        assert.equal(options.defaultPath, '/project/演示.pptx')
        assert.deepEqual(options.filters, [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }])
        return { canceled: true }
      }
    }
  )
})

test('docx immutable output uses a docx temporary suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-docx-copy-'))
  const sourcePath = join(root, 'draft.docx')
  const targetPath = join(root, 'output.docx')
  const bytes = Buffer.from('immutable-docx')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  try {
    await writeFile(sourcePath, bytes)
    await createImmutableOfficeOutput(
      {
        binaryPath: '/officecli',
        kind: 'docx',
        sourcePath,
        targetPath,
        expectedSha256: sha256,
        signal: new AbortController().signal
      },
      async () => undefined,
      {
        randomId: () => 'docx-test',
        verifyFile: async (path) => {
          assert.match(path, /\.tmp\.docx$/u)
          return { sha256, size: bytes.length }
        }
      }
    )
    assert.deepEqual((await readdir(root)).sort(), ['draft.docx', 'output.docx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pptx immutable output uses a pptx temporary suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-pptx-copy-'))
  const sourcePath = join(root, 'draft.pptx')
  const targetPath = join(root, 'output.pptx')
  const bytes = Buffer.from('immutable-pptx')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  try {
    await writeFile(sourcePath, bytes)
    await createImmutableOfficeOutput(
      {
        binaryPath: '/officecli',
        kind: 'pptx',
        sourcePath,
        targetPath,
        expectedSha256: sha256,
        signal: new AbortController().signal
      },
      async () => undefined,
      {
        randomId: () => 'pptx-test',
        verifyFile: async (path) => {
          assert.match(path, /\.tmp\.pptx$/u)
          return { sha256, size: bytes.length }
        }
      }
    )
    assert.deepEqual((await readdir(root)).sort(), ['draft.pptx', 'output.pptx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('copy verification and output-record failures remove both temporary and final files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-cleanup-'))
  const sourcePath = join(root, 'draft.xlsx')
  const bytes = Buffer.from('draft')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  try {
    await writeFile(sourcePath, bytes)
    const verificationTarget = join(root, 'verification-failed.xlsx')
    await assert.rejects(
      createImmutableOfficeOutput(
        {
          binaryPath: '/officecli',
          sourcePath,
          targetPath: verificationTarget,
          expectedSha256: sha256,
          signal: new AbortController().signal
        },
        async () => undefined,
        { verifyFile: async () => ({ sha256: 'f'.repeat(64), size: bytes.length }) }
      ),
      { code: 'copy_verification_failed' }
    )

    const recordTarget = join(root, 'record-failed.xlsx')
    await assert.rejects(
      createImmutableOfficeOutput(
        {
          binaryPath: '/officecli',
          sourcePath,
          targetPath: recordTarget,
          expectedSha256: sha256,
          signal: new AbortController().signal
        },
        async () => {
          throw new Error('record failed')
        },
        { verifyFile: async () => ({ sha256, size: bytes.length }) }
      ),
      { code: 'copy_failed' }
    )
    assert.deepEqual(await readdir(root), ['draft.xlsx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an aborted output transaction writes no target or temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-abort-'))
  const sourcePath = join(root, 'draft.xlsx')
  const targetPath = join(root, 'aborted.xlsx')
  const bytes = Buffer.from('draft')
  const controller = new AbortController()
  controller.abort()
  try {
    await writeFile(sourcePath, bytes)
    await assert.rejects(
      createImmutableOfficeOutput(
        {
          binaryPath: '/officecli',
          sourcePath,
          targetPath,
          expectedSha256: createHash('sha256').update(bytes).digest('hex'),
          signal: controller.signal
        },
        async () => undefined
      ),
      { code: 'save_as_cancelled' }
    )
    assert.deepEqual(await readdir(root), ['draft.xlsx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unwritable output directory reports permission denied without a partial file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-as-permission-'))
  const sourcePath = join(root, 'draft.xlsx')
  const targetPath = join(root, 'denied.xlsx')
  const bytes = Buffer.from('draft')
  try {
    await writeFile(sourcePath, bytes)
    await assert.rejects(
      createImmutableOfficeOutput(
        {
          binaryPath: '/officecli',
          sourcePath,
          targetPath,
          expectedSha256: createHash('sha256').update(bytes).digest('hex'),
          signal: new AbortController().signal
        },
        async () => undefined,
        {
          writeFile: async () => {
            throw Object.assign(new Error('denied'), { code: 'EACCES' })
          }
        }
      ),
      { code: 'permission_denied' }
    )
    assert.deepEqual(await readdir(root), ['draft.xlsx'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('save-as accepts the same project reached through a symlinked alias and still rejects escapes', async () => {
  // macOS tmp is /var -> /private/var, and users keep projects under symlinked folders: the
  // dialog may hand back either spelling of the same directory.
  const real = await mkdtemp(join(tmpdir(), 'office-save-as-real-'))
  const aliasParent = await mkdtemp(join(tmpdir(), 'office-save-as-alias-'))
  const outside = await mkdtemp(join(tmpdir(), 'office-save-as-outside-'))
  try {
    await mkdir(join(real, 'outputs'))
    const alias = join(aliasParent, 'project-link')
    await symlink(real, alias)

    const viaAlias = await validateOfficeSaveAsTarget(real, join(alias, 'outputs', 'a.xlsx'))
    assert.equal(viaAlias.outputPath, 'outputs/a.xlsx')
    const rootViaAlias = await validateOfficeSaveAsTarget(alias, join(real, 'outputs', 'b.xlsx'))
    assert.equal(rootViaAlias.outputPath, 'outputs/b.xlsx')

    await symlink(outside, join(real, 'escape'))
    await assert.rejects(validateOfficeSaveAsTarget(real, join(alias, 'escape', 'x.xlsx')), {
      code: 'outside_project'
    })
    await assert.rejects(
      validateOfficeSaveAsTarget(real, join(real, 'outputs', '..', '..', 'x.xlsx')),
      {
        code: 'outside_project'
      }
    )
  } finally {
    await Promise.all(
      [real, aliasParent, outside].map((path) => rm(path, { recursive: true, force: true }))
    )
  }
})
