import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildLibraryCustomTools } from '../src/main/agent/library/library-tools'

function fakeCtx(cwd: string): { sessionManager: { getCwd: () => string } } {
  return { sessionManager: { getCwd: () => cwd } }
}

function withProject<T>(callback: (projectDir: string) => T | Promise<T>): Promise<T> {
  const projectDir = mkdtempSync(join(tmpdir(), 'phi-library-tools-'))
  return Promise.resolve(callback(projectDir)).finally(() =>
    rmSync(projectDir, { recursive: true, force: true })
  )
}

test('buildLibraryCustomTools exposes stable library operations with approval tiers', () => {
  const tools = buildLibraryCustomTools()

  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.approval]),
    [
      ['lib.save', 'write'],
      ['lib.update', 'write'],
      ['lib.remove', 'write'],
      ['lib.list', 'read'],
      ['lib.find', 'read'],
      ['lib.audit', 'read']
    ]
  )
})

test('library tools operate against the session cwd and return structured details', async () => {
  await withProject(async (projectDir) => {
    const tools = buildLibraryCustomTools()
    const save = tools.find((tool) => tool.name === 'lib.save')
    const find = tools.find((tool) => tool.name === 'lib.find')
    assert.ok(save)
    assert.ok(find)

    const saveResult = await save.execute(
      'call-1',
      { title: 'Tool Registered Paper', tags: ['agent'] },
      undefined,
      fakeCtx(projectDir) as never
    )
    assert.equal(saveResult.isError, undefined)
    assert.equal(saveResult.content[0]?.type, 'text')
    assert.match(saveResult.content[0]?.text, /已保存文献/)
    assert.equal((saveResult.details as { kind?: string }).kind, 'library_save_result')

    const findResult = await find.execute(
      'call-2',
      { query: 'registered', tags: ['agent'] },
      undefined,
      fakeCtx(projectDir) as never
    )
    const details = findResult.details as { papers: Array<{ title: string }> }
    assert.deepEqual(
      details.papers.map((paper) => paper.title),
      ['Tool Registered Paper']
    )
  })
})

test('library tools report validation failures as tool errors', async () => {
  await withProject(async (projectDir) => {
    const remove = buildLibraryCustomTools().find((tool) => tool.name === 'lib.remove')
    assert.ok(remove)

    const result = await remove.execute('call-1', {}, undefined, fakeCtx(projectDir) as never)

    assert.equal(result.isError, true)
    assert.equal(result.content[0]?.text, 'Missing required parameter: id')
  })
})
