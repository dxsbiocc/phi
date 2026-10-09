import assert from 'node:assert/strict'
import test from 'node:test'
import { listWrapperCompositionCatalog } from '../../src/main/agent/wrappers/composition/discovery'
import { checkWrapperStatic } from '../../src/main/agent/wrappers/composition/smoke'
import { packageContentPath } from '../helpers/packageContent'

test('every distributed wrapper passes the static smoke checks', () => {
  const entries = listWrapperCompositionCatalog({ sourceRoot: packageContentPath('wrappers') })
  assert.ok(entries.length > 0)
  const failures = entries.flatMap((entry) =>
    checkWrapperStatic(entry)
      .filter((issue) => issue.level === 'error')
      .map((issue) => `${entry.manifest.id}: ${issue.message}`)
  )
  assert.deepEqual(failures, [])
})
