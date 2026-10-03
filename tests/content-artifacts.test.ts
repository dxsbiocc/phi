import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  ARTIFACT_CONTRACT_VERSION,
  artifactSchema,
  collectArtifacts,
  readArtifact,
  type ReadArtifactResult
} from '../src/main/agent/content/artifacts'

const SHA = 'ab'.repeat(32)

function withProject(run: (project: string, outside: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'phi-artifact-'))
  const project = join(base, 'project')
  const outside = join(base, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  try {
    run(project, outside)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function descriptor(
  file: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    contractVersion: '1.0.0',
    kind: 'figure',
    file,
    mediaType: 'image/png',
    title: 'Volcano plot',
    description: 'Differential expression',
    provenance: {
      createdAt: '2026-09-30T09:11:00Z',
      tool: 'viz_render',
      skill: 'omics-visualization',
      inputs: [{ path: 'data/in.txt', sha256: SHA }],
      script: 'scripts/plot.py',
      parameters: { log2fc: 1 }
    },
    figure: { format: 'png', widthPx: 1200, heightPx: 800 },
    ...overrides
  }
}

function writePair(
  project: string,
  relativePath: string,
  body: Record<string, unknown> | string = descriptor(relativePath.split('/').pop() ?? '')
): string {
  const file = join(project, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'png')
  writeFileSync(
    `${file}.phi-artifact.json`,
    typeof body === 'string' ? body : `${JSON.stringify(body)}\n`
  )
  return file
}

function failure(result: ReadArtifactResult): string {
  assert.equal(result.ok, false)
  return result.ok ? '' : result.error
}

test('the published artifact schema matches the runtime constant', () => {
  const published = JSON.parse(
    readFileSync(resolve('docs/contracts/artifact.schema.json'), 'utf8')
  ) as unknown
  assert.deepEqual(artifactSchema, published)
  assert.equal(ARTIFACT_CONTRACT_VERSION, '1.0.0')
})

test('a figure descriptor beside the file is accepted and x- keys are kept', () => {
  withProject((project) => {
    writePair(
      project,
      'figures/plot.png',
      descriptor('plot.png', { 'x-panel': { name: 'volcano' } })
    )
    const read = readArtifact(project, 'figures/plot.png')
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.relativePath, 'figures/plot.png')
    assert.equal(read.descriptor.kind, 'figure')
    assert.equal(read.descriptor.title, 'Volcano plot')
    assert.deepEqual(read.descriptor['x-panel'], { name: 'volcano' })
    assert.equal('envId' in read.descriptor, false)
    assert.equal(readArtifact(project, resolve(project, 'figures/plot.png')).ok, true)
    assert.equal(readArtifact(project, 'figures/../figures/plot.png').ok, true)
  })
})

test('every artifact kind and the documented media types validate', () => {
  withProject((project) => {
    const kinds = ['figure', 'table', 'structure', 'molecule', 'network', 'report'] as const
    for (const kind of kinds) {
      const name = `${kind}.bin`
      const extra: Record<string, unknown> =
        kind === 'figure'
          ? {}
          : {
              kind,
              figure: undefined,
              ...(kind === 'table' ? { table: { rows: 0, columns: ['gene', 'score'] } } : {})
            }
      writePair(project, name, descriptor(name, extra))
      const read = readArtifact(project, name)
      assert.equal(read.ok, true, read.ok ? '' : read.error)
    }
    for (const [name, mediaType] of [
      ['plot.svg', 'image/svg+xml'],
      ['plot.pdf', 'application/pdf'],
      ['plot.tsv', 'text/tab-separated-values']
    ] as const) {
      writePair(project, name, descriptor(name, { mediaType, kind: 'report', figure: undefined }))
      const read = readArtifact(project, name)
      assert.equal(read.ok, true, read.ok ? '' : `${name} ${read.error}`)
    }
    writePair(
      project,
      'counts.tsv',
      descriptor('counts.tsv', {
        kind: 'table',
        mediaType: 'text/tab-separated-values',
        figure: undefined,
        table: { rows: 2, columns: 3 }
      })
    )
    assert.equal(readArtifact(project, 'counts.tsv').ok, true)
  })
})

test('timestamps with a zone, long titles, and absent optional provenance fields pass', () => {
  withProject((project) => {
    writePair(
      project,
      'plot.png',
      descriptor('plot.png', {
        title: 't'.repeat(200),
        description: 'd'.repeat(2000),
        provenance: {
          createdAt: '2026-09-30T09:11:00.123+08:00',
          tool: 'viz_render'
        }
      })
    )
    const read = readArtifact(project, 'plot.png')
    assert.equal(read.ok, true, read.ok ? '' : read.error)
  })
})

test('schema and kind rules reject unknown keys, mismatched names, and the wrong block', () => {
  withProject((project) => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['note.png', descriptor('note.png', { note: 'nope' }), /unknown property 'note'/],
      ['env.png', descriptor('env.png', { envId: 'phi-1' }), /unknown property 'envId'/],
      [
        'prov.png',
        descriptor('prov.png', {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            envId: 'phi-1'
          }
        }),
        /unknown property 'envId'/
      ],
      ['name.png', descriptor('other.png'), /file must equal 'name.png'/],
      ['slash.png', descriptor('slash.png', { file: 'figures/slash.png' }), /file/],
      [
        'table.png',
        descriptor('table.png', { kind: 'table', figure: { format: 'png' } }),
        /figure is only allowed when kind is figure/
      ],
      [
        'figure.png',
        descriptor('figure.png', { table: { rows: 1 } }),
        /table is only allowed when kind is table/
      ],
      ['version.png', descriptor('version.png', { contractVersion: '1.1.0' }), /contractVersion/],
      ['kind.png', descriptor('kind.png', { kind: 'plot' }), /kind/],
      ['type.png', descriptor('type.png', { mediaType: 'PNG' }), /mediaType/],
      ['title.png', descriptor('title.png', { title: '' }), /title/],
      ['long.png', descriptor('long.png', { title: 't'.repeat(201) }), /title/],
      ['desc.png', descriptor('desc.png', { description: 'd'.repeat(2001) }), /description/],
      [
        'date.png',
        descriptor('date.png', {
          provenance: { createdAt: '2026-09-30', tool: 'viz_render' }
        }),
        /createdAt|date-time|format/
      ],
      [
        'zone.png',
        descriptor('zone.png', {
          provenance: { createdAt: '2026-09-30T09:11:00', tool: 'viz_render' }
        }),
        /createdAt|date-time|format/
      ],
      [
        'hash.png',
        descriptor('hash.png', {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            inputs: [{ path: 'data/in.txt', sha256: 'ABC' }]
          }
        }),
        /sha256/
      ],
      ['jpg.png', descriptor('jpg.png', { figure: { format: 'jpg' } }), /format/],
      ['wide.png', descriptor('wide.png', { figure: { format: 'png', widthPx: 0 } }), /widthPx/],
      [
        'rows.tsv',
        descriptor('rows.tsv', { kind: 'table', figure: undefined, table: { rows: -1 } }),
        /rows/
      ]
    ]
    for (const [name, body, pattern] of cases) {
      writePair(project, name, body)
      assert.match(failure(readArtifact(project, name)), pattern, name)
    }
  })
})

test('provenance paths must be project-relative and stay inside the project', () => {
  withProject((project, outside) => {
    symlinkSync(outside, join(project, 'escape'))
    writeFileSync(join(outside, 'secret.txt'), 'no')
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            inputs: [{ path: '/etc/passwd' }]
          }
        },
        /not project-relative/
      ],
      [
        {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            inputs: [{ path: '../secret.txt' }]
          }
        },
        /outside the project/
      ],
      [
        {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            inputs: [{ path: 'escape/secret.txt' }]
          }
        },
        /outside the project/
      ],
      [
        {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            script: '/tmp/plot.py'
          }
        },
        /not project-relative/
      ],
      [
        {
          provenance: {
            createdAt: '2026-09-30T09:11:00Z',
            tool: 'viz_render',
            script: 'escape/plot.py'
          }
        },
        /outside the project/
      ]
    ]
    for (const [index, [overrides, pattern]] of cases.entries()) {
      const name = `prov-${index}.png`
      writePair(project, name, descriptor(name, overrides))
      assert.match(failure(readArtifact(project, name)), pattern, name)
    }
    writePair(
      project,
      'inside.png',
      descriptor('inside.png', {
        provenance: {
          createdAt: '2026-09-30T09:11:00Z',
          tool: 'viz_render',
          inputs: [{ path: 'data/not-written-yet.txt' }],
          script: 'scripts/not-written-yet.py'
        }
      })
    )
    assert.equal(readArtifact(project, 'inside.png').ok, true)
  })
})

test('files and descriptors must exist inside the project, as regular files, within 64 KiB', () => {
  withProject((project, outside) => {
    assert.match(failure(readArtifact(project, '')), /required/)
    assert.match(failure(readArtifact(project, 'missing.png')), /does not exist/)
    assert.match(failure(readArtifact(join(project, 'missing-root'), 'a.png')), /project directory/)

    writeFileSync(join(outside, 'secret.png'), 'no')
    symlinkSync(join(outside, 'secret.png'), join(project, 'secret.png'))
    assert.match(failure(readArtifact(project, 'secret.png')), /outside the project/)
    symlinkSync(outside, join(project, 'escape'))
    assert.match(failure(readArtifact(project, 'escape/secret.png')), /outside the project/)

    writeFileSync(join(project, 'bare.png'), 'png')
    assert.match(failure(readArtifact(project, 'bare.png')), /descriptor does not exist/)

    mkdirSync(join(project, 'directory.png'))
    assert.match(failure(readArtifact(project, 'directory.png')), /not a regular file/)

    writeFileSync(join(project, 'bad.json.png'), 'png')
    writeFileSync(join(project, 'bad.json.png.phi-artifact.json'), '{')
    assert.match(failure(readArtifact(project, 'bad.json.png')), /not JSON/)

    const binary = Buffer.from(JSON.stringify(descriptor('binary.png')))
    binary[binary.length - 2] = 0xff
    writeFileSync(join(project, 'binary.png'), 'png')
    writeFileSync(join(project, 'binary.png.phi-artifact.json'), binary)
    assert.match(failure(readArtifact(project, 'binary.png')), /UTF-8/)

    writeFileSync(join(outside, 'desc.json'), JSON.stringify(descriptor('linked.png')))
    writeFileSync(join(project, 'linked.png'), 'png')
    symlinkSync(join(outside, 'desc.json'), join(project, 'linked.png.phi-artifact.json'))
    assert.match(failure(readArtifact(project, 'linked.png')), /outside the project/)

    writeFileSync(join(project, 'exact.png'), 'png')
    writeFileSync(join(project, 'exact.png.phi-artifact.json'), padded('exact.png', 64 * 1024))
    assert.equal(readArtifact(project, 'exact.png').ok, true)
    writeFileSync(join(project, 'over.png'), 'png')
    writeFileSync(join(project, 'over.png.phi-artifact.json'), padded('over.png', 64 * 1024 + 1))
    assert.match(failure(readArtifact(project, 'over.png')), /64 KiB/)

    writePair(project, 'figures/real.png', descriptor('real.png'))
    symlinkSync(join(project, 'figures/real.png'), join(project, 'figures/link.png'))
    writeFileSync(
      join(project, 'figures/link.png.phi-artifact.json'),
      JSON.stringify(descriptor('link.png'))
    )
    const linked = readArtifact(project, 'figures/link.png')
    assert.equal(linked.ok, true, linked.ok ? '' : linked.error)
    if (linked.ok) assert.equal(linked.relativePath, 'figures/real.png')
  })
})

test('collectArtifacts keeps order, drops duplicates, and caps presentation at 8', () => {
  withProject((project) => {
    assert.deepEqual(collectArtifacts(project, { value: 1 }), { artifacts: [], warnings: [] })
    assert.deepEqual(collectArtifacts(project, null), { artifacts: [], warnings: [] })
    assert.deepEqual(collectArtifacts(project, { artifacts: [] }), { artifacts: [], warnings: [] })
    assert.deepEqual(collectArtifacts(project, { artifacts: 'figures/a.png' }).warnings, [
      'artifacts must be an array of project paths'
    ])
    assert.deepEqual(collectArtifacts(project, { artifacts: ['figures/a.png', 1] }).warnings, [
      'artifacts must be an array of project paths'
    ])

    writePair(project, 'figures/b.png', descriptor('b.png'))
    writePair(project, 'figures/a.png', descriptor('a.png'))
    const ordered = collectArtifacts(project, {
      artifacts: ['figures/b.png', 'figures/a.png', './figures/b.png']
    })
    assert.deepEqual(
      ordered.artifacts.map((artifact) => artifact.relativePath),
      ['figures/b.png', 'figures/a.png']
    )
    assert.deepEqual(ordered.warnings, [])

    symlinkSync(join(project, 'figures/a.png'), join(project, 'figures/a-link.png'))
    writeFileSync(
      join(project, 'figures/a-link.png.phi-artifact.json'),
      JSON.stringify(descriptor('a-link.png'))
    )
    const sameFile = collectArtifacts(project, {
      artifacts: ['figures/a.png', 'figures/a-link.png']
    })
    assert.deepEqual(
      sameFile.artifacts.map((artifact) => artifact.relativePath),
      ['figures/a.png']
    )
    assert.deepEqual(sameFile.warnings, [])

    const names = Array.from({ length: 9 }, (_, index) => `figures/f${index}.png`)
    for (const name of names) writePair(project, name, descriptor(name.split('/').pop() ?? ''))
    const capped = collectArtifacts(project, {
      artifacts: ['figures/missing.png', ...names]
    })
    assert.deepEqual(
      capped.artifacts.map((artifact) => artifact.relativePath),
      names.slice(0, 7)
    )
    assert.equal(capped.warnings.length, 2)
    assert.match(capped.warnings[0] ?? '', /figures\/missing\.png/)
    assert.match(capped.warnings[0] ?? '', /does not exist/)
    assert.match(capped.warnings[1] ?? '', /first 8/)
    assert.match(capped.warnings[1] ?? '', /figures\/f7\.png/)
    assert.match(capped.warnings[1] ?? '', /figures\/f8\.png/)
  })
})

function padded(file: string, bytes: number): string {
  const base = descriptor(file, { 'x-pad': '' })
  const empty = JSON.stringify(base)
  const pad = bytes - Buffer.byteLength(empty)
  if (pad < 0) throw new Error(`descriptor base is ${Buffer.byteLength(empty)} bytes`)
  base['x-pad'] = 'a'.repeat(pad)
  const text = JSON.stringify(base)
  if (Buffer.byteLength(text) !== bytes) {
    throw new Error(`sized descriptor is ${Buffer.byteLength(text)} bytes, expected ${bytes}`)
  }
  return text
}
