import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildScopedPhiToolMap } from '../src/main/agent/agents/tool-resolution'
import { isInstalledFigurePreviewPath } from '../src/main/agent/visualization/examples'
import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner
} from '../src/main/agent/visualization/process'
import { buildVisualizationTools } from '../src/main/agent/visualization/tools'

const SKILL_ROOT = join(process.cwd(), 'resources', 'skills', 'omics-visualization')
const VOLCANO_DATA = join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'example.tsv')

function has(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

interface Sandbox {
  cwd: string
  outside: string
  cleanup: () => void
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-tools-'))
  const cwd = join(root, 'project')
  const outside = join(root, 'elsewhere')
  mkdirSync(cwd)
  mkdirSync(outside)
  return { cwd, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

interface Call {
  command: string
  args: string[]
  options: ProcessOptions
}

function fakeRunner(
  handler: (call: Call) => Partial<ProcessResult> | Promise<Partial<ProcessResult>>
): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: ProcessRunner = async (command, args, options) => {
    const call = { command, args: [...args], options }
    calls.push(call)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(await handler(call)) }
  }
  return { runner, calls }
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
  details?: unknown
}

async function invoke(
  runner: ProcessRunner | undefined,
  name: string,
  params: Record<string, unknown>,
  cwd: string
): Promise<{ text: string; json: () => unknown; isError?: boolean; result: ToolResult }> {
  const tool = buildVisualizationTools({
    skillRoot: SKILL_ROOT,
    ...(runner ? { runner } : {})
  }).find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} should exist`)
  const ctx = { sessionManager: { getCwd: () => cwd } } as never
  const result = (await tool.execute('call-1', params, undefined, ctx)) as ToolResult
  const text = result.content[0].text ?? ''
  return { text, json: () => JSON.parse(text), isError: result.isError, result }
}

// ── registration ──────────────────────────────────────────────────────────

test('the visualization tools include read-only shipped examples before render tools', () => {
  const tools = buildVisualizationTools({ skillRoot: SKILL_ROOT })
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.approval]),
    [
      ['viz_examples', 'read'],
      ['viz_route', 'read'],
      ['viz_prepare', 'write'],
      ['viz_render', 'write']
    ]
  )
})

test('only the Visualization agent is given the visualization tools', () => {
  const tools = buildVisualizationTools({ skillRoot: SKILL_ROOT })
  const groups = { wrapper: [], database: [], visualization: tools }
  assert.deepEqual(
    [...buildScopedPhiToolMap('Visualization', groups).keys()],
    ['viz_examples', 'viz_route', 'viz_prepare', 'viz_render']
  )
  assert.equal(buildScopedPhiToolMap('Database', groups).has('viz_route'), false)
  assert.equal(buildScopedPhiToolMap('Wrapper', groups).has('viz_render'), false)
  // Callers written before the visualization group existed keep working.
  assert.equal(buildScopedPhiToolMap('Visualization', { wrapper: [], database: [] }).size, 0)
})

test('the tool schemas say what is required and bound the enums', () => {
  const tools = buildVisualizationTools({ skillRoot: SKILL_ROOT })
  const schema = (
    name: string
  ): { required?: string[]; properties?: Record<string, { enum?: string[] }> } =>
    tools.find((tool) => tool.name === name)?.parameters as never
  assert.deepEqual(schema('viz_route').required?.slice().sort(), ['data_path', 'purpose'])
  assert.deepEqual(schema('viz_examples').required, ['purpose'])
  assert.deepEqual(schema('viz_route').properties?.mode?.enum, ['preview', 'publication'])
  assert.deepEqual(schema('viz_prepare').required?.slice().sort(), ['template_id', 'workdir'])
  assert.deepEqual(schema('viz_render').required?.slice().sort(), ['inputs', 'output', 'script'])
})

test('viz_examples returns installed preview images without data, rendering, or project writes', async () => {
  const box = sandbox()
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: 'should not run' }))
    const preview = join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'preview.png')
    const original = readFileSync(preview)
    const result = await invoke(runner, 'viz_examples', { purpose: 'volcano plot' }, box.cwd)
    assert.equal(result.isError, undefined)
    const body = result.json() as {
      candidates: Array<{ template_id: string; preview: string; preview_markdown: string }>
    }
    const volcano = body.candidates.find((item) => item.template_id === 'scatter-volcano')
    assert.ok(volcano)
    assert.equal(volcano.preview, preview)
    assert.equal(volcano.preview_markdown, `![scatter-volcano](${preview})`)
    assert.equal(existsSync(volcano.preview), true)
    assert.deepEqual(readFileSync(preview), original)
    assert.deepEqual(readdirSync(box.cwd), [])
    assert.equal(calls.length, 0)
  } finally {
    box.cleanup()
  }
})

test('viz_examples recognizes a Chinese example request and keeps the shortlist bounded', async () => {
  const box = sandbox()
  try {
    const result = await invoke(
      undefined,
      'viz_examples',
      { purpose: '给我看几个火山图示例', top: 99 },
      box.cwd
    )
    const body = result.json() as {
      dataFitted: boolean
      candidates: Array<{ template_id: string; preview: string }>
    }
    assert.equal(body.dataFitted, false)
    assert.ok(body.candidates.some((item) => item.template_id === 'scatter-volcano'))
    assert.ok(body.candidates.length <= 4)
    assert.ok(body.candidates.every((item) => existsSync(item.preview)))
  } finally {
    box.cleanup()
  }
})

test('only an installed template preview path is eligible for chat image preview', () => {
  const preview = join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'preview.png')
  assert.equal(isInstalledFigurePreviewPath(preview, SKILL_ROOT), true)
  assert.equal(isInstalledFigurePreviewPath(VOLCANO_DATA, SKILL_ROOT), false)
  assert.equal(isInstalledFigurePreviewPath('/tmp/other/preview.png', SKILL_ROOT), false)
})

test('every catalog example points to an installed preview image', () => {
  const catalog = JSON.parse(
    readFileSync(join(SKILL_ROOT, 'references', 'template_contracts.json'), 'utf8')
  ) as { templates: Array<{ id: string; preview: string }> }
  assert.ok(catalog.templates.length > 0)
  for (const template of catalog.templates) {
    const preview = join(SKILL_ROOT, template.preview)
    assert.equal(
      isInstalledFigurePreviewPath(preview, SKILL_ROOT),
      true,
      `missing installed preview for ${template.id}`
    )
  }
})

test('viz_examples reports no matching installed example without creating a substitute', async () => {
  const box = sandbox()
  try {
    const { runner, calls } = fakeRunner(() => ({ stdout: 'should not run' }))
    const result = await invoke(
      runner,
      'viz_examples',
      { purpose: 'zzzz-no-such-figure-family' },
      box.cwd
    )
    const body = result.json() as { candidates: unknown[] }
    assert.deepEqual(body.candidates, [])
    assert.deepEqual(readdirSync(box.cwd), [])
    assert.equal(calls.length, 0)
  } finally {
    box.cleanup()
  }
})

// ── viz_route ─────────────────────────────────────────────────────────────

const ROUTER_OUTPUT = {
  mode: 'preview',
  query: 'volcano',
  contracts: '/skill/references/template_contracts.json',
  input_profile: {
    path: '/data/de.tsv',
    row_count: 1000,
    columns: ['symbol', 'log2FC', 'qvalue', 'group'],
    numeric_columns: ['log2FC', 'qvalue'],
    text_columns: ['symbol', 'group'],
    role_mapping: { target_entity: 'symbol', effect_size: 'log2FC', significance: 'qvalue' },
    numeric_summaries: { log2FC: { min: -10, max: 8, positive: 481, negative: 519, zero: 0 } },
    sidecars: {},
    sidecar_alignment: { status: 'not_checked', checks: [] },
    shapes: ['feature_level_testing', 'long_table']
  },
  recommendations: [
    {
      id: 'scatter-volcano',
      family: 'scatter',
      title: 'Differential-expression volcano plot',
      source: 'scripts/scatter/volcano/plot.R',
      preview: 'scripts/scatter/volcano/preview.png',
      score: 75,
      confidence: 'medium',
      matched_shapes: ['feature_level_testing'],
      required_roles: ['target_entity', 'effect_size', 'significance'],
      optional_roles: ['category'],
      role_mapping: { effect_size: 'log2FC', significance: 'qvalue', target_entity: 'symbol' },
      rationale: [
        'data shape matches',
        'required role target_entity is present',
        'keyword: volcano',
        'preview asset available'
      ],
      risks: ['adjusted p-values are needed'],
      use_when: 'Overview of effect size and adjusted significance.',
      avoid_when: 'Do not use when adjusted significance is unavailable.'
    }
  ]
}

interface RouteCandidate {
  template_id: string
  confidence: string
  title: string
  why: string[]
  risks: string[]
  use_when: string
  avoid_when: string
  preview: string
  preview_markdown: string
  role_mapping: Record<string, string>
  numeric_summaries?: unknown
}

test('viz_route runs the skill router and returns a short list of candidates with real previews', async () => {
  const box = sandbox()
  try {
    const data = join(box.outside, 'de.tsv')
    writeFileSync(data, 'symbol\tlog2FC\tqvalue\tgroup\nA\t1\t0.01\tUp\n')
    const { runner, calls } = fakeRunner(() => ({ stdout: JSON.stringify(ROUTER_OUTPUT) }))

    const out = await invoke(
      runner,
      'viz_route',
      { data_path: data, purpose: 'volcano of DE results', top: 3 },
      box.cwd
    )

    assert.equal(out.isError, undefined)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'python3')
    assert.deepEqual(calls[0].args, [
      join(SKILL_ROOT, 'scripts', 'route_template.py'),
      '--input',
      data,
      '--query',
      'volcano of DE results',
      '--mode',
      'preview',
      '--top',
      '3',
      '--json'
    ])

    const body = out.json() as {
      input: {
        rows: number
        columns: Array<{ name: string; type: string }>
        roles: Record<string, string>
      }
      candidates: RouteCandidate[]
    }
    assert.equal(body.input.rows, 1000)
    assert.deepEqual(body.input.columns, [
      { name: 'symbol', type: 'text' },
      { name: 'log2FC', type: 'number' },
      { name: 'qvalue', type: 'number' },
      { name: 'group', type: 'text' }
    ])
    const [first] = body.candidates
    assert.equal(first.template_id, 'scatter-volcano')
    assert.equal(first.confidence, 'medium')
    assert.equal(first.avoid_when, 'Do not use when adjusted significance is unavailable.')
    assert.deepEqual(first.risks, ['adjusted p-values are needed'])
    assert.ok(first.why.length <= 3, 'a few reasons, not the whole rationale')
    const preview = join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'preview.png')
    assert.equal(first.preview, preview)
    assert.equal(first.preview_markdown, `![scatter-volcano](${preview})`)
    assert.equal(first.numeric_summaries, undefined)
    assert.ok(
      out.text.length < JSON.stringify(ROUTER_OUTPUT, null, 2).length,
      'smaller than the raw router output'
    )
  } finally {
    box.cleanup()
  }
})

test('viz_route passes the mode and clamps the number of candidates', async () => {
  const box = sandbox()
  try {
    const data = join(box.outside, 'd.tsv')
    writeFileSync(data, 'a\tb\n1\t2\n')
    const { runner, calls } = fakeRunner(() => ({ stdout: JSON.stringify(ROUTER_OUTPUT) }))
    await invoke(
      runner,
      'viz_route',
      { data_path: data, purpose: 'x', mode: 'publication', top: 99 },
      box.cwd
    )
    assert.ok(calls[0].args.includes('publication'))
    assert.equal(calls[0].args[calls[0].args.indexOf('--top') + 1], '6')
    await invoke(runner, 'viz_route', { data_path: data, purpose: 'x' }, box.cwd)
    assert.equal(calls[1].args[calls[1].args.indexOf('--top') + 1], '4')
  } finally {
    box.cleanup()
  }
})

test('viz_route explains a missing table, a failing router and a missing Python', async () => {
  const box = sandbox()
  try {
    const { runner, calls } = fakeRunner(() => ({ code: 2, stderr: 'boom: could not profile' }))
    const missing = await invoke(
      runner,
      'viz_route',
      { data_path: join(box.outside, 'no.tsv'), purpose: 'x' },
      box.cwd
    )
    assert.equal(missing.isError, true)
    assert.match(missing.text, /no\.tsv/)
    assert.equal(calls.length, 0, 'no process for a file that is not there')

    const data = join(box.outside, 'd.tsv')
    writeFileSync(data, 'a\tb\n1\t2\n')
    const failed = await invoke(runner, 'viz_route', { data_path: data, purpose: 'x' }, box.cwd)
    assert.equal(failed.isError, true)
    assert.match(failed.text, /could not profile/)

    const noPython = fakeRunner(() => ({ code: null, spawnError: 'ENOENT' }))
    const gone = await invoke(
      noPython.runner,
      'viz_route',
      { data_path: data, purpose: 'x' },
      box.cwd
    )
    assert.equal(gone.isError, true)
    assert.match(gone.text, /python3.*not found/i)
  } finally {
    box.cleanup()
  }
})

test(
  'viz_route, run for real on the skill example, puts the volcano template first',
  { skip: !has('python3') },
  async () => {
    const box = sandbox()
    try {
      const out = await invoke(
        undefined,
        'viz_route',
        { data_path: VOLCANO_DATA, purpose: 'volcano plot of differential expression' },
        box.cwd
      )
      assert.equal(out.isError, undefined, out.text)
      const body = out.json() as { candidates: RouteCandidate[] }
      assert.equal(body.candidates[0].template_id, 'scatter-volcano')
      assert.ok(existsSync(body.candidates[0].preview), 'the preview file must exist')
    } finally {
      box.cleanup()
    }
  }
)

// ── viz_prepare ───────────────────────────────────────────────────────────

interface Prepared {
  template_id: string
  script: string
  existing?: boolean
  inputs: string[]
  run: string
  dependencies: string[]
  purpose: string
  config: { start_line: number; end_line: number; text: string }
  data_preparation: { start_line: number; end_line: number; text: string }
  plot: { start_line: number; end_line: number }
  adaptation?: string
}

test('viz_prepare copies the template into the project with the helper path fixed', async () => {
  const box = sandbox()
  try {
    const out = await invoke(
      undefined,
      'viz_prepare',
      { template_id: 'scatter-volcano', workdir: 'plots/volcano' },
      box.cwd
    )
    assert.equal(out.isError, undefined, out.text)
    const body = out.json() as Prepared

    const script = join(box.cwd, 'plots', 'volcano', 'plot.R')
    assert.equal(body.script, script)
    assert.equal(body.template_id, 'scatter-volcano')
    assert.deepEqual(body.inputs, ['input'])
    assert.deepEqual(body.dependencies, ['ggplot2', 'readr', 'ggprism', 'ggrepel'])
    assert.match(body.run, /Rscript .*plot\.R <input> <output>/)
    assert.match(body.purpose, /volcano/i)
    assert.match(body.adaptation ?? '', /CONFIG/)

    const copied = readFileSync(script, 'utf-8')
    assert.ok(copied.includes(`source("${join(SKILL_ROOT, 'scripts', 'lib', 'common.R')}")`))
    assert.doesNotMatch(copied, /Cannot find scripts\/lib\/common\.R/)

    // The sections come from the copy, at the lines they occupy in it.
    const lines = copied.split('\n')
    assert.equal(
      lines.slice(body.config.start_line - 1, body.config.end_line).join('\n'),
      body.config.text
    )
    assert.match(body.config.text, /columns = list\(/)
    assert.match(body.data_preparation.text, /read_table_auto/)
    assert.ok(body.plot.start_line > body.data_preparation.end_line)
    // The PLOT body is not sent back: it is in the file for anyone who needs to change geometry.
    assert.ok(!out.text.includes('geom_point'))
  } finally {
    box.cleanup()
  }
})

test('viz_prepare does not overwrite an edited copy unless asked to start over', async () => {
  const box = sandbox()
  try {
    const params = { template_id: 'scatter-volcano', workdir: 'plots/v' }
    await invoke(undefined, 'viz_prepare', params, box.cwd)
    const script = join(box.cwd, 'plots', 'v', 'plot.R')
    writeFileSync(script, `${readFileSync(script, 'utf-8')}\n# my edit\n`)

    const again = await invoke(undefined, 'viz_prepare', params, box.cwd)
    assert.equal((again.json() as Prepared).existing, true)
    assert.match(readFileSync(script, 'utf-8'), /# my edit/)

    const reset = await invoke(undefined, 'viz_prepare', { ...params, reset: true }, box.cwd)
    assert.equal((reset.json() as Prepared).existing, undefined)
    assert.doesNotMatch(readFileSync(script, 'utf-8'), /# my edit/)
  } finally {
    box.cleanup()
  }
})

test('viz_prepare refuses a working directory outside the project, however it is spelled', async () => {
  const box = sandbox()
  try {
    for (const workdir of [box.outside, '../elsewhere/plots', join(box.cwd, '..', 'elsewhere')]) {
      const out = await invoke(
        undefined,
        'viz_prepare',
        { template_id: 'scatter-volcano', workdir },
        box.cwd
      )
      assert.equal(out.isError, true, workdir)
      assert.match(out.text, /project/i)
    }
    assert.equal(existsSync(join(box.outside, 'plots')), false)
    assert.equal(existsSync(join(box.outside, 'plot.R')), false)

    symlinkSync(box.outside, join(box.cwd, 'link'))
    const viaLink = await invoke(
      undefined,
      'viz_prepare',
      { template_id: 'scatter-volcano', workdir: 'link/plots' },
      box.cwd
    )
    assert.equal(viaLink.isError, true, 'a symlink out of the project is still out of the project')
    assert.equal(existsSync(join(box.outside, 'plots', 'plot.R')), false)
  } finally {
    box.cleanup()
  }
})

test('viz_prepare answers an unknown template id with the closest real ones', async () => {
  const box = sandbox()
  try {
    const out = await invoke(
      undefined,
      'viz_prepare',
      { template_id: 'scatter-volcanoo', workdir: 'p' },
      box.cwd
    )
    assert.equal(out.isError, true)
    assert.match(out.text, /scatter-volcanoo/)
    assert.match(out.text, /scatter-volcano\b/)
    assert.match(out.text, /viz_route/)
    assert.equal(existsSync(join(box.cwd, 'p')), false)
  } finally {
    box.cleanup()
  }
})

// ── viz_render ────────────────────────────────────────────────────────────

const QA_OK = JSON.stringify({
  path: 'x.png',
  ok: true,
  checks: [
    { name: 'exists', ok: true },
    { name: 'non_empty', ok: true, size_bytes: 1234 },
    { format: 'png', ok: true, width: 2400, height: 1800, name: 'format' }
  ]
})

async function prepared(box: Sandbox): Promise<{ script: string; data: string }> {
  await invoke(
    undefined,
    'viz_prepare',
    { template_id: 'scatter-volcano', workdir: 'plots/v' },
    box.cwd
  )
  const data = join(box.outside, 'de.tsv')
  writeFileSync(data, 'symbol\tlog2FC\tqvalue\tgroup\nA\t1\t0.01\tUp\n')
  return { script: join(box.cwd, 'plots', 'v', 'plot.R'), data }
}

interface Rendered {
  ok: boolean
  output: string
  format?: string
  width?: number
  height?: number
  bytes?: number
  qa: { ok: boolean; failed: string[] }
}

test('viz_render runs R on the copy, checks the artifact and reports it compactly', async () => {
  const box = sandbox()
  try {
    const { script, data } = await prepared(box)
    const output = join(box.cwd, 'plots', 'v', 'volcano.png')
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === 'Rscript') writeFileSync(output, 'PNGDATA')
      return call.command === 'python3' ? { stdout: QA_OK } : {}
    })

    const out = await invoke(runner, 'viz_render', { script, inputs: [data], output }, box.cwd)

    assert.equal(out.isError, undefined, out.text)
    const [r, qa] = calls
    assert.equal(r.command, 'Rscript')
    assert.deepEqual(r.args, [script, data, output])
    assert.equal(r.options.cwd, join(box.cwd, 'plots', 'v'))
    assert.equal(r.options.env?.OMICS_VISUALIZATION_SKILL_ROOT, SKILL_ROOT)
    assert.ok(r.options.timeoutMs >= 60_000)
    assert.equal(qa.command, 'python3')
    assert.deepEqual(qa.args, [join(SKILL_ROOT, 'scripts', 'qa_single_plot.py'), output, '--json'])

    const body = out.json() as Rendered
    assert.equal(body.ok, true)
    assert.equal(body.output, output)
    assert.equal(body.format, 'png')
    assert.equal(body.width, 2400)
    assert.equal(body.height, 1800)
    assert.deepEqual(body.qa, { ok: true, failed: [] })
  } finally {
    box.cleanup()
  }
})

test('a failed QA check is reported by name, without failing the render', async () => {
  const box = sandbox()
  try {
    const { script, data } = await prepared(box)
    const output = join(box.cwd, 'out.svg')
    const failing = JSON.stringify({
      ok: false,
      checks: [
        { name: 'exists', ok: true },
        { name: 'min_dimensions', ok: false, width: 10, height: 10 }
      ]
    })
    const { runner } = fakeRunner((call) => {
      if (call.command === 'Rscript') writeFileSync(output, '<svg/>')
      return call.command === 'python3' ? { code: 1, stdout: failing } : {}
    })
    const out = await invoke(runner, 'viz_render', { script, inputs: [data], output }, box.cwd)
    assert.equal(out.isError, undefined)
    assert.deepEqual((out.json() as Rendered).qa, { ok: false, failed: ['min_dimensions'] })
  } finally {
    box.cleanup()
  }
})

test('an R error comes back as the tail of stderr, and a missing package is named', async () => {
  const box = sandbox()
  try {
    const { script, data } = await prepared(box)
    const output = join(box.cwd, 'o.png')
    const noisy = `${'progress line\n'.repeat(400)}Error in library(ggprism) : there is no package called ‘ggprism’\nExecution halted\n`
    const { runner } = fakeRunner(() => ({ code: 1, stderr: noisy }))
    const out = await invoke(runner, 'viz_render', { script, inputs: [data], output }, box.cwd)
    assert.equal(out.isError, true)
    assert.match(out.text, /ggprism/)
    assert.match(out.text, /not installed|missing/i)
    assert.match(out.text, /do not install|report/i)
    assert.ok(out.text.length < 2500, `${out.text.length} chars`)

    const other = fakeRunner(() => ({ code: 1, stderr: "Error: object 'foo' not found\n" }))
    const plain = await invoke(
      other.runner,
      'viz_render',
      { script, inputs: [data], output },
      box.cwd
    )
    assert.match(plain.text, /object 'foo' not found/)
  } finally {
    box.cleanup()
  }
})

test('a timeout, a missing Rscript and a silent success are each called what they are', async () => {
  const box = sandbox()
  try {
    const { script, data } = await prepared(box)
    const output = join(box.cwd, 'o.png')
    const timeout = await invoke(
      fakeRunner(() => ({ code: null, timedOut: true })).runner,
      'viz_render',
      { script, inputs: [data], output, timeout_seconds: 5 },
      box.cwd
    )
    assert.equal(timeout.isError, true)
    assert.match(timeout.text, /timed out after 5 s/i)

    const gone = await invoke(
      fakeRunner(() => ({ code: null, spawnError: 'ENOENT' })).runner,
      'viz_render',
      { script, inputs: [data], output },
      box.cwd
    )
    assert.equal(gone.isError, true)
    assert.match(gone.text, /Rscript.*not found/i)

    const silent = await invoke(
      fakeRunner(() => ({})).runner,
      'viz_render',
      { script, inputs: [data], output },
      box.cwd
    )
    assert.equal(silent.isError, true)
    assert.match(silent.text, /did not write/i)
  } finally {
    box.cleanup()
  }
})

test('viz_render never runs for a script, output or input that is not acceptable', async () => {
  const box = sandbox()
  try {
    const { script, data } = await prepared(box)
    const { runner, calls } = fakeRunner(() => ({}))
    const attempts: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'script outside the project',
        { script: join(box.outside, 'plot.R'), inputs: [data], output: join(box.cwd, 'o.png') },
        /project/i
      ],
      [
        'output outside the project',
        { script, inputs: [data], output: join(box.outside, 'o.png') },
        /project/i
      ],
      [
        'unsupported format',
        { script, inputs: [data], output: join(box.cwd, 'o.gif') },
        /\.png, \.pdf or \.svg/i
      ],
      [
        'missing input',
        { script, inputs: [join(box.outside, 'nope.tsv')], output: join(box.cwd, 'o.png') },
        /nope\.tsv/
      ],
      [
        'missing script',
        {
          script: join(box.cwd, 'plots', 'none.R'),
          inputs: [data],
          output: join(box.cwd, 'o.png')
        },
        /none\.R/
      ],
      [
        'wrong number of inputs',
        { script, inputs: [data, data], output: join(box.cwd, 'o.png') },
        /expects 1 input/i
      ]
    ]
    for (const [name, params, message] of attempts) {
      const out = await invoke(runner, 'viz_render', params, box.cwd)
      assert.equal(out.isError, true, name)
      assert.match(out.text, message, name)
    }
    assert.equal(calls.length, 0)
  } finally {
    box.cleanup()
  }
})

test(
  'end to end: prepare the volcano template, render the example table, and the QA passes',
  { skip: !(has('Rscript') && has('python3')) },
  async () => {
    const box = sandbox()
    try {
      const prep = await invoke(
        undefined,
        'viz_prepare',
        { template_id: 'scatter-volcano', workdir: 'visualizations/volcano' },
        box.cwd
      )
      assert.equal(prep.isError, undefined, prep.text)
      const script = (prep.json() as Prepared).script
      const output = join(box.cwd, 'visualizations', 'volcano', 'volcano.png')

      const out = await invoke(
        undefined,
        'viz_render',
        { script, inputs: [VOLCANO_DATA], output, timeout_seconds: 240 },
        box.cwd
      )

      assert.equal(out.isError, undefined, out.text)
      const body = out.json() as Rendered
      assert.equal(body.ok, true)
      assert.ok(existsSync(output))
      assert.equal(body.qa.ok, true, JSON.stringify(body.qa))
      assert.ok((body.width ?? 0) > 100)
      assert.ok(
        !existsSync(join(box.cwd, 'visualizations', 'volcano', 'Rplots.pdf')),
        'no stray device file'
      )
    } finally {
      box.cleanup()
    }
  }
)

// ── found by rendering every bundled template ─────────────────────────────

test('viz_prepare also copies the files a template reads from its own directory, but not example data', async () => {
  const box = sandbox()
  try {
    const svg = await invoke(
      undefined,
      'viz_prepare',
      { template_id: 'scatter-svg', workdir: 'p/svg' },
      box.cwd
    )
    assert.equal(svg.isError, undefined, svg.text)
    assert.ok(existsSync(join(box.cwd, 'p', 'svg', 'pin.svg')), 'the glyph the template loads')
    assert.deepEqual((svg.json() as Prepared & { assets?: string[] }).assets, ['pin.svg'])

    const icons = await invoke(
      undefined,
      'viz_prepare',
      { template_id: 'bar-svg-icon', workdir: 'p/icon' },
      box.cwd
    )
    assert.ok(
      existsSync(join(box.cwd, 'p', 'icon', 'svg')),
      'a directory of glyphs is copied whole'
    )
    assert.deepEqual((icons.json() as Prepared & { assets?: string[] }).assets, ['svg'])

    const graph = await invoke(
      undefined,
      'viz_prepare',
      { template_id: 'graph-force', workdir: 'p/graph' },
      box.cwd
    )
    assert.equal(
      existsSync(join(box.cwd, 'p', 'graph', 'nodes.tsv')),
      false,
      'example tables are not copied'
    )
    assert.equal(existsSync(join(box.cwd, 'p', 'graph', 'example.tsv')), false)
    assert.equal((graph.json() as { assets?: string[] }).assets, undefined)
  } finally {
    box.cleanup()
  }
})

test('R is run with a UTF-8 locale when the environment has none, and left alone when it has one', async () => {
  const box = sandbox()
  const saved = {
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    LANG: process.env.LANG
  }
  try {
    const { script, data } = await prepared(box)
    const output = join(box.cwd, 'o.png')
    const envSeen: Array<Record<string, string> | undefined> = []
    const { runner } = fakeRunner((call) => {
      if (call.command === 'Rscript') {
        envSeen.push(call.options.env)
        writeFileSync(output, 'PNG')
      }
      return call.command === 'python3' ? { stdout: QA_OK } : {}
    })

    process.env.LC_ALL = 'C'
    process.env.LC_CTYPE = 'C'
    process.env.LANG = 'C'
    await invoke(runner, 'viz_render', { script, inputs: [data], output }, box.cwd)
    assert.match(envSeen[0]?.LC_ALL ?? '', /UTF-8/i)

    process.env.LC_ALL = 'en_GB.UTF-8'
    await invoke(runner, 'viz_render', { script, inputs: [data], output }, box.cwd)
    assert.equal(envSeen[1]?.LC_ALL, undefined, 'an existing UTF-8 locale is not overridden')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    box.cleanup()
  }
})

test(
  'end to end: the templates that need a glyph file or non-ASCII text render from a copy',
  { skip: !(has('Rscript') && has('python3')) },
  async () => {
    const box = sandbox()
    try {
      for (const [id, table] of [
        ['scatter-svg', join('scatter', 'svg', 'example.tsv')],
        ['line-double', join('line', 'double', 'example.tsv')]
      ]) {
        const prep = await invoke(
          undefined,
          'viz_prepare',
          { template_id: id, workdir: `v/${id}` },
          box.cwd
        )
        const script = (prep.json() as Prepared).script
        const out = await invoke(
          undefined,
          'viz_render',
          {
            script,
            inputs: [join(SKILL_ROOT, 'scripts', table)],
            output: join(box.cwd, `${id}.png`),
            timeout_seconds: 240
          },
          box.cwd
        )
        assert.equal(out.isError, undefined, `${id}: ${out.text}`)
      }
    } finally {
      box.cleanup()
    }
  }
)
