import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import Ajv from 'ajv'

import { parseSkillFile, validateSkill } from '../src/main/agent/content/skill'
import { OFFICE_APPLY_PARAMETERS } from '../src/main/agent/office/office-apply-tool-contract'
import { buildOfficeTools } from '../src/main/agent/office/office-tools'
import {
  createRuntimeResourceLoader,
  getBundledSkillsDir
} from '../src/main/agent/runtime/runtime-adapter'

const SKILL_DIR = join(getBundledSkillsDir(), 'phi-office')
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md')
const tempRoot = mkdtempSync(join(tmpdir(), 'phi-office-skill-test-'))
const agentDir = join(tempRoot, 'agent')
const projectDir = join(tempRoot, 'project')

mkdirSync(agentDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

test('runtime skill discovery exposes the bundled phi-office skill to skill-list consumers', async () => {
  const loader = createRuntimeResourceLoader({ cwd: projectDir, agentDir })
  await loader.reload()
  const skill = loader.getSkills().skills.find((candidate) => candidate.name === 'phi-office')

  assert(skill, 'resources/skills/phi-office/SKILL.md must be discoverable by the runtime loader')
  assert.equal(skill.filePath, SKILL_PATH)
})

test('phi-office is limited to small interactive edits of an already-open Office file', () => {
  const validation = validateSkill(SKILL_DIR)
  assert.deepEqual(validation.errors, [])
  assert.deepEqual(validation.warnings, [])
  assert(validation.skill)
  assert.equal(validation.skill.name, 'phi-office')

  const description = validation.skill.description
  for (const extension of ['.xlsx', '.docx', '.pptx']) {
    assert.match(description, new RegExp(escapeRegExp(extension), 'iu'))
  }
  assert.match(description, /仅用于.*已在右侧打开.*少量交互式修改/u)
  assert.match(description, /生成类任务.*图表.*图片.*复杂格式.*批量/u)
  for (const skill of ['xlsx', 'pptx', 'docx', 'pdf']) {
    assert.match(description, new RegExp(`\\b${skill}\\b`, 'iu'))
  }
  assert.doesNotMatch(description, /优先于旧/u)

  const body = skillBody()
  assert.match(body, /^\s*# Phi Office\s+仅用于.*已在右侧打开/msu)
  assert.match(body, /生成类任务.*`xlsx`.*`pptx`.*`docx`.*`pdf`/su)
})

test('phi-office body contains no forbidden install or direct Office command and no absolute path', () => {
  const body = skillBody()

  assert.doesNotMatch(
    body,
    /\b(?:pip(?:3)?\s+install|npm\s+install|curl\s+|brew\s+install|officecli\s+)/iu
  )
  assert.doesNotMatch(body, /(?:^|[\s'"`(])\/(?!\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*/mu)
  assert.doesNotMatch(body, /\b[A-Za-z]:\\[^\s'"`]+/u)
})

test('phi-office distinguishes paged reads from an XLSX overview without a cursor', () => {
  const body = skillBody()

  assert.match(body, /只有回执含 `nextCursor` 时/u)
  assert.match(body, /XLSX 概览的 `complete:false` 没有 cursor/u)
  assert.match(body, /按回执 `hint` 选择 `sheet`\/`range` 重读/u)
})

test('every documented Office call uses a registered tool and its live parameter schema', () => {
  const text = readFileSync(SKILL_PATH, 'utf8')
  const body = skillBody(text)
  const tools = buildOfficeTools(async () => ({ ok: true }), { PHI_OFFICE_DEV: '1' })
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
  const documentedToolNames = new Set(text.match(/\boffice_[a-z0-9_]+\b/giu) ?? [])

  assert(documentedToolNames.size > 0, 'SKILL.md must name the Phi Office tools it teaches')
  for (const name of documentedToolNames) {
    assert(toolsByName.has(name), `${name} is not a registered Phi Office tool`)
  }

  const calls = parseOfficeCalls(body)
  assert(calls.length > 0, 'examples must use fenced `json office-call` blocks')
  const ajv = new Ajv({ allErrors: true, strict: false })
  for (const call of calls) {
    assert.deepEqual(Object.keys(call).sort(), ['arguments', 'tool'])
    assert.equal(typeof call.tool, 'string')
    const tool = toolsByName.get(call.tool)
    assert(tool, `${String(call.tool)} is not a registered Phi Office tool`)
    const validate = ajv.compile(tool.parameters)
    assert.equal(
      validate(call.arguments),
      true,
      `${tool.name} arguments do not match its registered schema: ${ajv.errorsText(validate.errors)}`
    )
  }

  for (const tool of tools) {
    assert(
      calls.some((call) => call.tool === tool.name),
      `${tool.name} needs at least one machine-checked example`
    )
  }
})

test('phi-office documents every operation exported by the live office_apply schema', () => {
  const body = skillBody()
  const operationNames = OFFICE_APPLY_PARAMETERS.properties.operation.oneOf.map(
    (schema) => schema.properties.type.const
  )

  for (const operationName of operationNames) {
    assert.match(
      body,
      new RegExp(`\\b${escapeRegExp(operationName)}\\b`, 'u'),
      `SKILL.md must document the registered ${operationName} operation`
    )
  }
})

interface OfficeCall {
  tool: string
  arguments: unknown
}

function parseOfficeCalls(body: string): OfficeCall[] {
  return [...body.matchAll(/^```json office-call\s*\n([\s\S]*?)^```\s*$/gmu)].map(
    (match) => JSON.parse(match[1]) as OfficeCall
  )
}

function skillBody(text = readFileSync(SKILL_PATH, 'utf8')): string {
  const parsed = parseSkillFile(text)
  assert.equal(parsed.ok, true)
  return parsed.ok ? parsed.body : ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
