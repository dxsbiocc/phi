import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { parse } from 'yaml'

test('the real packaging matcher ships helper releases and excludes interrupted builds and locks', () => {
  const config = parse(readFileSync('electron-builder.yml', 'utf8')) as {
    extraResources: Array<{ from: string; to: string; filter: string[] }>
  }
  const resource = config.extraResources.find((entry) => entry.from === 'resources/remote-helper')
  assert.ok(resource)
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-package-filter-'))
  try {
    const matcher = new FileMatcher(
      root,
      join(root, 'destination'),
      (pattern) => pattern,
      resource.filter
    )
    const filter = matcher.createFilter()
    for (const [relative, included] of [
      ['manifest.json', true],
      ['0.1.0/linux-amd64/phi-helper', true],
      ['0.1.0/linux-arm64/phi-helper', true],
      ['0.1.0/linux-amd64/phi-helper.123.partial', false],
      ['manifest.json.123.partial', false],
      ['.manifest.lock/owner-123', false],
      ['.manifest.lock.candidate-123/owner-123', false]
    ] as const) {
      const path = join(root, relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, relative)
      assert.equal(filter(path, statSync(path)), included, relative)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
