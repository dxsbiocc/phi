import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
}

for (const hook of ['predev', 'prestart']) {
  test(`${hook} does not prepare a remote helper or Go before the desktop starts`, () => {
    assert.doesNotMatch(scripts[hook] ?? '', /build:helper|helper:fetch-go|build-helper|fetch-go/)
  })
}

test('release packaging still prepares both remote-helper targets', () => {
  assert.match(scripts.build, /build:helper/)
})

test('preview starts an existing build without compiling it again', () => {
  assert.match(scripts.start, /preview\s+--skipBuild/)
})
