import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import { verifySavedOfficeFile } from '../src/main/agent/office/office-save-verification'

function cliResult(value: unknown): OfficeCliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

test('saved file verification validates an unchanged non-empty regular file and returns its digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-verify-'))
  const draftPath = join(root, 'draft.xlsx')
  const bytes = Buffer.from('xlsx-package')
  const calls: readonly string[][] = []
  try {
    await writeFile(draftPath, bytes)
    const verified = await verifySavedOfficeFile(
      { binaryPath: '/officecli', draftPath },
      {
        run: async (_binaryPath, args) => {
          ;(calls as string[][]).push([...args])
          return cliResult({ success: true, data: { valid: true } })
        }
      }
    )

    assert.deepEqual(calls, [['validate', draftPath, '--json']])
    assert.deepEqual(verified, {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('saved file verification rejects warnings, empty files, and validation-time mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-verify-failure-'))
  try {
    const empty = join(root, 'empty.xlsx')
    await writeFile(empty, '')
    await assert.rejects(
      verifySavedOfficeFile(
        { binaryPath: '/officecli', draftPath: empty },
        { run: async () => cliResult({ success: true }) }
      ),
      { code: 'save_failed' }
    )

    const warned = join(root, 'warned.xlsx')
    await writeFile(warned, 'xlsx')
    await assert.rejects(
      verifySavedOfficeFile(
        { binaryPath: '/officecli', draftPath: warned },
        { run: async () => cliResult({ success: true, warnings: ['unsafe'] }) }
      ),
      { code: 'save_failed' }
    )

    const mutated = join(root, 'mutated.xlsx')
    await writeFile(mutated, 'before')
    await assert.rejects(
      verifySavedOfficeFile(
        { binaryPath: '/officecli', draftPath: mutated },
        {
          run: async () => {
            await writeFile(mutated, 'after')
            return cliResult({ success: true })
          }
        }
      ),
      { code: 'save_failed' }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validating a transient copy releases the resident that validate started, even when validation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-save-verify-release-'))
  const copyPath = join(root, 'copy.tmp.xlsx')
  try {
    await writeFile(copyPath, Buffer.from('xlsx-package'))
    for (const valid of [true, false]) {
      const released: string[] = []
      const attempt = verifySavedOfficeFile(
        { binaryPath: '/officecli', draftPath: copyPath },
        {
          run: async () => cliResult({ success: true, data: { valid } }),
          releaseResident: true,
          release: async (_binaryPath, path) => {
            released.push(path)
          }
        }
      )
      if (valid) await attempt
      else await assert.rejects(attempt)
      assert.deepEqual(released, [copyPath], `valid=${valid}`)
    }

    const untouched: string[] = []
    await verifySavedOfficeFile(
      { binaryPath: '/officecli', draftPath: copyPath },
      {
        run: async () => cliResult({ success: true, data: { valid: true } }),
        release: async (_binaryPath, path) => {
          untouched.push(path)
        }
      }
    )
    assert.deepEqual(untouched, [], 'the draft keeps its own resident')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
