import assert from 'node:assert/strict'
import test from 'node:test'
import { highlightLine, languageForPath } from '../src/renderer/src/lib/syntaxHighlight'

test('languageForPath detects common preview languages', () => {
  assert.equal(languageForPath('/workspace/src/App.tsx'), 'typescript')
  assert.equal(languageForPath('/workspace/scripts/main.py'), 'python')
  assert.equal(languageForPath('/workspace/scripts/plot.R'), 'r')
  assert.equal(languageForPath('/workspace/scripts/deploy.sh'), 'shell')
  assert.equal(languageForPath('/workspace/package.json'), 'json')
  assert.equal(languageForPath('/workspace/config.yaml'), 'yaml')
  assert.equal(languageForPath('/workspace/Cargo.toml'), 'toml')
  assert.equal(languageForPath('/workspace/README.md'), 'markdown')
  assert.equal(languageForPath('/workspace/unknown.log'), 'plain')
})

test('highlightLine tokenizes scripts with vscode-like semantic groups', () => {
  const tokens = highlightLine('const value = plot("income", 42) // render chart', 'typescript')

  assert.deepEqual(
    tokens.map((token) => [token.kind, token.value]),
    [
      ['keyword', 'const'],
      ['plain', ' value '],
      ['operator', '='],
      ['plain', ' '],
      ['function', 'plot'],
      ['punctuation', '('],
      ['string', '"income"'],
      ['punctuation', ','],
      ['plain', ' '],
      ['number', '42'],
      ['punctuation', ')'],
      ['plain', ' '],
      ['comment', '// render chart']
    ]
  )
})

test('highlightLine tokenizes data formats with properties and values', () => {
  assert.deepEqual(
    highlightLine('"name": "Phi"', 'json').map((token) => [token.kind, token.value]),
    [
      ['property', '"name"'],
      ['punctuation', ':'],
      ['plain', ' '],
      ['string', '"Phi"']
    ]
  )

  assert.deepEqual(
    highlightLine('version = "1.0.0" # package version', 'toml').map((token) => [
      token.kind,
      token.value
    ]),
    [
      ['property', 'version'],
      ['operator', ' = '],
      ['string', '"1.0.0" '],
      ['comment', '# package version']
    ]
  )
})
