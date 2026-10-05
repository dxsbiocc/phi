import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePresentedFileOpenPath } from '../src/renderer/src/features/chat/lib/presentedOfficeFile'

const officeFile = {
  path: '/project/report.docx',
  displayPath: 'report.docx',
  bytes: 10,
  office: {
    artifactId: 'artifact-1',
    outputId: 'output-1',
    kind: 'docx' as const,
    revision: 2,
    sha256: 'a'.repeat(64),
    warnings: [],
    checks: { schema: 'passed' as const, content: 'passed' as const, samples: 1 }
  }
}

test('Office delivery cards resolve the recorded output before opening it', async () => {
  const inputs: unknown[] = []
  const path = await resolvePresentedFileOpenPath(officeFile, async (input) => {
    inputs.push(input)
    return { ok: true, value: { path: '/project/report.docx' } }
  })

  assert.equal(path, '/project/report.docx')
  assert.deepEqual(inputs, [{ artifactId: 'artifact-1', outputId: 'output-1' }])
})

test('Office delivery cards report a changed or missing output instead of opening it', async () => {
  await assert.rejects(
    resolvePresentedFileOpenPath(officeFile, async () => ({
      ok: false,
      error: { code: 'output_hash_mismatch', message: 'Office 输出已被更改，交付入口已失效' }
    })),
    /已被更改.*失效/u
  )
})

test('non-Office delivery cards keep the existing direct-open behavior', async () => {
  assert.equal(
    await resolvePresentedFileOpenPath({
      path: '/project/report.pdf',
      displayPath: 'report.pdf',
      bytes: 10
    }),
    '/project/report.pdf'
  )
})
