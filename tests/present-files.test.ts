import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validatePresentedFiles } from '../src/main/agent/deliverables/present-files'
import { buildPresentFilesTool } from '../src/main/agent/deliverables/present-tool'

function withWorkspace(run: (root: string, outside: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'phi-present-files-'))
  const root = join(base, 'workspace')
  const outside = join(base, 'private.txt')
  mkdirSync(root)
  writeFileSync(outside, 'private')
  try {
    run(root, outside)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test('presented files keep only bounded metadata for existing workspace files', () => {
  withWorkspace((root) => {
    mkdirSync(join(root, 'reports'))
    writeFileSync(join(root, 'reports', 'result.csv'), 'a,b\n1,2\n')
    const files = validatePresentedFiles(root, [
      { path: 'reports/result.csv', description: '  Final\n result  ' }
    ])
    assert.deepEqual(files, [
      {
        path: realpathSync(join(root, 'reports', 'result.csv')),
        displayPath: 'reports/result.csv',
        bytes: 8,
        description: 'Final result'
      }
    ])
    assert.equal(readFileSync(files[0].path, 'utf8'), 'a,b\n1,2\n')
    assert.equal(validatePresentedFiles(root, [{ path: files[0].path }])[0].path, files[0].path)
  })
})

test('presented files reject missing, outside, linked, duplicate and excessive paths', () => {
  withWorkspace((root, outside) => {
    writeFileSync(join(root, 'one.txt'), 'one')
    symlinkSync(outside, join(root, 'linked.txt'))
    assert.throws(() => validatePresentedFiles(root, []), /1 to 4/)
    assert.throws(() => validatePresentedFiles(root, [{ path: 'missing.txt' }]), /ENOENT/)
    assert.throws(() => validatePresentedFiles(root, [{ path: outside }]), /outside/)
    assert.throws(() => validatePresentedFiles(root, [{ path: 'linked.txt' }]), /regular file/)
    assert.throws(() => validatePresentedFiles(root, [{ path: '.' }]), /regular file/)
    assert.throws(
      () => validatePresentedFiles(root, [{ path: 'one.txt' }, { path: './one.txt' }]),
      /twice/
    )
    assert.throws(
      () =>
        validatePresentedFiles(
          root,
          Array.from({ length: 5 }, () => ({ path: 'one.txt' }))
        ),
      /1 to 4/
    )
  })
})

test('presented files reject parent links that escape the workspace', () => {
  withWorkspace((root, outside) => {
    symlinkSync(join(root, '..'), join(root, 'escape'))
    assert.throws(() => validatePresentedFiles(root, [{ path: 'escape/private.txt' }]), /outside/)
    assert.equal(readFileSync(outside, 'utf8'), 'private')
  })
})

test('present_files records through the host before reporting success', async () => {
  const requests: unknown[] = []
  const files = [{ path: '/workspace/report.pdf', displayPath: 'report.pdf', bytes: 123 }]
  const tool = buildPresentFilesTool('runtime-1', async (request) => {
    requests.push(request)
    return { files }
  })
  const result = await tool.execute('call-1', { files: [{ path: 'report.pdf' }] })
  assert.equal(tool.name, 'present_files')
  assert.equal(tool.approval, 'read')
  assert.deepEqual(requests, [
    { runtimeSessionId: 'runtime-1', toolCallId: 'call-1', files: [{ path: 'report.pdf' }] }
  ])
  assert.deepEqual(result.details, { kind: 'presented_files', files })
  assert.equal(result.isError, undefined)
})

test('present_files reports host validation failures as tool errors', async () => {
  const tool = buildPresentFilesTool('runtime-1', async () => {
    throw new Error('outside the current workspace')
  })
  const result = await tool.execute('call-1', { files: [{ path: '../private.txt' }] })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text ?? '', /outside the current workspace/)
})
