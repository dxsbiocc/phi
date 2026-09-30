import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, test } from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'

import { buildEnvironment, describeEnvironment } from '../src/main/agent/content'
import { currentPlatform, removeTree, runInEnvironment } from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'
import { createTestRuntimeRoot } from './helpers/testRuntimeRoot'

const SKILL_ROOT = realpathSync(
  join(process.cwd(), 'resources', 'plugins', 'visualization', 'skills', 'omics-visualization')
)
const VIZ = join(SKILL_ROOT, 'scripts', 'viz.py')
const VOLCANO_DATA = join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'example.tsv')
const ARTIFACT_SCHEMA = JSON.parse(
  readFileSync(join(process.cwd(), 'docs', 'contracts', 'artifact.schema.json'), 'utf8')
) as Record<string, unknown>

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

function has(command: string): boolean {
  return spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
}

// Child Python processes inherit this: nothing under resources/ may gain __pycache__.
process.env.PYTHONDONTWRITEBYTECODE = '1'

const skipPython = has('python3') ? false : 'python3 is not on PATH; viz CLI tests skipped'

const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addFormat('date-time', { type: 'string', validate: (value: string) => DATE_TIME.test(value) })

function validator(name: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(join(SKILL_ROOT, 'schemas', name), 'utf8')) as object
  return ajv.compile(schema)
}

const schemas = {
  examples: validator('viz-examples.json'),
  route: validator('viz-route.json'),
  prepare: validator('viz-prepare.json'),
  render: validator('viz-render.json')
}
const artifactValidator = ajv.compile(ARTIFACT_SCHEMA)

function schemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error: ErrorObject) => `${error.instancePath || '(root)'} ${error.message ?? ''}`.trim())
    .join('; ')
}

interface Sandbox {
  cwd: string
  outside: string
  cleanup: () => void
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-cli-'))
  const cwd = join(root, 'project')
  const outside = join(root, 'elsewhere')
  mkdirSync(cwd)
  mkdirSync(outside)
  return { cwd, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

function runViz(args: string[], cwd: string, env?: NodeJS.ProcessEnv): CliResult {
  const result: SpawnSyncReturns<string> = spawnSync('python3', [VIZ, ...args], {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function ok<T>(result: CliResult, schema: ValidateFunction, label: string): T {
  assert.equal(result.status, 0, `${label}\n${result.stderr}\n${result.stdout}`)
  const parsed = JSON.parse(result.stdout) as T
  assert.equal(result.stdout, `${JSON.stringify(parsed)}\n`, `${label} stdout is one JSON object`)
  assert.equal(schema(parsed), true, `${label}: ${schemaErrors(schema)}`)
  return parsed
}

function failed(result: CliResult, message: RegExp): string {
  assert.equal(result.status, 1, result.stdout)
  const parsed = JSON.parse(result.stdout) as { error?: unknown }
  assert.deepEqual(Object.keys(parsed), ['error'])
  assert.equal(typeof parsed.error, 'string')
  const error = parsed.error as string
  assert.match(error, message)
  assert.equal(result.stdout, `${JSON.stringify({ error })}\n`)
  return error
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0)
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.from(row)))
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"></svg>\n'

interface Prepared {
  template_id: string
  script: string
  existing?: boolean
  assets?: string[]
  inputs: string[]
  run: string
  dependencies: string[]
  purpose: string
  adaptation?: string
  assumptions?: string
  config: { start_line: number; end_line: number; text: string }
  data_preparation: { start_line: number; end_line: number; text: string }
  plot: { start_line: number; end_line: number }
}

function prepare(box: Sandbox, templateId: string, workdir: string, reset = false): Prepared {
  const args = ['prepare', '--template_id', templateId, '--workdir', workdir]
  if (reset) args.push('--reset')
  return ok(runViz(args, box.cwd), schemas.prepare, `prepare ${templateId}`)
}

interface Rendered {
  ok: boolean
  output: string
  bytes: number
  format?: string
  width?: number
  height?: number
  qa: { ok: boolean; failed: string[] }
  messages?: string
  artifacts: string[]
}

function writeFakeRscript(bin: string): void {
  mkdirSync(bin, { recursive: true })
  const script = `#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
mode = os.environ.get("FAKE_R_MODE", "ok")
log = os.environ.get("FAKE_R_LOG")
if log:
    Path(log).write_text(json.dumps({
        "argv": sys.argv[1:],
        "cwd": os.getcwd(),
        "lc_all": os.environ.get("LC_ALL"),
        "skill": os.environ.get("OMICS_VISUALIZATION_SKILL_ROOT"),
    }), encoding="utf-8")
if mode == "timeout":
    time.sleep(30)
output = sys.argv[-1]
if mode == "fail":
    sys.stderr.write(os.environ.get("FAKE_R_STDERR", "Error: failed\\n"))
    raise SystemExit(1)
if mode == "fail-write":
    Path(output).write_bytes(Path(os.environ["FAKE_R_BODY"]).read_bytes())
    sys.stderr.write(os.environ.get("FAKE_R_STDERR", "Error: failed\\n"))
    raise SystemExit(1)
if mode == "silent":
    raise SystemExit(0)
if mode == "empty":
    Path(output).write_bytes(b"")
    raise SystemExit(0)
if mode == "warn":
    sys.stderr.write("warning: check the labels\\n")
Path(output).write_bytes(Path(os.environ["FAKE_R_BODY"]).read_bytes())
`
  writeFileSync(join(bin, 'Rscript'), script, { mode: 0o755 })
}

function fakeEnv(box: Sandbox, extra: Record<string, string>): NodeJS.ProcessEnv {
  const bin = join(box.cwd, '.fake-bin')
  writeFakeRscript(bin)
  return {
    ...process.env,
    PATH: `${bin}${sep === '\\' ? ';' : ':'}${process.env.PATH ?? ''}`,
    ...extra
  }
}

describe('viz.py', { skip: skipPython }, () => {
  test('flag parsing errors are one JSON error and a non-zero exit', () => {
    const box = sandbox()
    try {
      const cases: Array<[string[], RegExp]> = [
        [[], /required|command/i],
        [['nope'], /invalid choice|invalid/i],
        [['examples'], /purpose/],
        [['examples', '--purpose'], /expected one argument|purpose/],
        [['examples', '--purpose', 'volcano', '--top', 'nope'], /invalid int/i],
        [['examples', '--help'], /unrecognized arguments/],
        [['route', '--purpose', 'x'], /data_path/],
        [['route', '--data_path', '/tmp/x', '--purpose', 'x', '--mode', 'draft'], /invalid choice/],
        [['prepare'], /template_id|required/],
        [['render', '--script', 'a', '--output', 'b.png'], /inputs/],
        [
          [
            'render',
            '--script',
            'a',
            '--inputs',
            'b',
            '--output',
            'c.png',
            '--timeout_seconds',
            'x'
          ],
          /invalid int/i
        ]
      ]
      for (const [args, message] of cases) {
        failed(runViz(args, box.cwd), message)
      }
    } finally {
      box.cleanup()
    }
  })

  test('examples returns installed preview images and writes nothing', () => {
    const box = sandbox()
    try {
      const preview = realpathSync(join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'preview.png'))
      const original = readFileSync(preview)
      const body = ok<{
        purpose: string
        dataFitted: boolean
        candidates: Array<{ template_id: string; preview: string; preview_markdown: string }>
      }>(runViz(['examples', '--purpose', ' volcano plot '], box.cwd), schemas.examples, 'examples')
      assert.equal(body.purpose, 'volcano plot')
      assert.equal(body.dataFitted, false)
      const volcano = body.candidates.find((item) => item.template_id === 'scatter-volcano')
      assert.ok(volcano)
      assert.equal(volcano.preview, preview)
      assert.equal(volcano.preview_markdown, `![scatter-volcano](${preview})`)
      assert.deepEqual(readFileSync(preview), original)
      assert.deepEqual(readdirSync(box.cwd), [])
    } finally {
      box.cleanup()
    }
  })

  test('examples recognizes a Chinese request and clamps the shortlist to four', () => {
    const box = sandbox()
    try {
      const body = ok<{
        dataFitted: boolean
        candidates: Array<{ template_id: string; preview: string }>
      }>(
        runViz(['examples', '--purpose', '给我看几个火山图示例', '--top', '99'], box.cwd),
        schemas.examples,
        'chinese examples'
      )
      assert.equal(body.dataFitted, false)
      assert.ok(body.candidates.some((item) => item.template_id === 'scatter-volcano'))
      assert.ok(body.candidates.length <= 4)
      assert.ok(body.candidates.every((item) => existsSync(item.preview)))
      assert.ok(body.candidates.every((item) => item.preview.endsWith(`${sep}preview.png`)))
    } finally {
      box.cleanup()
    }
  })

  test('every catalog preview is an installed template image', () => {
    const catalog = JSON.parse(
      readFileSync(join(SKILL_ROOT, 'references', 'template_contracts.json'), 'utf8')
    ) as { templates: Array<{ id: string; preview: string }> }
    assert.ok(catalog.templates.length > 0)
    for (const template of catalog.templates) {
      const parts = template.preview.split('/')
      assert.equal(parts.length, 4, template.id)
      assert.equal(parts[0], 'scripts', template.id)
      assert.equal(parts[3], 'preview.png', template.id)
      const preview = join(SKILL_ROOT, template.preview)
      assert.equal(existsSync(preview), true, template.id)
    }
  })

  test('only an installed template preview path is accepted', () => {
    const preview = realpathSync(join(SKILL_ROOT, 'scripts', 'scatter', 'volcano', 'preview.png'))
    const probe = spawnSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, json, sys',
          'spec = importlib.util.spec_from_file_location("vizmod", sys.argv[1])',
          'mod = importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(mod)',
          'print(json.dumps({',
          '  "preview": mod.is_installed_preview(sys.argv[2]),',
          '  "data": mod.is_installed_preview(sys.argv[3]),',
          '  "other": mod.is_installed_preview("/tmp/other/preview.png"),',
          '}))'
        ].join('\n'),
        VIZ,
        preview,
        VOLCANO_DATA
      ],
      { encoding: 'utf8' }
    )
    assert.equal(probe.status, 0, probe.stderr)
    const report = JSON.parse(probe.stdout) as { preview: boolean; data: boolean; other: boolean }
    assert.equal(report.preview, true)
    assert.equal(report.data, false)
    assert.equal(report.other, false)
  })

  test('examples reports no match and writes nothing', () => {
    const box = sandbox()
    try {
      const body = ok<{ candidates: unknown[]; totalMatches: number }>(
        runViz(['examples', '--purpose', 'zzzz-no-such-figure-family'], box.cwd),
        schemas.examples,
        'no match'
      )
      assert.deepEqual(body.candidates, [])
      assert.equal(body.totalMatches, 0)
      assert.deepEqual(readdirSync(box.cwd), [])
    } finally {
      box.cleanup()
    }
  })

  test('route puts the volcano template first and clamps the shortlist', () => {
    const box = sandbox()
    try {
      const purpose = 'volcano plot of differential expression'
      const base = ['route', '--data_path', VOLCANO_DATA, '--purpose', purpose]
      const body = ok<{
        input: { rows: number; columns: Array<{ name: string; type: string }> }
        candidates: Array<{ template_id: string; why: string[]; preview: string; score: number }>
      }>(runViz([...base, '--top', '4'], box.cwd), schemas.route, 'route')
      assert.equal(body.candidates[0]?.template_id, 'scatter-volcano')
      assert.equal(body.candidates.length, 4)
      assert.ok(body.candidates.every((item) => item.why.length <= 3 && item.why.length > 0))
      assert.equal(body.input.columns.find((column) => column.name === 'log2FC')?.type, 'number')
      assert.ok(body.input.rows > 0)
      assert.equal(existsSync(body.candidates[0].preview), true)
      const one = ok<{ candidates: unknown[] }>(
        runViz([...base, '--top', '1'], box.cwd),
        schemas.route,
        'top 1'
      )
      assert.equal(one.candidates.length, 1)
      const clamped = ok<{ candidates: unknown[] }>(
        runViz([...base, '--top', '99'], box.cwd),
        schemas.route,
        'top 99'
      )
      assert.equal(clamped.candidates.length, 6)
      const def = ok<{ candidates: unknown[] }>(runViz(base, box.cwd), schemas.route, 'default top')
      assert.equal(def.candidates.length, 4)
      const zero = ok<{ candidates: unknown[] }>(
        runViz([...base, '--top', '0'], box.cwd),
        schemas.route,
        'top 0'
      )
      assert.equal(zero.candidates.length, 1)
    } finally {
      box.cleanup()
    }
  })

  test('publication mode names the extra review, and a sidecar directory is reported', () => {
    const box = sandbox()
    try {
      const published = ok<{ candidates: Array<{ risks: string[] }> }>(
        runViz(
          [
            'route',
            '--data_path',
            VOLCANO_DATA,
            '--purpose',
            'volcano plot of differential expression',
            '--mode',
            'publication',
            '--top',
            '1'
          ],
          box.cwd
        ),
        schemas.route,
        'publication'
      )
      assert.match(published.candidates[0].risks.join('\n'), /publication mode/i)
      const nodes = join(SKILL_ROOT, 'scripts', 'graph', 'force', 'nodes.tsv')
      const sided = ok<{ input: { sidecars?: string[]; sidecar_alignment?: string } }>(
        runViz(
          [
            'route',
            '--data_path',
            nodes,
            '--purpose',
            'network graph of nodes and links',
            '--sidecar_dir',
            join(SKILL_ROOT, 'scripts', 'graph', 'force'),
            '--top',
            '2'
          ],
          box.cwd
        ),
        schemas.route,
        'sidecars'
      )
      assert.ok(sided.input.sidecars?.includes('links.tsv'))
      assert.equal(typeof sided.input.sidecar_alignment, 'string')
    } finally {
      box.cleanup()
    }
  })

  test('route explains a missing table and a router failure', () => {
    const box = sandbox()
    try {
      const missing = join(box.outside, 'no.tsv')
      const error = failed(
        runViz(['route', '--data_path', missing, '--purpose', 'x'], box.cwd),
        /not found/
      )
      assert.match(error, /no\.tsv/)
      const blocked = join(box.outside, 'secret.tsv')
      writeFileSync(blocked, 'a\tb\n1\t2\n')
      chmodSync(blocked, 0o000)
      try {
        const denied = failed(
          runViz(['route', '--data_path', blocked, '--purpose', 'x'], box.cwd),
          /template router failed/
        )
        assert.ok(denied.length < 2000, `${denied.length} chars`)
      } finally {
        chmodSync(blocked, 0o644)
      }
    } finally {
      box.cleanup()
    }
  })

  test('prepare copies the volcano template and fixes the helper path', () => {
    const box = sandbox()
    try {
      const body = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'volcano'))
      const script = join(box.cwd, 'plots', 'volcano', 'plot.R')
      assert.equal(body.script, script)
      assert.equal(body.template_id, 'scatter-volcano')
      assert.deepEqual(body.inputs, ['input'])
      assert.deepEqual(body.dependencies, ['ggplot2', 'readr', 'ggprism', 'ggrepel'])
      assert.match(body.run, /Rscript .*plot\.R <input> <output>/)
      assert.match(body.purpose, /volcano/i)
      assert.match(body.adaptation ?? '', /CONFIG/)
      assert.match(body.assumptions ?? '', /q-values are floored/i)
      const copied = readFileSync(script, 'utf8')
      assert.ok(copied.includes(`source("${join(SKILL_ROOT, 'scripts', 'lib', 'common.R')}")`))
      assert.doesNotMatch(copied, /Cannot find scripts\/lib\/common\.R/)
      assert.doesNotMatch(copied, /^local\(\{/m)
      const lines = copied.split('\n')
      assert.equal(
        lines.slice(body.config.start_line - 1, body.config.end_line).join('\n'),
        body.config.text
      )
      assert.equal(
        lines
          .slice(body.data_preparation.start_line - 1, body.data_preparation.end_line)
          .join('\n'),
        body.data_preparation.text
      )
      assert.match(body.config.text, /columns = list\(/)
      assert.match(body.data_preparation.text, /read_table_auto/)
      assert.ok(body.plot.start_line > body.data_preparation.end_line)
      assert.equal(JSON.stringify(body).includes('geom_point'), false)
    } finally {
      box.cleanup()
    }
  })

  test('prepare keeps an edited copy unless reset is set', () => {
    const box = sandbox()
    try {
      const workdir = join(box.cwd, 'plots', 'v')
      prepare(box, 'scatter-volcano', workdir)
      const script = join(workdir, 'plot.R')
      writeFileSync(script, `${readFileSync(script, 'utf8')}\n# my edit\n`)
      const again = prepare(box, 'scatter-volcano', workdir)
      assert.equal(again.existing, true)
      assert.match(readFileSync(script, 'utf8'), /# my edit/)
      const reset = prepare(box, 'scatter-volcano', workdir, true)
      assert.equal(reset.existing, undefined)
      assert.doesNotMatch(readFileSync(script, 'utf8'), /# my edit/)
    } finally {
      box.cleanup()
    }
  })

  test('prepare copies glyphs and skips example tables', () => {
    const box = sandbox()
    try {
      const svg = prepare(box, 'scatter-svg', join(box.cwd, 'p', 'svg'))
      assert.equal(existsSync(join(box.cwd, 'p', 'svg', 'pin.svg')), true)
      assert.deepEqual(svg.assets, ['pin.svg'])
      const icons = prepare(box, 'bar-svg-icon', join(box.cwd, 'p', 'icon'))
      assert.equal(existsSync(join(box.cwd, 'p', 'icon', 'svg')), true)
      assert.deepEqual(icons.assets, ['svg'])
      const graph = prepare(box, 'graph-force', join(box.cwd, 'p', 'graph'))
      assert.equal(existsSync(join(box.cwd, 'p', 'graph', 'nodes.tsv')), false)
      assert.equal(existsSync(join(box.cwd, 'p', 'graph', 'links.tsv')), false)
      assert.equal(graph.assets, undefined)
      assert.deepEqual(graph.inputs, ['nodes', 'links'])
    } finally {
      box.cleanup()
    }
  })

  test('prepare refuses a working directory outside the project', () => {
    const box = sandbox()
    try {
      for (const workdir of [box.outside, '../elsewhere/plots', join(box.cwd, '..', 'elsewhere')]) {
        failed(
          runViz(['prepare', '--template_id', 'scatter-volcano', '--workdir', workdir], box.cwd),
          /project/i
        )
      }
      assert.equal(existsSync(join(box.outside, 'plots')), false)
      assert.equal(existsSync(join(box.outside, 'plot.R')), false)
      symlinkSync(box.outside, join(box.cwd, 'link'))
      failed(
        runViz(['prepare', '--template_id', 'scatter-volcano', '--workdir', 'link/plots'], box.cwd),
        /project/i
      )
      assert.equal(existsSync(join(box.outside, 'plots', 'plot.R')), false)
    } finally {
      box.cleanup()
    }
  })

  test('prepare names the closest template and rejects a blank id', () => {
    const box = sandbox()
    try {
      const error = failed(
        runViz(['prepare', '--template_id', 'scatter-volcanoo', '--workdir', 'p'], box.cwd),
        /scatter-volcanoo/
      )
      assert.match(error, /scatter-volcano\b/)
      assert.match(error, /viz_route/)
      assert.equal(existsSync(join(box.cwd, 'p')), false)
      failed(
        runViz(['prepare', '--template_id', ' ', '--workdir', 'p'], box.cwd),
        /template_id and workdir are required/
      )
    } finally {
      box.cleanup()
    }
  })

  test('render runs the script, checks the figure, and writes a descriptor', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const output = join(box.cwd, 'plots', 'v', 'volcano.png')
      const log = join(box.cwd, 'r.log')
      const bodyFile = join(box.cwd, 'body.png')
      writeFileSync(bodyFile, png(64, 48))
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const body = ok<Rendered>(
        runViz(
          [
            'render',
            '--script',
            prepared.script,
            '--inputs',
            data,
            '--output',
            output,
            '--timeout_seconds',
            '30'
          ],
          box.cwd,
          fakeEnv(box, {
            FAKE_R_MODE: 'warn',
            FAKE_R_BODY: bodyFile,
            FAKE_R_LOG: log
          })
        ),
        schemas.render,
        'render'
      )
      const seen = JSON.parse(readFileSync(log, 'utf8')) as {
        argv: string[]
        cwd: string
        skill?: string
      }
      assert.deepEqual(seen.argv, [prepared.script, data, output])
      assert.equal(realpathSync(seen.cwd), realpathSync(join(box.cwd, 'plots', 'v')))
      assert.equal(seen.skill, SKILL_ROOT)
      assert.equal(body.ok, true)
      assert.equal(body.output, output)
      assert.equal(body.format, 'png')
      assert.equal(body.width, 64)
      assert.equal(body.height, 48)
      assert.equal(body.qa.ok, true)
      assert.deepEqual(body.qa.failed, [])
      assert.match(body.messages ?? '', /warning/)
      assert.deepEqual(body.artifacts, ['plots/v/volcano.png'])
      const descriptor = JSON.parse(readFileSync(`${output}.phi-artifact.json`, 'utf8')) as {
        contractVersion: string
        kind: string
        file: string
        mediaType: string
        title: string
        figure: { format: string; widthPx?: number; heightPx?: number }
        provenance: {
          createdAt: string
          tool: string
          skill: string
          script: string
          inputs: Array<{ path: string; sha256: string }>
          parameters?: { timeout_seconds?: number }
        }
      }
      assert.equal(artifactValidator(descriptor), true, schemaErrors(artifactValidator))
      assert.equal(descriptor.contractVersion, '1.0.0')
      assert.equal(descriptor.kind, 'figure')
      assert.equal(descriptor.file, 'volcano.png')
      assert.equal(descriptor.mediaType, 'image/png')
      assert.equal(descriptor.title, 'volcano.png')
      assert.equal(descriptor.figure.format, 'png')
      assert.equal(descriptor.figure.widthPx, 64)
      assert.equal(descriptor.figure.heightPx, 48)
      assert.equal(descriptor.provenance.tool, 'viz_render')
      assert.equal(descriptor.provenance.skill, 'omics-visualization')
      assert.equal(descriptor.provenance.script, 'plots/v/plot.R')
      assert.equal(descriptor.provenance.parameters?.timeout_seconds, 30)
      assert.match(descriptor.provenance.createdAt, DATE_TIME)
      assert.equal(descriptor.provenance.inputs[0]?.path.startsWith('../'), true)
      assert.equal(
        descriptor.provenance.inputs[0]?.sha256,
        createHash('sha256').update(readFileSync(data)).digest('hex')
      )
    } finally {
      box.cleanup()
    }
  })

  test('an svg uses the template title and omits a timeout that was not requested', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const scriptText = readFileSync(prepared.script, 'utf8')
      writeFileSync(prepared.script, `# Title: Edited volcano title\n${scriptText}`)
      const output = join(box.cwd, 'plots', 'v', 'figure.svg')
      const bodyFile = join(box.cwd, 'body.svg')
      writeFileSync(bodyFile, SVG)
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const body = ok<Rendered>(
        runViz(
          ['render', '--script', prepared.script, '--inputs', data, '--output', output],
          box.cwd,
          fakeEnv(box, { FAKE_R_BODY: bodyFile })
        ),
        schemas.render,
        'svg'
      )
      assert.equal(body.format, 'svg')
      assert.equal(body.width, 64)
      assert.equal(body.height, 48)
      assert.equal(body.qa.ok, true)
      const descriptor = JSON.parse(readFileSync(`${output}.phi-artifact.json`, 'utf8')) as {
        title: string
        mediaType: string
        figure: { format: string; widthPx?: number }
        provenance: { parameters?: unknown; inputs: Array<{ path: string }> }
      }
      assert.equal(artifactValidator(descriptor), true, schemaErrors(artifactValidator))
      assert.equal(descriptor.title, 'Edited volcano title')
      assert.equal(descriptor.mediaType, 'image/svg+xml')
      assert.equal(descriptor.figure.format, 'svg')
      assert.equal(descriptor.figure.widthPx, undefined)
      assert.equal(descriptor.provenance.parameters, undefined)
      assert.equal(descriptor.provenance.inputs[0]?.path.startsWith('../'), true)
    } finally {
      box.cleanup()
    }
  })

  test('a failed QA check is named and the render still succeeds', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const output = join(box.cwd, 'plots', 'v', 'tiny.png')
      const bodyFile = join(box.cwd, 'body.png')
      writeFileSync(bodyFile, png(1, 1))
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const body = ok<Rendered>(
        runViz(
          ['render', '--script', prepared.script, '--inputs', data, '--output', output],
          box.cwd,
          fakeEnv(box, { FAKE_R_BODY: bodyFile })
        ),
        schemas.render,
        'tiny'
      )
      assert.equal(body.ok, true)
      assert.equal(body.qa.ok, false)
      assert.deepEqual(body.qa.failed, ['min_dimensions'])
      assert.equal(existsSync(`${output}.phi-artifact.json`), true)
    } finally {
      box.cleanup()
    }
  })

  test('an R failure names a missing package and writes no descriptor', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const output = join(box.cwd, 'plots', 'v', 'o.png')
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const noisy = `${'progress line\n'.repeat(400)}Error in library(ggprism) : there is no package called ‘ggprism’\nExecution halted\n`
      const error = failed(
        runViz(
          ['render', '--script', prepared.script, '--inputs', data, '--output', output],
          box.cwd,
          fakeEnv(box, { FAKE_R_MODE: 'fail', FAKE_R_STDERR: noisy })
        ),
        /ggprism/
      )
      assert.match(error, /not installed|missing/i)
      assert.match(error, /do not install|report/i)
      assert.ok(error.length < 2500, `${error.length} chars`)
      assert.equal(existsSync(`${output}.phi-artifact.json`), false)
      const plain = failed(
        runViz(
          ['render', '--script', prepared.script, '--inputs', data, '--output', output],
          box.cwd,
          fakeEnv(box, {
            FAKE_R_MODE: 'fail-write',
            FAKE_R_BODY: VOLCANO_DATA,
            FAKE_R_STDERR: "Error: object 'foo' not found\n"
          })
        ),
        /object 'foo' not found/
      )
      assert.match(plain, /R failed/)
      assert.equal(existsSync(`${output}.phi-artifact.json`), false)
    } finally {
      box.cleanup()
    }
  })

  test(
    'a timeout and a silent success are reported, with no descriptor',
    { timeout: 20_000 },
    () => {
      const box = sandbox()
      try {
        const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
        const output = join(box.cwd, 'plots', 'v', 'o.png')
        const data = join(box.outside, 'de.tsv')
        writeFileSync(data, 'a\tb\n1\t2\n')
        failed(
          runViz(
            [
              'render',
              '--script',
              prepared.script,
              '--inputs',
              data,
              '--output',
              output,
              '--timeout_seconds',
              '1'
            ],
            box.cwd,
            fakeEnv(box, { FAKE_R_MODE: 'timeout' })
          ),
          /timed out after 1 s/
        )
        assert.equal(existsSync(`${output}.phi-artifact.json`), false)
        failed(
          runViz(
            ['render', '--script', prepared.script, '--inputs', data, '--output', output],
            box.cwd,
            fakeEnv(box, { FAKE_R_MODE: 'silent' })
          ),
          /did not write/
        )
        assert.equal(existsSync(`${output}.phi-artifact.json`), false)
        failed(
          runViz(
            ['render', '--script', prepared.script, '--inputs', data, '--output', output],
            box.cwd,
            fakeEnv(box, { FAKE_R_MODE: 'empty', FAKE_R_BODY: VOLCANO_DATA })
          ),
          /did not write/
        )
        assert.equal(existsSync(output), true)
        assert.equal(existsSync(`${output}.phi-artifact.json`), false)
      } finally {
        box.cleanup()
      }
    }
  )

  test('render refuses a bad script, output, or input before starting R', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const log = join(box.cwd, 'r.log')
      const env = fakeEnv(box, { FAKE_R_LOG: log, FAKE_R_BODY: VOLCANO_DATA })
      const output = join(box.cwd, 'o.png')
      const cases: Array<[string[], RegExp]> = [
        [
          ['render', '--script', join(box.outside, 'plot.R'), '--inputs', data, '--output', output],
          /project/i
        ],
        [
          [
            'render',
            '--script',
            prepared.script,
            '--inputs',
            data,
            '--output',
            join(box.outside, 'o.png')
          ],
          /project/i
        ],
        [
          [
            'render',
            '--script',
            prepared.script,
            '--inputs',
            data,
            '--output',
            join(box.cwd, 'o.gif')
          ],
          /\.png, \.pdf or \.svg/
        ],
        [
          [
            'render',
            '--script',
            prepared.script,
            '--inputs',
            join(box.outside, 'nope.tsv'),
            '--output',
            output
          ],
          /nope\.tsv/
        ],
        [
          [
            'render',
            '--script',
            join(box.cwd, 'plots', 'none.R'),
            '--inputs',
            data,
            '--output',
            output
          ],
          /none\.R/
        ],
        [
          [
            'render',
            '--script',
            prepared.script,
            '--inputs',
            data,
            '--inputs',
            data,
            '--output',
            output
          ],
          /expects 1 input/
        ],
        [
          ['render', '--script', prepared.script, '--inputs', '   ', '--output', output],
          /at least one input/i
        ]
      ]
      for (const [args, message] of cases) {
        failed(runViz(args, box.cwd, env), message)
      }
      assert.equal(existsSync(log), false)
    } finally {
      box.cleanup()
    }
  })

  test('R gets a UTF-8 locale only when the environment has none', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const output = join(box.cwd, 'o.png')
      const bodyFile = join(box.cwd, 'body.png')
      writeFileSync(bodyFile, png(64, 48))
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const log = join(box.cwd, 'r.log')
      const args = ['render', '--script', prepared.script, '--inputs', data, '--output', output]
      const plain = fakeEnv(box, { FAKE_R_BODY: bodyFile, FAKE_R_LOG: log })
      plain.LC_ALL = 'C'
      plain.LC_CTYPE = 'C'
      plain.LANG = 'C'
      ok(runViz(args, box.cwd, plain), schemas.render, 'locale')
      const first = JSON.parse(readFileSync(log, 'utf8')) as { lc_all?: string }
      assert.match(first.lc_all ?? '', /UTF-8/)
      const kept = fakeEnv(box, { FAKE_R_BODY: bodyFile, FAKE_R_LOG: log })
      kept.LC_ALL = 'en_GB.UTF-8'
      ok(runViz(args, box.cwd, kept), schemas.render, 'locale kept')
      const second = JSON.parse(readFileSync(log, 'utf8')) as { lc_all?: string }
      assert.equal(second.lc_all, 'en_GB.UTF-8')
    } finally {
      box.cleanup()
    }
  })

  test('a missing Rscript is a dependency error and does not render', () => {
    const box = sandbox()
    try {
      const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'plots', 'v'))
      const data = join(box.outside, 'de.tsv')
      writeFileSync(data, 'a\tb\n1\t2\n')
      const pythonBin = dirname(
        spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
          encoding: 'utf8'
        }).stdout.trim()
      )
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${pythonBin}:/usr/bin:/bin` }
      delete env.LC_ALL
      failed(
        runViz(
          [
            'render',
            '--script',
            prepared.script,
            '--inputs',
            data,
            '--output',
            join(box.cwd, 'o.png')
          ],
          box.cwd,
          env
        ),
        /Rscript was not found \(ENOENT\)/
      )
    } finally {
      box.cleanup()
    }
  })

  test(
    'every bundled template parses, and patched copies stay valid R',
    { timeout: 180_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'phi-viz-patched-'))
      const probe = join(dir, 'probe.py')
      writeFileSync(
        probe,
        `
import importlib.util, json, pathlib, re, sys
viz_path, out_dir = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("vizmod", viz_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sources = mod.list_template_sources()
problems = []
ids = []
ident = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+$")
for source in sources:
    ids.append(source["id"])
    if ident.fullmatch(source["id"]) is None:
        problems.append(source["id"] + " id")
    if "config" not in source or "data_preparation" not in source:
        problems.append(source["id"] + " sections")
    if not source.get("dependencies"):
        problems.append(source["id"] + " deps")
    if not source.get("input_names"):
        problems.append(source["id"] + " inputs")
    if not str(source.get("path", "")).endswith("plot.R"):
        problems.append(source["id"] + " path")
two = next((source["input_names"] for source in sources if len(source["input_names"]) == 2), [])
volcano = next(source for source in sources if source["id"] == "scatter-volcano")
original = pathlib.Path(volcano["path"]).read_text(encoding="utf-8")
common = "/skill/scripts/lib/common.R"
patched = mod.patch_bootstrap(original, common)
quoted = mod.patch_bootstrap(original, 'C:\\\\skill "x"\\\\common.R')
try:
    mod.patch_bootstrap("io <- parse_io_args()\\n", "/x/common.R")
    refused = False
except ValueError:
    refused = True
out = pathlib.Path(out_dir)
files = []
for index, source in enumerate(sources):
    target = out / f"t{index}.R"
    text = pathlib.Path(source["path"]).read_text(encoding="utf-8")
    target.write_text(mod.patch_bootstrap(text, "/x/common.R"), encoding="utf-8")
    files.append(str(target))
(out / "files.txt").write_text("\\n".join(files), encoding="utf-8")
print(json.dumps({
    "count": len(sources),
    "unique": len(set(ids)) == len(ids),
    "problems": problems[:8],
    "two": two,
    "source_line": next(line for line in quoted.splitlines() if line.startswith("source(")),
    "source_ok": f'source("{common}")' in patched.splitlines(),
    "no_missing": "Cannot find scripts/lib/common.R" not in patched,
    "no_local": not any(line.startswith("local({") for line in patched.splitlines()),
    "tail_same": patched.split("io <- parse_io_args()", 1)[1] == original.split("io <- parse_io_args()", 1)[1],
    "patched_id": mod.parse_template_source(patched)["id"],
    "refused": refused,
}))
`
      )
      try {
        const probeResult = spawnSync('python3', [probe, VIZ, dir], { encoding: 'utf8' })
        assert.equal(probeResult.status, 0, probeResult.stderr)
        const report = JSON.parse(probeResult.stdout) as {
          count: number
          unique: boolean
          problems: string[]
          two: string[]
          source_line: string
          source_ok: boolean
          no_missing: boolean
          no_local: boolean
          tail_same: boolean
          patched_id: string
          refused: boolean
        }
        assert.ok(report.count >= 150, `found ${report.count}`)
        assert.equal(report.unique, true)
        assert.deepEqual(report.problems, [])
        assert.ok(report.two.every((name) => /^[a-z_]+$/.test(name)))
        assert.equal(report.source_line, 'source("C:\\\\skill \\"x\\"\\\\common.R")')
        assert.equal(report.source_ok, true)
        assert.equal(report.no_missing, true)
        assert.equal(report.no_local, true)
        assert.equal(report.tail_same, true)
        assert.equal(report.patched_id, 'scatter-volcano')
        assert.equal(report.refused, true)
        if (!has('Rscript')) return
        const parsed = spawnSync(
          'Rscript',
          [
            '-e',
            `bad <- 0; for (f in readLines(${JSON.stringify(join(dir, 'files.txt'))})) { ok <- tryCatch({ parse(f); TRUE }, error = function(e) { cat("BAD", f, conditionMessage(e), "\\n"); FALSE }); if (!ok) bad <- bad + 1 }; cat("bad:", bad, "\\n")`
          ],
          { encoding: 'utf8' }
        )
        assert.equal(parsed.status, 0, parsed.stderr)
        assert.match(parsed.stdout, /bad: 0/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  test(
    'end to end: prepare the volcano template and render the example table',
    {
      timeout: 240_000,
      skip: has('Rscript') ? false : 'Rscript is not on PATH; host render skipped'
    },
    () => {
      const box = sandbox()
      try {
        const prepared = prepare(box, 'scatter-volcano', join(box.cwd, 'visualizations', 'volcano'))
        const output = join(box.cwd, 'visualizations', 'volcano', 'volcano.png')
        const body = ok<Rendered>(
          runViz(
            [
              'render',
              '--script',
              prepared.script,
              '--inputs',
              VOLCANO_DATA,
              '--output',
              output,
              '--timeout_seconds',
              '240'
            ],
            box.cwd
          ),
          schemas.render,
          'host render'
        )
        assert.equal(body.ok, true)
        assert.equal(body.qa.ok, true, JSON.stringify(body.qa))
        assert.ok((body.width ?? 0) > 100)
        assert.equal(existsSync(join(box.cwd, 'visualizations', 'volcano', 'Rplots.pdf')), false)
        assert.equal(
          artifactValidator(JSON.parse(readFileSync(`${output}.phi-artifact.json`, 'utf8'))),
          true,
          schemaErrors(artifactValidator)
        )
      } finally {
        box.cleanup()
      }
    }
  )

  test(
    'end to end: glyph and non-ASCII templates render from a copy',
    {
      timeout: 600_000,
      skip: has('Rscript') ? false : 'Rscript is not on PATH; host render skipped'
    },
    () => {
      const box = sandbox()
      try {
        for (const [id, table] of [
          ['scatter-svg', join('scatter', 'svg', 'example.tsv')],
          ['line-double', join('line', 'double', 'example.tsv')]
        ] as const) {
          const prepared = prepare(box, id, join(box.cwd, 'v', id))
          const output = join(box.cwd, `${id}.png`)
          const body = ok<Rendered>(
            runViz(
              [
                'render',
                '--script',
                prepared.script,
                '--inputs',
                join(SKILL_ROOT, 'scripts', table),
                '--output',
                output,
                '--timeout_seconds',
                '240'
              ],
              box.cwd
            ),
            schemas.render,
            id
          )
          assert.equal(body.qa.ok, true, `${id} ${JSON.stringify(body.qa)}`)
          assert.equal(existsSync(output), true)
        }
      } finally {
        box.cleanup()
      }
    }
  )
})

function integrationSkip(): string | false {
  if (process.env.PHI_RUNTIME_INTEGRATION !== '1') {
    return 'network integration: set PHI_RUNTIME_INTEGRATION=1'
  }
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1; integration tests skipped'
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bundled micromamba is unavailable'
    return `${message}; integration tests skipped`
  }
}

test(
  'integration: the viz environment runs route, prepare, and render',
  { timeout: 1_200_000, skip: integrationSkip() },
  async () => {
    const root = createTestRuntimeRoot('viz-cli')
    const runtimeRoot = realpathSync(root)
    const project = join(runtimeRoot, 'project')
    mkdirSync(project)
    try {
      const descriptor = describeEnvironment('plugin:viz', { platform: currentPlatform() })
      const env = await buildEnvironment(runtimeRoot, descriptor)
      const routed = await runInEnvironment(
        env,
        [
          'python',
          VIZ,
          'route',
          '--data_path',
          VOLCANO_DATA,
          '--purpose',
          'volcano plot of differential expression',
          '--top',
          '1'
        ],
        { cwd: project, timeoutMs: 120_000 }
      )
      assert.equal(routed.exitCode, 0, routed.stderr)
      const routeBody = JSON.parse(routed.stdout) as { candidates: Array<{ template_id: string }> }
      assert.equal(routeBody.candidates[0]?.template_id, 'scatter-volcano')
      const workdir = join(project, 'visualizations', 'volcano')
      const prepared = await runInEnvironment(
        env,
        ['python', VIZ, 'prepare', '--template_id', 'scatter-volcano', '--workdir', workdir],
        { cwd: project, timeoutMs: 60_000 }
      )
      assert.equal(prepared.exitCode, 0, prepared.stderr)
      const prep = JSON.parse(prepared.stdout) as { script: string }
      const output = join(workdir, 'volcano.png')
      const rendered = await runInEnvironment(
        env,
        [
          'python',
          VIZ,
          'render',
          '--script',
          prep.script,
          '--inputs',
          VOLCANO_DATA,
          '--output',
          output,
          '--timeout_seconds',
          '240'
        ],
        { cwd: project, timeoutMs: 300_000 }
      )
      assert.equal(rendered.exitCode, 0, `${rendered.stderr}\n${rendered.stdout}`)
      const body = JSON.parse(rendered.stdout) as { qa: { ok: boolean }; artifacts: string[] }
      assert.equal(body.qa.ok, true, JSON.stringify(body.qa))
      assert.ok(readFileSync(output).length > 100)
      assert.equal(
        artifactValidator(JSON.parse(readFileSync(`${output}.phi-artifact.json`, 'utf8'))),
        true,
        schemaErrors(artifactValidator)
      )
      assert.deepEqual(body.artifacts, ['visualizations/volcano/volcano.png'])
    } finally {
      removeTree(root)
    }
  }
)
