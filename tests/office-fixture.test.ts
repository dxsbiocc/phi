import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const samplePath = join(process.cwd(), 'tests', 'fixtures', 'office', 'sample.xlsx')
const sampleSha256 = '7c25442747f2d061aba70f2ec74eba637653d5288ed9e3e5371a15c51e51ade0'

test('Office sample is a small committed XLSX ZIP fixture', () => {
  const bytes = readFileSync(samplePath)

  assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  assert.ok(bytes.length > 0)
  assert.ok(statSync(samplePath).size < 100 * 1024)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sampleSha256)
})
