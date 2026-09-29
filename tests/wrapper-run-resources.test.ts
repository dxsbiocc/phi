import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildResourceConfig,
  parseWrapperRunResources
} from '../src/main/agent/wrappers/composition/resources'

test('resources are normalized to Nextflow units', () => {
  const parsed = parseWrapperRunResources({ cpus: 8, memory: '40G', time: '1d6h' })
  assert.deepEqual(parsed, { ok: true, resources: { cpus: 8, memory: '40 GB', time: '1d 6h' } })
  assert.deepEqual(parseWrapperRunResources({ memory: '512 mb', time: '90 min' }), {
    ok: true,
    resources: { memory: '512 MB', time: '90m' }
  })
  assert.deepEqual(parseWrapperRunResources({ memory: '1.5TB' }), {
    ok: true,
    resources: { memory: '1.5 TB' }
  })
})

test('missing or empty resources mean the wrapper defaults', () => {
  assert.deepEqual(parseWrapperRunResources(undefined), { ok: true })
  assert.deepEqual(parseWrapperRunResources({}), { ok: true })
  assert.equal(buildResourceConfig({}), '')
})

test('resources that Nextflow would misread are rejected with the reason', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ cpus: 0 }, /cpus/],
    [{ cpus: 2.5 }, /cpus/],
    [{ cpus: '8' }, /cpus/],
    [{ memory: '40' }, /memory/],
    [{ memory: 'lots' }, /memory/],
    [{ time: '4' }, /time/],
    [{ time: "4h'; exec" }, /time/],
    [{ disk: '10 GB' }, /disk/],
    ['8 cpus', /object/]
  ]
  for (const [value, message] of cases) {
    const parsed = parseWrapperRunResources(value)
    assert.equal(parsed.ok, false, JSON.stringify(value))
    assert.ok(!parsed.ok)
    assert.match(parsed.error, message)
  }
})

test('the run config applies the resources to every process, over the wrapper own selectors', () => {
  const config = buildResourceConfig({ cpus: 8, memory: '40 GB', time: '4h' })
  assert.match(config, /withName: '\.\*'/)
  assert.match(config, /cpus = 8/)
  assert.match(config, /memory = '40 GB'/)
  assert.match(config, /time = '4h'/)
  assert.doesNotMatch(buildResourceConfig({ memory: '4 GB' }), /cpus|time/)
})
