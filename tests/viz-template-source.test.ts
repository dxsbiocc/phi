import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  listTemplateSources,
  parseTemplateSource,
  patchBootstrap
} from '../src/main/agent/visualization/template-source'

const SKILL_ROOT = join(process.cwd(), 'resources', 'skills', 'omics-visualization')

function readTemplate(relative: string): string {
  return readFileSync(join(SKILL_ROOT, 'scripts', relative, 'plot.R'), 'utf-8')
}

function hasRscript(): boolean {
  try {
    execFileSync('Rscript', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('a template header is read into id, purpose, inputs, dependencies and notes', () => {
  const source = parseTemplateSource(readTemplate(join('scatter', 'volcano')))

  assert.equal(source.id, 'scatter-volcano')
  assert.match(source.purpose, /volcano plot/i)
  assert.deepEqual(source.inputNames, ['input'])
  assert.deepEqual(source.dependencies, ['ggplot2', 'readr', 'ggprism', 'ggrepel'])
  assert.match(source.adaptation ?? '', /edit only CONFIG/i)
  assert.match(source.assumptions ?? '', /q-values are floored/i)
})

test('the editable sections come back with the line numbers they occupy in the file', () => {
  const text = readTemplate(join('scatter', 'volcano'))
  const lines = text.split('\n')
  const source = parseTemplateSource(text)

  for (const section of [source.config, source.dataPreparation, source.plot]) {
    assert.ok(section, 'volcano has CONFIG, DATA PREPARATION and PLOT')
    assert.equal(lines.slice(section.startLine - 1, section.endLine).join('\n'), section.text)
  }
  assert.match(source.config?.text ?? '', /columns = list\(/)
  assert.match(source.config?.text ?? '', /log2FC/)
  assert.doesNotMatch(source.config?.text ?? '', /read_table_auto/)
  assert.match(source.dataPreparation?.text ?? '', /read_table_auto/)
  assert.ok((source.config?.endLine ?? 0) < (source.dataPreparation?.startLine ?? 0))
  assert.ok((source.dataPreparation?.endLine ?? 0) < (source.plot?.startLine ?? 0))
})

test('a template that takes two tables lists them by name', () => {
  const two = listTemplateSources(SKILL_ROOT).find((source) => source.inputNames.length === 2)
  assert.ok(two, 'the library has two-input templates (nodes + links)')
  assert.ok(
    two.inputNames.every((name) => /^[a-z_]+$/.test(name)),
    two.inputNames.join()
  )
})

test('every bundled template parses, with a unique id and editable sections', () => {
  const sources = listTemplateSources(SKILL_ROOT)
  assert.ok(sources.length >= 150, `found ${sources.length}`)
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length)
  for (const source of sources) {
    assert.match(source.id, /^[a-z0-9]+(?:-[a-z0-9]+)+$/, source.path)
    assert.ok(
      source.config && source.dataPreparation,
      `${source.id} lacks CONFIG or DATA PREPARATION`
    )
    assert.ok(source.dependencies.length > 0, `${source.id} lists no dependencies`)
    assert.ok(source.inputNames.length >= 1, source.id)
    assert.ok(source.path.endsWith('plot.R'), source.path)
  }
})

test('replacing the bootstrap points the copy at the installed helper by absolute path', () => {
  const original = readTemplate(join('scatter', 'volcano'))
  const patched = patchBootstrap(original, '/skill/scripts/lib/common.R')

  assert.match(patched, /^source\("\/skill\/scripts\/lib\/common\.R"\)$/m)
  assert.doesNotMatch(patched, /Cannot find scripts\/lib\/common\.R/)
  assert.doesNotMatch(patched, /^local\(\{/m)
  // Everything outside the bootstrap is untouched.
  assert.equal(
    patched.split('io <- parse_io_args()')[1],
    original.split('io <- parse_io_args()')[1]
  )
  assert.equal(parseTemplateSource(patched).id, 'scatter-volcano')
})

test('a helper path is quoted safely inside the R string', () => {
  const patched = patchBootstrap(
    readTemplate(join('scatter', 'volcano')),
    'C:\\skill "x"\\common.R'
  )
  assert.ok(patched.includes('source("C:\\\\skill \\"x\\"\\\\common.R")'))
})

test('a file with no bootstrap is refused rather than silently left pointing nowhere', () => {
  assert.throws(() => patchBootstrap('io <- parse_io_args()\n', '/x/common.R'), /bootstrap/i)
})

test('a patched copy of every template is still valid R', { skip: !hasRscript() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-viz-parse-'))
  try {
    const files = listTemplateSources(SKILL_ROOT).map((source, index) => {
      const target = join(dir, `t${index}.R`)
      writeFileSync(target, patchBootstrap(readFileSync(source.path, 'utf-8'), '/x/common.R'))
      return target
    })
    writeFileSync(join(dir, 'files.txt'), files.join('\n'))
    const output = execFileSync(
      'Rscript',
      [
        '-e',
        `bad <- 0; for (f in readLines("${join(dir, 'files.txt')}")) { ok <- tryCatch({ parse(f); TRUE }, error = function(e) { cat("BAD", f, conditionMessage(e), "\\n"); FALSE }); if (!ok) bad <- bad + 1 }; cat("bad:", bad, "\\n")`
      ],
      { encoding: 'utf-8' }
    )
    assert.match(output, /bad: 0/, output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
