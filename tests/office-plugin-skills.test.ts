import assert from 'node:assert/strict'
import {
  chmodSync,
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
import { delimiter as pathDelimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import Ajv from 'ajv'
import { parse as parseYaml } from 'yaml'

import { validatePlugin } from '../src/main/agent/plugins/validate'
import { parseSkillFile, scriptToolsOf, validateSkill } from '../src/main/agent/content/skill'
import { buildSkillRunTool } from '../src/main/agent/content/skill-tools'
import { buildPresentFilesTool } from '../src/main/agent/deliverables/present-tool'
import { buildNotebookCustomTools } from '../src/main/agent/notebook/notebook-tools'

const REPO_ROOT = join(import.meta.dirname, '..')
const OFFICE_PLUGIN_DIR = join(REPO_ROOT, 'resources', 'plugins', 'office')
const OFFICE_SKILLS = ['docx', 'office-workflow', 'pdf', 'pptx', 'xlsx']

test('the bundled office plugin owns five managed-Python skills and no private runtime', () => {
  const result = validatePlugin(OFFICE_PLUGIN_DIR)

  assert.deepEqual(
    result.errors,
    [],
    result.errors.map((problem) => `${problem.path}: ${problem.message}`).join('\n')
  )
  assert.deepEqual(result.warnings, [])
  assert(result.plugin)
  assert.equal(result.plugin.manifest.id, 'office')
  assert.equal(result.plugin.manifest.toolPrefix, 'officepy')
  assert.equal(result.plugin.manifest.environments, undefined)
  assert.deepEqual(result.plugin.agents, [])
  assert.equal(existsSync(join(OFFICE_PLUGIN_DIR, 'agents')), false)
  assert.deepEqual(result.plugin.skills.map((skill) => skill.name).sort(), OFFICE_SKILLS)

  for (const name of ['xlsx', 'pptx', 'pdf']) {
    assert.equal(existsSync(join(REPO_ROOT, 'resources', 'skills', name)), false)
  }
})

test('every final office plugin script tool name is globally unique inside the plugin', () => {
  const result = validatePlugin(OFFICE_PLUGIN_DIR)
  assert(result.plugin)
  const names = result.plugin.skills.flatMap((skill) =>
    scriptToolsOf(skill, { prefix: result.plugin?.manifest.toolPrefix ?? '' }).map(
      (tool) => tool.name
    )
  )

  assert.equal(new Set(names).size, names.length, names.join(', '))
  assert(names.includes('officepy_docx_inspect'))
  assert(names.includes('officepy_pdf_inspect'))
  assert(names.includes('officepy_extract_text'))
})

test('the migrated skills use only phi:python@1 and contain no unmanaged dependency guidance', () => {
  for (const name of OFFICE_SKILLS) {
    const result = validateSkill(join(OFFICE_PLUGIN_DIR, 'skills', name), { insidePlugin: true })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.warnings, [])
    assert(result.skill)
    assert.equal(result.skill.phi?.environment, 'phi:python@1')
    if (['xlsx', 'pptx', 'pdf'].includes(name)) {
      assert.equal(result.skill.frontmatter.compatibility, 'Runs in phi:python@1.')
    }
  }

  const forbidden =
    /\b(?:soffice|libreoffice|gcc|gtimeout)\b|请自行安装|(?:pip|npm|brew|apt(?:-get)?)\s+install/iu
  for (const path of textFiles(OFFICE_PLUGIN_DIR)) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), forbidden, path)
  }

  for (const path of textFiles(join(OFFICE_PLUGIN_DIR, 'skills', 'pptx'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /thumbnail\.py|pdftoppm/iu, path)
  }
})

function textFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return textFiles(path)
    return /\.(?:md|py|json|ya?ml|txt|xsd)$/iu.test(entry.name) ? [path] : []
  })
}

test('check_formulas reports the requested static formula defects as JSON', (t) => {
  const probe = spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide openpyxl')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-formulas-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const workbook = join(tempRoot, 'formula-errors.xlsx')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from openpyxl import Workbook',
        'import sys',
        'wb = Workbook()',
        'ws = wb.active',
        'ws.title = "Main"',
        "values = ['=Missing!A1', '=#REF!', '=SUM(A:A)', '=10/0', '=(1+2', '=A6+1', '=A8', '=A7', '=SUM(1,2)', '=\"Missing!A1\"', '=main!A9']",
        'for index, value in enumerate(values, start=1): ws.cell(index, 1, value)',
        'wb.save(sys.argv[1])'
      ].join('\n'),
      workbook
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'xlsx', 'scripts', 'check_formulas.py'),
      '--input',
      workbook
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout) as {
    ok: boolean
    formulaCount: number
    issues: Array<{ cell: string; code: string }>
  }
  assert.equal(output.ok, false)
  assert.equal(output.formulaCount, 11)
  const findings = new Set(output.issues.map((item) => `${item.cell}:${item.code}`))
  for (const expected of [
    'A1:missing_sheet',
    'A2:error_literal',
    'A3:whole_column_reference',
    'A4:division_by_literal_zero',
    'A5:unbalanced_parentheses',
    'A6:circular_reference',
    'A7:circular_reference',
    'A8:circular_reference'
  ]) {
    assert(findings.has(expected), `missing ${expected} in ${JSON.stringify(output.issues)}`)
  }
  assert.equal(
    output.issues.some((item) => item.cell === 'A9'),
    false
  )
  assert.equal(
    output.issues.some((item) => item.cell === 'A10'),
    false
  )
  assert.equal(
    output.issues.some((item) => item.cell === 'A11'),
    false
  )
})

test('check_formulas handles a 1201-cell dependency chain without recursion failure', (t) => {
  const probe = spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide openpyxl')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-formula-chain-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const workbook = join(tempRoot, 'long-chain.xlsx')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from openpyxl import Workbook',
        'import sys',
        'wb = Workbook()',
        'ws = wb.active',
        'for row in range(1, 1201): ws.cell(row, 1, f"=A{row + 1}")',
        'ws.cell(1201, 1, "=1")',
        'wb.save(sys.argv[1])'
      ].join('\n'),
      workbook
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'xlsx', 'scripts', 'check_formulas.py'),
      '--input',
      workbook
    ],
    { encoding: 'utf8', timeout: 30_000 }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout) as { formulaCount: number; issues: unknown[] }
  assert.equal(output.formulaCount, 1201)
  assert.deepEqual(output.issues, [])
})

test('check_formulas bounds large issue sets while preserving the total count', (t) => {
  const probe = spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide openpyxl')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-formula-issues-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const workbook = join(tempRoot, 'many-errors.xlsx')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from openpyxl import Workbook',
        'import sys',
        'wb = Workbook()',
        'ws = wb.active',
        'formula = "=#REF!&" + chr(34) + "😀" * 500 + chr(34)',
        'for row in range(1, 701): ws.cell(row, 1, formula)',
        'wb.save(sys.argv[1])'
      ].join('\n'),
      workbook
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'xlsx', 'scripts', 'check_formulas.py'),
      '--input',
      workbook
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert(Buffer.byteLength(result.stdout, 'utf8') < 1024 * 1024)
  const output = JSON.parse(result.stdout) as {
    ok: boolean
    issueCount: number
    issuesTruncated: boolean
    issues: Array<{ formula: string }>
  }
  assert.equal(output.ok, false)
  assert.equal(output.issueCount, 700)
  assert.equal(output.issuesTruncated, true)
  assert.equal(output.issues.length, 400)
  assert(output.issues.every((item) => [...item.formula].length <= 300))
})

test('the docx skill teaches complete managed creation and honest validation boundaries', () => {
  const path = join(OFFICE_PLUGIN_DIR, 'skills', 'docx', 'SKILL.md')
  const parsed = parseSkillFile(readFileSync(path, 'utf8'))
  assert.equal(parsed.ok, true)
  const body = parsed.ok ? parsed.body : ''

  for (const expected of [
    /add_heading/u,
    /paragraph.*run/iu,
    /List Bullet/u,
    /add_table/u,
    /add_picture/u,
    /header.*footer/isu,
    /section.*margin/isu,
    /styles/u,
    /Document\(.*output\.docx/isu,
    /extract_text\.py/u,
    /hyperlink/iu,
    /comments/iu,
    /tracked revisions/iu,
    /phi-office/iu
  ]) {
    assert.match(body, expected)
  }
  assert.doesNotMatch(body, /PDF/iu)
})

test('docx_inspect returns a bounded paragraph, table, style, and section overview', (t) => {
  const probe = spawnSync('python3', ['-c', 'import docx'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide python-docx')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-docx-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const documentPath = join(tempRoot, 'sample.docx')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from docx import Document',
        'import sys',
        'document = Document()',
        'document.add_heading("Heading", level=1)',
        'document.add_paragraph("Body text")',
        'table = document.add_table(rows=2, cols=2)',
        'table.cell(0, 0).text = "A"',
        'document.sections[0].header.paragraphs[0].text = "Header"',
        'document.save(sys.argv[1])'
      ].join('\n'),
      documentPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'docx', 'scripts', 'docx_inspect.py'),
      '--input',
      documentPath,
      '--max_paragraphs',
      '1'
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout) as {
    paragraphCount: number
    tableCount: number
    sectionCount: number
    paragraphsTruncated: boolean
    paragraphs: Array<{ text: string; style: string; styleTruncated: boolean }>
    tables: Array<{ rows: number; columns: number }>
    sections: Array<{ headerParagraphs: number }>
    stylesUsed: string[]
  }
  assert.equal(output.paragraphCount, 2)
  assert.equal(output.tableCount, 1)
  assert.equal(output.sectionCount, 1)
  assert.equal(output.paragraphsTruncated, true)
  assert.deepEqual(output.paragraphs, [
    {
      index: 0,
      text: 'Heading',
      style: 'Heading 1',
      styleTruncated: false,
      runCount: 1,
      truncated: false
    }
  ])
  assert.deepEqual(output.tables, [{ index: 0, rows: 2, columns: 2 }])
  assert.equal(output.sections[0]?.headerParagraphs, 1)
  assert(output.stylesUsed.includes('Heading 1'))
  assert(output.stylesUsed.includes('Normal'))
})

test('docx_inspect keeps large document JSON below one MiB with explicit truncation', (t) => {
  const probe = spawnSync('python3', ['-c', 'import docx'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide python-docx')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-large-docx-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const documentPath = join(tempRoot, 'large.docx')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from docx import Document',
        'from docx.enum.section import WD_SECTION',
        'import sys',
        'document = Document()',
        'for index in range(80): document.add_paragraph(f"{index}:" + "x" * 2000)',
        'for _ in range(105): document.add_table(rows=1, cols=1)',
        'for _ in range(104): document.add_section(WD_SECTION.NEW_PAGE)',
        'document.save(sys.argv[1])'
      ].join('\n'),
      documentPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'docx', 'scripts', 'docx_inspect.py'),
      '--input',
      documentPath,
      '--max_paragraphs',
      '500'
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert(Buffer.byteLength(result.stdout, 'utf8') < 1024 * 1024)
  const output = JSON.parse(result.stdout) as {
    textTruncated: boolean
    paragraphsTruncated: boolean
    tablesTruncated: boolean
    sectionsTruncated: boolean
    tables: unknown[]
    sections: unknown[]
  }
  assert.equal(output.textTruncated, true)
  assert.equal(output.paragraphsTruncated, true)
  assert.equal(output.tablesTruncated, true)
  assert.equal(output.sectionsTruncated, true)
  assert.equal(output.tables.length, 100)
  assert.equal(output.sections.length, 100)
})

test('docx_inspect bounds large emoji style names in paragraphs and style summaries', (t) => {
  const probe = spawnSync('python3', ['-c', 'import docx'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide python-docx')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-docx-styles-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const documentPath = join(tempRoot, 'styles.docx')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from docx import Document',
        'from docx.enum.style import WD_STYLE_TYPE',
        'import sys',
        'document = Document()',
        'for index in range(300):',
        '    style = document.styles.add_style(f"S{index}-" + "😀" * 1000, WD_STYLE_TYPE.PARAGRAPH)',
        '    document.add_paragraph("content", style=style)',
        'document.save(sys.argv[1])'
      ].join('\n'),
      documentPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'docx', 'scripts', 'docx_inspect.py'),
      '--input',
      documentPath,
      '--max_paragraphs',
      '500'
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert(Buffer.byteLength(result.stdout, 'utf8') < 1024 * 1024)
  const output = JSON.parse(result.stdout) as {
    stylesTruncated: boolean
    paragraphs: Array<{ style: string; styleTruncated: boolean }>
    stylesUsed: string[]
  }
  assert.equal(output.stylesTruncated, true)
  assert.equal(output.paragraphs.length, 300)
  assert(output.paragraphs.every((item) => item.styleTruncated))
  assert(output.paragraphs.every((item) => [...item.style].length <= 100))
  assert.equal(output.stylesUsed.length, 100)
  assert(output.stylesUsed.every((name) => [...name].length <= 100))
})

test('office-workflow examples use the live tool names and parameter schemas', () => {
  const path = join(OFFICE_PLUGIN_DIR, 'skills', 'office-workflow', 'SKILL.md')
  const text = readFileSync(path, 'utf8')
  const parsed = parseSkillFile(text)
  assert.equal(parsed.ok, true)
  const body = parsed.ok ? parsed.body : ''
  const tools = [
    ...buildNotebookCustomTools(async () => ({})),
    buildPresentFilesTool('office-workflow-test', async () => ({ files: [] })),
    buildSkillRunTool(async () => ({}))
  ]
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
  const names = new Set(text.match(/\b(?:notebook\.[a-z_]+|present_files|skill_run)\b/gu) ?? [])
  assert(names.size > 0)
  for (const name of names) assert(toolsByName.has(name), `${name} is not a registered tool`)

  const calls = [...body.matchAll(/^```json tool-call\s*\n([\s\S]*?)^```\s*$/gmu)].map(
    (match) => JSON.parse(match[1]) as { tool: string; arguments: unknown }
  )
  assert(calls.length >= 7, 'the three routes and delivery need machine-checked examples')
  const ajv = new Ajv({ allErrors: true, strict: false })
  for (const call of calls) {
    assert.deepEqual(Object.keys(call).sort(), ['arguments', 'tool'])
    const tool = toolsByName.get(call.tool)
    assert(tool, `${call.tool} is not a registered tool`)
    const validate = ajv.compile(tool.parameters)
    assert.equal(validate(call.arguments), true, `${call.tool}: ${ajv.errorsText(validate.errors)}`)
  }
})

test('run_project_script executes only a project-local relative Python file and forwards args', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'office-project-script-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const scriptsDir = join(tempRoot, 'scripts')
  mkdirSync(scriptsDir)
  const taskPath = join(scriptsDir, 'task.py')
  const fixture = [
    'from pathlib import Path',
    'import sys',
    'Path(sys.argv[1]).write_text(sys.argv[2], encoding="utf-8")'
  ].join('\n')
  writeFileSync(taskPath, fixture)
  const runner = join(
    OFFICE_PLUGIN_DIR,
    'skills',
    'office-workflow',
    'scripts',
    'run_project_script.py'
  )

  const result = spawnSync(
    'python3',
    [runner, 'scripts/task.py', 'result.txt', 'managed-runtime'],
    { cwd: tempRoot, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(tempRoot, 'result.txt'), 'utf8'), 'managed-runtime')

  const rejected = spawnSync('python3', [runner, taskPath], {
    cwd: tempRoot,
    encoding: 'utf8'
  })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /relative to the current project/u)
})

test('run_project_script executes project-local CommonJS with managed Node and rejects unsafe targets', (t) => {
  const nodeProbe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  if (nodeProbe.status !== 0) {
    t.skip('host test environment does not expose node; managed lock is checked separately')
    return
  }

  const projectRoot = mkdtempSync(join(tmpdir(), 'office-node-project-'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'office-node-outside-'))
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  })
  const scriptsDir = join(projectRoot, 'scripts')
  mkdirSync(scriptsDir)
  writeFileSync(
    join(scriptsDir, 'build.cjs'),
    [
      "const fs = require('node:fs')",
      'fs.writeFileSync(process.argv[2], JSON.stringify({',
      '  value: process.argv[3],',
      '  nodePath: process.env.NODE_PATH',
      '}))'
    ].join('\n')
  )
  writeFileSync(join(scriptsDir, 'not-code.txt'), 'not executable')
  writeFileSync(join(outsideRoot, 'escape.js'), 'throw new Error("must not run")')
  const runner = join(
    OFFICE_PLUGIN_DIR,
    'skills',
    'office-workflow',
    'scripts',
    'run_project_script.py'
  )
  const result = spawnSync(
    'python3',
    [runner, 'scripts/build.cjs', 'node-result.json', 'managed-node'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: 'existing/modules' }
    }
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(readFileSync(join(projectRoot, 'node-result.json'), 'utf8')) as {
    value: string
    nodePath: string
  }
  assert.equal(output.value, 'managed-node')
  const nodePaths = output.nodePath.split(pathDelimiter)
  assert(nodePaths.some((path) => path.endsWith('/lib/node_modules')))
  assert(nodePaths.includes('existing/modules'))

  const badExtension = spawnSync('python3', [runner, 'scripts/not-code.txt'], {
    cwd: projectRoot,
    encoding: 'utf8'
  })
  assert.notEqual(badExtension.status, 0)
  assert.match(badExtension.stderr, /\.py, \.js, \.cjs, or \.mjs/u)

  const escaped = spawnSync(
    'python3',
    [runner, join('..', outsideRoot.split('/').at(-1) ?? '', 'escape.js')],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  assert.notEqual(escaped.status, 0)
  assert.match(escaped.stderr, /inside the current project/u)
})

test('extract_text returns bounded JSON through managed markitdown', (t) => {
  const probe = spawnSync('python3', ['-m', 'markitdown', '--help'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('host test environment lacks markitdown; managed lock is checked separately')
    return
  }

  const projectRoot = mkdtempSync(join(tmpdir(), 'office-markitdown-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  writeFileSync(join(projectRoot, 'large.txt'), `Header\n${'x'.repeat(100_100)}`)
  const result = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'office-workflow', 'scripts', 'extract_text.py'),
      '--input',
      'large.txt'
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout) as {
    file: string
    text: string
    truncated: boolean
  }
  assert.equal(output.file, 'large.txt')
  assert.equal(output.text.length, 100_000)
  assert.match(output.text, /^Header/u)
  assert.equal(output.truncated, true)
})

test('Office skills route markitdown and PptxGenJS through managed workflow scripts', () => {
  const paths = [
    join(OFFICE_PLUGIN_DIR, 'skills', 'pptx', 'SKILL.md'),
    join(OFFICE_PLUGIN_DIR, 'skills', 'pptx', 'editing.md'),
    join(OFFICE_PLUGIN_DIR, 'skills', 'pptx', 'pptxgenjs.md'),
    join(OFFICE_PLUGIN_DIR, 'skills', 'docx', 'SKILL.md')
  ]
  const content = paths.map((path) => readFileSync(path, 'utf8')).join('\n')
  assert.doesNotMatch(content, /\bpython(?:3)?\s+-m\s+markitdown\b/iu)
  assert.match(content, /extract_text\.py/u)
  assert.match(content, /run_project_script\.py/u)
  assert.match(content, /\.cjs/u)
  assert.match(content, /CommonJS/u)
})

test('pdf_inspect and the workflow runtime check return machine-readable JSON', (t) => {
  const probe = spawnSync('python3', ['-c', 'import pypdf'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide pypdf')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-pdf-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const pdfPath = join(tempRoot, 'sample.pdf')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from pypdf import PdfWriter',
        'import sys',
        'writer = PdfWriter()',
        'writer.add_blank_page(width=72, height=72)',
        'writer.add_blank_page(width=72, height=72)',
        'writer.add_metadata({"/Title": "Sample"})',
        'writer.write(sys.argv[1])'
      ].join('\n'),
      pdfPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const inspect = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'pdf_inspect.py'),
      '--input',
      pdfPath,
      '--max_pages',
      '1'
    ],
    { encoding: 'utf8' }
  )
  assert.equal(inspect.status, 0, inspect.stderr)
  const pdf = JSON.parse(inspect.stdout) as {
    pageCount: number
    pagesTruncated: boolean
    metadata: Record<string, string>
    metadataTruncated: boolean
  }
  assert.equal(pdf.pageCount, 2)
  assert.equal(pdf.pagesTruncated, true)
  assert.equal(pdf.metadata.Title, 'Sample')
  assert.equal(pdf.metadataTruncated, false)

  const runtime = spawnSync(
    'python3',
    [join(OFFICE_PLUGIN_DIR, 'skills', 'office-workflow', 'scripts', 'check_runtime.py')],
    { encoding: 'utf8' }
  )
  assert.equal(runtime.status, 0, runtime.stderr)
  const check = JSON.parse(runtime.stdout) as {
    environment: string
    packages: Record<string, string | null>
    missing: string[]
  }
  assert.equal(check.environment, 'phi:python@1')
  assert.deepEqual(Object.keys(check.packages).sort(), [
    'markitdown',
    'openpyxl',
    'pypdf',
    'python-docx',
    'python-pptx',
    'reportlab',
    'xlsxwriter'
  ])
  assert.deepEqual(
    check.missing,
    Object.entries(check.packages)
      .filter(([, version]) => version === null)
      .map(([name]) => name)
  )
})

test('pdf_inspect reports encrypted PDFs without attempting password decryption', (t) => {
  const probe = spawnSync('python3', ['-c', 'import pypdf'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide pypdf')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-encrypted-pdf-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const pdfPath = join(tempRoot, 'encrypted.pdf')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from pypdf import PdfWriter',
        'import sys',
        'writer = PdfWriter()',
        'writer.add_blank_page(width=72, height=72)',
        'writer.add_metadata({"/Title": "Secret"})',
        'writer.encrypt("not-an-empty-password")',
        'writer.write(sys.argv[1])'
      ].join('\n'),
      pdfPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'pdf_inspect.py'), '--input', pdfPath],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout), {
    file: 'encrypted.pdf',
    pageCount: null,
    encrypted: true,
    pagesTruncated: false,
    pages: [],
    metadata: {},
    metadataTruncated: false
  })
})

test('pdf_inspect bounds large emoji metadata and reports truncation', (t) => {
  const probe = spawnSync('python3', ['-c', 'import pypdf'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('python3 environment does not provide pypdf')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-pdf-metadata-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const pdfPath = join(tempRoot, 'metadata.pdf')
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from pypdf import PdfWriter',
        'import sys',
        'writer = PdfWriter()',
        'writer.add_blank_page(width=72, height=72)',
        'writer.add_metadata({f"/Key{index:03d}": "😀" * 1000 for index in range(80)})',
        'writer.write(sys.argv[1])'
      ].join('\n'),
      pdfPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    'python3',
    [join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'pdf_inspect.py'), '--input', pdfPath],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert(Buffer.byteLength(result.stdout, 'utf8') < 1024 * 1024)
  const output = JSON.parse(result.stdout) as {
    metadataTruncated: boolean
    metadata: Record<string, string>
  }
  assert.equal(output.metadataTruncated, true)
  assert(Object.keys(output.metadata).length <= 50)
  assert(Object.keys(output.metadata).every((key) => [...key].length <= 100))
  assert(Object.values(output.metadata).every((value) => [...value].length <= 500))
  assert(
    Object.entries(output.metadata).reduce(
      (total, [key, value]) => total + [...key].length + [...value].length,
      0
    ) <= 10_000
  )
})

test('render_pages uses managed Poppler when the host test environment exposes it', (t) => {
  const pythonProbe = spawnSync('python3', ['-c', 'import pypdf'], { encoding: 'utf8' })
  const popplerProbe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' })
  if (pythonProbe.status !== 0 || popplerProbe.status !== 0) {
    t.skip('host test environment lacks pypdf or pdftoppm; managed lock is checked separately')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'office-pdf-render-'))
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }))
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from pypdf import PdfWriter',
        'writer = PdfWriter()',
        'writer.add_blank_page(width=72, height=72)',
        'writer.add_blank_page(width=72, height=72)',
        'writer.write("sample.pdf")'
      ].join('\n')
    ],
    { cwd: tempRoot, encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const render = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'render_pages.py'),
      '--input',
      'sample.pdf',
      '--output_dir',
      'pdf-rendered',
      '--dpi',
      '72'
    ],
    { cwd: tempRoot, encoding: 'utf8' }
  )
  assert.equal(render.status, 0, render.stderr)
  const rendered = JSON.parse(render.stdout) as { pageCount: number; images: string[] }
  assert.equal(rendered.pageCount, 2)
  assert.deepEqual(rendered.images, ['pdf-rendered/page-1.png', 'pdf-rendered/page-2.png'])
  assert(rendered.images.every((path) => existsSync(join(tempRoot, path))))
})

test('render_pages rejects a pre-existing output directory without following page symlinks', (t) => {
  const pythonProbe = spawnSync('python3', ['-c', 'import pypdf'], { encoding: 'utf8' })
  const popplerProbe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' })
  if (pythonProbe.status !== 0 || popplerProbe.status !== 0) {
    t.skip('host test environment lacks pypdf or pdftoppm; managed lock is checked separately')
    return
  }

  const projectRoot = mkdtempSync(join(tmpdir(), 'office-pdf-project-'))
  const victimRoot = mkdtempSync(join(tmpdir(), 'office-pdf-victim-'))
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(victimRoot, { recursive: true, force: true })
  })
  const victim = join(victimRoot, 'victim.png')
  writeFileSync(victim, 'unchanged')
  mkdirSync(join(projectRoot, 'pdf-rendered'))
  symlinkSync(victim, join(projectRoot, 'pdf-rendered', 'page-1.png'))
  const fixture = spawnSync(
    'python3',
    [
      '-c',
      [
        'from pypdf import PdfWriter',
        'writer = PdfWriter()',
        'writer.add_blank_page(width=72, height=72)',
        'writer.write("sample.pdf")'
      ].join('\n')
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const render = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'render_pages.py'),
      '--input',
      'sample.pdf',
      '--output_dir',
      'pdf-rendered'
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  assert.notEqual(render.status, 0)
  assert.match(render.stdout, /must not already exist/u)
  assert.equal(readFileSync(victim, 'utf8'), 'unchanged')

  symlinkSync(victimRoot, join(projectRoot, 'linked-parent'), 'dir')
  const linkedParent = spawnSync(
    'python3',
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'render_pages.py'),
      '--input',
      'sample.pdf',
      '--output_dir',
      'linked-parent/new-render'
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  assert.notEqual(linkedParent.status, 0)
  assert.match(linkedParent.stdout, /parent must not contain symlinks/u)
  assert.equal(readFileSync(victim, 'utf8'), 'unchanged')
})

test('render_pages leaves no final or staging directory when managed Poppler fails', (t) => {
  const probe = spawnSync('python3', ['-c', 'import pypdf, sys; print(sys.executable)'], {
    encoding: 'utf8'
  })
  if (probe.status !== 0) {
    t.skip('host test environment lacks pypdf; managed lock is checked separately')
    return
  }

  const projectRoot = mkdtempSync(join(tmpdir(), 'office-pdf-failure-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  const fakeBin = join(projectRoot, 'fake-bin')
  mkdirSync(fakeBin)
  const fakePoppler = join(fakeBin, 'pdftoppm')
  writeFileSync(fakePoppler, '#!/bin/sh\necho forced-render-failure >&2\nexit 9\n')
  chmodSync(fakePoppler, 0o755)
  const fixture = spawnSync(
    probe.stdout.trim(),
    [
      '-c',
      [
        'from pypdf import PdfWriter',
        'writer = PdfWriter()',
        'writer.add_blank_page(width=72, height=72)',
        'writer.write("sample.pdf")'
      ].join('\n')
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  assert.equal(fixture.status, 0, fixture.stderr)

  const result = spawnSync(
    probe.stdout.trim(),
    [
      join(OFFICE_PLUGIN_DIR, 'skills', 'pdf', 'scripts', 'render_pages.py'),
      '--input',
      'sample.pdf',
      '--output_dir',
      'pdf-rendered'
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin }
    }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /forced-render-failure/u)
  assert.equal(existsSync(join(projectRoot, 'pdf-rendered')), false)
  assert.equal(
    readdirSync(projectRoot).some((name) => name.startsWith('.pdf-rendered.tmp-')),
    false
  )
})

test('every Office Python import is standard, local, or declared by phi-python', () => {
  const environment = parseYaml(
    readFileSync(
      join(REPO_ROOT, 'resources', 'runtime', 'environments', 'phi-python', 'environment.yml'),
      'utf8'
    )
  ) as { dependencies: unknown[] }
  const dependencies = new Set(
    environment.dependencies
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.split(/[<>= ]/u, 1)[0])
  )
  const pythonFiles = textFiles(OFFICE_PLUGIN_DIR).filter((path) => path.endsWith('.py'))
  const scan = spawnSync(
    'python3',
    [
      '-c',
      [
        'import ast, json, pathlib, sys',
        'result = {}',
        'for value in sys.argv[1:]:',
        '    path = pathlib.Path(value)',
        '    roots = set()',
        '    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):',
        '        if isinstance(node, ast.Import):',
        '            roots.update(alias.name.split(".", 1)[0] for alias in node.names)',
        '        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:',
        '            roots.add(node.module.split(".", 1)[0])',
        '    result[value] = sorted(root for root in roots if root not in sys.stdlib_module_names)',
        'print(json.dumps(result))'
      ].join('\n'),
      ...pythonFiles
    ],
    { encoding: 'utf8' }
  )
  assert.equal(scan.status, 0, scan.stderr)
  const imports = JSON.parse(scan.stdout) as Record<string, string[]>
  const packageForImport: Record<string, string> = {
    defusedxml: 'defusedxml',
    docx: 'python-docx',
    lxml: 'lxml',
    openpyxl: 'openpyxl',
    pypdf: 'pypdf'
  }
  const localImports = new Set(['helpers', 'validators'])

  for (const [path, roots] of Object.entries(imports)) {
    for (const root of roots) {
      if (localImports.has(root)) continue
      const packageName = packageForImport[root]
      assert(packageName, `${path} imports unexpected third-party module ${root}`)
      assert(
        dependencies.has(packageName),
        `${path} imports ${root}, but ${packageName} is undeclared`
      )
    }
  }

  for (const path of pythonFiles) {
    const source = readFileSync(path, 'utf8')
    if (!/\bsubprocess\b/u.test(source)) continue
    if (/scripts\/office\/validators\/redlining\.py$/u.test(path)) {
      assert.match(source, /["']git["']/u)
      assert(dependencies.has('git'))
      continue
    }
    if (/skills\/pdf\/scripts\/render_pages\.py$/u.test(path)) {
      assert.match(source, /["']pdftoppm["']/u)
      assert(dependencies.has('poppler'))
      continue
    }
    if (/skills\/office-workflow\/scripts\/run_project_script\.py$/u.test(path)) {
      assert.match(source, /["']node["']/u)
      assert.match(source, /sys\.prefix/u)
      assert.match(source, /node_modules/u)
      assert(dependencies.has('nodejs'))
      continue
    }
    if (/skills\/office-workflow\/scripts\/extract_text\.py$/u.test(path)) {
      assert.match(source, /sys\.executable/u)
      assert.match(source, /["']-m["'][\s\S]*["']markitdown["']/u)
      assert(dependencies.has('markitdown'))
      continue
    }
    assert.match(source, /sys\.executable/u, `${path} may only invoke another managed script`)
    assert.doesNotMatch(source, /["'](?:bash|sh|python|python3|node|perl|Rscript)["']/u)
  }
})
