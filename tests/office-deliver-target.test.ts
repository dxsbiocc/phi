import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertOfficeDeliveryTargetMissing,
  resolveOfficeDeliveryTarget,
  type ResolvedOfficeDeliveryTarget
} from '../src/main/agent/office/office-deliver-target'

test('delivery targets are cwd-local new files with an extension fixed by document kind', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'office-deliver-target-'))
  const cwdRealPath = await realpath(cwd)
  try {
    const target = await resolveOfficeDeliveryTarget({
      cwd,
      cwdRealPath,
      draftPath: '/private/draft.xlsx',
      kind: 'xlsx',
      operationId: 'tool-call-1',
      outputName: '报告',
      assertNotPrivate: async () => undefined
    })
    assert.equal(target.absolutePath, join(cwdRealPath, '报告.xlsx'))
    assert.equal(target.exists, false)
    assertOfficeDeliveryTargetMissing(target)

    await writeFile(target.absolutePath, 'keep')
    const existing = await resolveOfficeDeliveryTarget({
      cwd,
      cwdRealPath,
      draftPath: '/private/draft.xlsx',
      kind: 'xlsx',
      operationId: 'tool-call-2',
      outputName: '报告.xlsx',
      assertNotPrivate: async () => undefined
    })
    assert.throws(() => assertOfficeDeliveryTargetMissing(existing), { code: 'target_exists' })
    await assert.rejects(
      resolveOfficeDeliveryTarget({
        cwd,
        cwdRealPath,
        draftPath: '/private/draft.xlsx',
        kind: 'xlsx',
        operationId: 'tool-call-3',
        outputName: '报告.docx',
        assertNotPrivate: async () => undefined
      }),
      { code: 'invalid_extension' }
    )
    await assert.rejects(
      resolveOfficeDeliveryTarget({
        cwd,
        cwdRealPath,
        draftPath: '/private/draft.xlsx',
        kind: 'xlsx',
        operationId: 'tool-call-4',
        outputName: '../逃逸',
        assertNotPrivate: async () => undefined
      }),
      { code: 'invalid_name' }
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delivery rejects cwd aliases, mismatched real cwd, private roots, and symlink targets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'office-deliver-symlink-'))
  const cwd = join(parent, 'cwd')
  const alias = join(parent, 'cwd-alias')
  const other = await mkdtemp(join(tmpdir(), 'office-deliver-other-'))
  try {
    await mkdir(cwd)
    const cwdRealPath = await realpath(cwd)
    await symlink(cwd, alias)
    await assert.rejects(deliveryTarget(alias, cwdRealPath), { code: 'outside_project' })
    await assert.rejects(deliveryTarget(cwd, await realpath(other)), {
      code: 'outside_project'
    })
    await assert.rejects(
      deliveryTarget(cwd, cwdRealPath, async () => {
        throw new Error('private draft root')
      }),
      { code: 'unsafe_path' }
    )
    await symlink(join(cwd, 'missing.xlsx'), join(cwd, 'output.xlsx'))
    await assert.rejects(deliveryTarget(cwd, cwdRealPath), { code: 'unsafe_path' })
  } finally {
    await rm(parent, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

function deliveryTarget(
  cwd: string,
  cwdRealPath: string,
  assertNotPrivate: (path: string) => Promise<void> = async () => undefined
): Promise<ResolvedOfficeDeliveryTarget> {
  return resolveOfficeDeliveryTarget({
    cwd,
    cwdRealPath,
    draftPath: '/private/draft.xlsx',
    kind: 'xlsx',
    operationId: 'tool-call',
    outputName: 'output.xlsx',
    assertNotPrivate
  })
}
