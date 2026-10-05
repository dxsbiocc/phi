import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createOfficeDelimitedOutput } from '../src/main/agent/office/office-export-output'

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

test('delimited output publishes verified bytes atomically and returns their digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-output-'))
  const targetPath = join(root, 'report.csv')
  const bytes = Buffer.from('a,"b,c"\n', 'utf8')
  try {
    const result = await createOfficeDelimitedOutput(
      { targetPath, bytes, signal: new AbortController().signal },
      (verification) => verification,
      { randomId: () => 'fixed' }
    )

    assert.deepEqual(result, { sha256: digest(bytes), size: bytes.length })
    assert.deepEqual(await readFile(targetPath), bytes)
    assert.deepEqual(await readdir(root), ['report.csv'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delimited output never overwrites an existing target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-output-existing-'))
  const targetPath = join(root, 'report.tsv')
  try {
    await writeFile(targetPath, 'keep')
    await assert.rejects(
      createOfficeDelimitedOutput(
        { targetPath, bytes: Buffer.from('new'), signal: new AbortController().signal },
        () => assert.fail('existing target must not be recorded')
      ),
      { code: 'target_exists' }
    )
    assert.equal(await readFile(targetPath, 'utf8'), 'keep')
    assert.deepEqual(await readdir(root), ['report.tsv'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delimited output cleans temp and final files when readback or recording fails', async () => {
  for (const phase of ['readback', 'record'] as const) {
    const root = await mkdtemp(join(tmpdir(), `office-export-output-${phase}-`))
    const targetPath = join(root, 'report.csv')
    try {
      await assert.rejects(
        createOfficeDelimitedOutput(
          { targetPath, bytes: Buffer.from('value'), signal: new AbortController().signal },
          () => {
            throw new Error('record failed')
          },
          phase === 'readback'
            ? { readFile: async () => Buffer.from('changed') as never }
            : undefined
        )
      )
      assert.deepEqual(await readdir(root), [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('delimited output cancellation leaves no files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-output-cancel-'))
  const targetPath = join(root, 'report.csv')
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      createOfficeDelimitedOutput(
        { targetPath, bytes: Buffer.from('value'), signal: controller.signal },
        () => assert.fail('cancelled output must not be recorded')
      ),
      { code: 'export_cancelled' }
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a final identity-check failure removes the file linked by this attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-output-lstat-'))
  const targetPath = join(root, 'report.csv')
  let failedFinalCheck = false
  try {
    await assert.rejects(
      createOfficeDelimitedOutput(
        {
          targetPath,
          bytes: Buffer.from('value'),
          signal: new AbortController().signal
        },
        () => assert.fail('unverified output must not be recorded'),
        {
          lstat: async (path) => {
            if (path === targetPath && !failedFinalCheck) {
              failedFinalCheck = true
              throw Object.assign(new Error('transient lstat failure'), { code: 'EIO' })
            }
            return lstat(path)
          }
        }
      )
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation immediately before commit removes the published file and skips the record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-export-output-late-cancel-'))
  const targetPath = join(root, 'report.csv')
  const controller = new AbortController()
  try {
    await assert.rejects(
      createOfficeDelimitedOutput(
        { targetPath, bytes: Buffer.from('value'), signal: controller.signal },
        () => assert.fail('cancelled output must not be recorded'),
        {
          rm: async (path, options) => {
            await rm(path, options)
            if (String(path).includes('.tmp')) controller.abort()
          }
        }
      ),
      { code: 'export_cancelled' }
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
