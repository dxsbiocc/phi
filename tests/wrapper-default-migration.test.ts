import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import { migrateWrapperDefaults } from '../scripts/wrappers/migrate-defaults'

function writeWrapper(
  root: string,
  name: string,
  manifestDefault: unknown,
  params: Record<string, unknown>
): string {
  const wrapperDir = join(root, 'modules', 'local', name, 'wrapper')
  mkdirSync(wrapperDir, { recursive: true })
  writeFileSync(
    join(wrapperDir, 'wrapper.yaml'),
    `id: local/modules/${name}\nname: ${name}\nsummary: Test wrapper.\nparams:\n  value:\n    kind: option\n    type: string\n    default: ${JSON.stringify(manifestDefault)}\noutputs:\n  report:\n    type: file\n    path: report.txt\n    primary: true\n`
  )
  writeFileSync(join(wrapperDir, 'params.json'), `${JSON.stringify(params, null, 2)}\n`)
  return wrapperDir
}

test('wrapper-default migration moves absent defaults and reports conflicts without overwriting params.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-default-migration-'))
  try {
    const absent = writeWrapper(root, 'absent', 'from-manifest', {})
    const matching = writeWrapper(root, 'matching', 'same', { value: 'same' })
    const conflict = writeWrapper(root, 'conflict', 'from-manifest', { value: 'from-params' })

    const report = migrateWrapperDefaults(root)

    assert.deepEqual(
      {
        wrapperFiles: report.wrapperFiles,
        defaultsFound: report.defaultsFound,
        defaultsRemoved: report.defaultsRemoved,
        paramsAdded: report.paramsAdded,
        paramsMatched: report.paramsMatched
      },
      { wrapperFiles: 3, defaultsFound: 3, defaultsRemoved: 3, paramsAdded: 1, paramsMatched: 1 }
    )
    assert.deepEqual(report.conflicts, [
      {
        wrapper: 'modules/local/conflict/wrapper/wrapper.yaml',
        param: 'value',
        manifestValue: 'from-manifest',
        paramsValue: 'from-params'
      }
    ])
    assert.deepEqual(JSON.parse(readFileSync(join(absent, 'params.json'), 'utf8')), {
      value: 'from-manifest'
    })
    assert.deepEqual(JSON.parse(readFileSync(join(matching, 'params.json'), 'utf8')), {
      value: 'same'
    })
    assert.deepEqual(JSON.parse(readFileSync(join(conflict, 'params.json'), 'utf8')), {
      value: 'from-params'
    })
    for (const wrapperDir of [absent, matching, conflict]) {
      const manifest = parseYaml(readFileSync(join(wrapperDir, 'wrapper.yaml'), 'utf8')) as {
        params: { value: Record<string, unknown> }
      }
      assert.equal(Object.hasOwn(manifest.params.value, 'default'), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
