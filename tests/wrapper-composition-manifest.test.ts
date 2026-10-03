import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'

const VALID_MANIFEST = `
id: nf-core/modules/fastqc
name: FastQC
summary: Run FastQC quality checks.
params:
  reads:
    kind: input
    type: path_glob
    required: true
  threads:
    kind: option
    type: integer
    minimum: 1
    maximum: 16
outputs:
  reports:
    type: directory
    path: '\${outdir}'
    primary: true
`

function replace(source: string, pattern: string | RegExp, replacement: string): string {
  const result = source.replace(pattern, replacement)
  assert.notEqual(result, source, `fixture replacement did not match: ${String(pattern)}`)
  return result
}

test('wrapper contract accepts the complete minimal shape and normalizes optional booleans', () => {
  const manifest = parseWrapperCompositionManifest(VALID_MANIFEST)
  assert.equal(manifest.params.reads.required, true)
  assert.equal(manifest.params.threads.required, false)
  assert.equal(manifest.outputs.reports.primary, true)
})

test('wrapper contract rejects unknown keys, including defaults', () => {
  for (const [yaml, expected] of [
    [
      replace(VALID_MANIFEST, 'name: FastQC', 'name: FastQC\nentrypoint: wrapper/main.nf'),
      /entrypoint.*unknown/i
    ],
    [
      replace(VALID_MANIFEST, '    type: integer', '    type: integer\n    default: 4'),
      /params\.threads\.default.*unknown/i
    ],
    [
      replace(VALID_MANIFEST, '    type: integer', '    type: integer\n    hint: fast'),
      /params\.threads\.hint.*unknown/i
    ],
    [
      replace(VALID_MANIFEST, '    path:', '    hint: report\n    path:'),
      /outputs\.reports\.hint.*unknown/i
    ]
  ] as const) {
    assert.throws(() => parseWrapperCompositionManifest(yaml), expected)
  }
})

test('wrapper contract enforces id, text length, and parameter-name formats', () => {
  assert.throws(
    () =>
      parseWrapperCompositionManifest(
        replace(VALID_MANIFEST, 'nf-core/modules/fastqc', 'nf-core/module/fastqc')
      ),
    /id.*provider.*kind.*name/i
  )
  assert.throws(
    () =>
      parseWrapperCompositionManifest(
        replace(VALID_MANIFEST, 'name: FastQC', `name: ${'x'.repeat(81)}`)
      ),
    /name.*1.*80/i
  )
  assert.throws(
    () =>
      parseWrapperCompositionManifest(
        replace(
          VALID_MANIFEST,
          'summary: Run FastQC quality checks.',
          `summary: ${'x'.repeat(301)}`
        )
      ),
    /summary.*1.*300/i
  )
  assert.throws(
    () => parseWrapperCompositionManifest(replace(VALID_MANIFEST, '  reads:', '  Read-files:')),
    /params\.Read-files.*name/i
  )
})

test('wrapper contract validates every param field and limits ranges to numeric types', () => {
  for (const [yaml, expected] of [
    [
      replace(VALID_MANIFEST, '    type: integer', "    type: ''"),
      /params\.threads\.type.*non-empty/i
    ],
    [
      replace(VALID_MANIFEST, '    required: true', '    required: yes'),
      /params\.reads\.required.*boolean/i
    ],
    [
      replace(VALID_MANIFEST, '    type: path_glob', '    type: path_glob\n    description: 42'),
      /params\.reads\.description.*string/i
    ],
    [
      replace(VALID_MANIFEST, '    type: path_glob', '    type: path_glob\n    minimum: 1'),
      /params\.reads\.minimum.*numeric/i
    ],
    [
      replace(VALID_MANIFEST, '    maximum: 16', "    maximum: '16'"),
      /params\.threads\.maximum.*number/i
    ],
    [
      replace(VALID_MANIFEST, '    maximum: 16', '    maximum: 16\n    enum: [fast, 2]'),
      /params\.threads\.enum.*strings/i
    ]
  ] as const) {
    assert.throws(() => parseWrapperCompositionManifest(yaml), expected)
  }

  assert.doesNotThrow(() =>
    parseWrapperCompositionManifest(
      replace(VALID_MANIFEST, '    type: integer', '    type: number')
    )
  )
})

test('wrapper contract validates output fields and requires a primary output', () => {
  for (const [yaml, expected] of [
    [
      replace(VALID_MANIFEST, '    type: directory', "    type: ''"),
      /outputs\.reports\.type.*non-empty/i
    ],
    [
      replace(VALID_MANIFEST, "    path: '${outdir}'", '    path: 42'),
      /outputs\.reports\.path.*string/i
    ],
    [
      replace(VALID_MANIFEST, '    primary: true', '    primary: yes'),
      /outputs\.reports\.primary.*boolean/i
    ],
    [replace(VALID_MANIFEST, '    primary: true', '    primary: false'), /primary.*true/i]
  ] as const) {
    assert.throws(() => parseWrapperCompositionManifest(yaml), expected)
  }
})
