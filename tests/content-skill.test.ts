import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PHI_PLATFORMS } from '../src/main/agent/envs/contract'
import { SKILL_CONTRACT_VERSION, phiSkillBlockSchema } from '../src/main/agent/content/skill-schema'
import {
  hasScripts,
  parseSkillFile,
  scriptToolName,
  scriptToolsOf,
  validateSkill,
  type SkillValidationResult
} from '../src/main/agent/content/skill'

const DESCRIPTION = 'A demo skill for tests.'
const ENV_YML = `name: demo
channels:
  - conda-forge
dependencies:
  - python=3.12
`

const roots: string[] = []
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(dirName: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-skill-'))
  roots.push(root)
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

function skillMd(frontmatter: string, body = '# Demo\n'): string {
  return `---\n${frontmatter.trim()}\n---\n${body}`
}

function plain(frontmatter: string, files: Record<string, string> = {}, dirName = 'demo'): string {
  return writeTree(dirName, { 'SKILL.md': skillMd(frontmatter), ...files })
}

function scriptEntry(options?: {
  name?: string
  run?: string
  output?: string
  approval?: string
  timeout?: number
  args?: string
}): string {
  const lines = [
    `    - name: ${options?.name ?? 'qc'}`,
    '      description: Compute QC metrics',
    `      run: ${options?.run ?? '[python]'}`,
    options?.args ?? '      args: {type: object, additionalProperties: false, properties: {}}',
    `      approval: ${options?.approval ?? 'read'}`
  ]
  if (options?.output) lines.push(`      output: ${options.output}`)
  if (options?.timeout !== undefined) lines.push(`      timeoutSeconds: ${options.timeout}`)
  return lines.join('\n')
}

function skillDir(
  entries: string[],
  options?: {
    name?: string
    description?: string
    environment?: string | false
    toolPrefix?: string | false
    attachTo?: string
    files?: Record<string, string>
  }
): string {
  const name = options?.name ?? 'demo'
  const description = options?.description ?? DESCRIPTION
  const lines = [`name: ${name}`, `description: ${description}`, 'phi:']
  if (options?.environment !== false) {
    lines.push(`  environment: ${options?.environment ?? 'phi:python@1'}`)
  }
  if (options?.attachTo) lines.push(`  attachTo: ${options.attachTo}`)
  if (options?.toolPrefix !== false) lines.push(`  toolPrefix: ${options?.toolPrefix ?? 'demo'}`)
  lines.push('  scripts:')
  lines.push(...entries)
  return writeTree(name, { 'SKILL.md': skillMd(lines.join('\n')), ...options?.files })
}

function texts(result: SkillValidationResult): string[] {
  return result.errors.map((error) => `${error.path}: ${error.message}`)
}

function errorsOf(dir: string, options?: { insidePlugin?: boolean }): string[] {
  const result = validateSkill(dir, options)
  assert.equal(result.ok, false)
  assert.equal(result.skill, undefined)
  assert.deepEqual(result.warnings, [])
  return texts(result)
}

function assertValid(dir: string, options?: { insidePlugin?: boolean }): SkillValidationResult {
  const result = validateSkill(dir, options)
  assert.deepEqual(texts(result), [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.ok, true)
  assert.ok(result.skill)
  return result
}

function writeLocks(dir: string): void {
  for (const platform of PHI_PLATFORMS) {
    const path = join(dir, 'locks', `${platform}.txt`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
}

test('skill contract version and phi schema reject unknown fields', () => {
  assert.equal(SKILL_CONTRACT_VERSION, '1.0.0')
  assert.equal(phiSkillBlockSchema.additionalProperties, false)
  const scripts = phiSkillBlockSchema.properties.scripts
  assert.equal(scripts.type, 'array')
  if (typeof scripts.items === 'boolean') assert.fail('script items must be a schema')
  assert.equal(scripts.items.additionalProperties, false)
  assert.deepEqual(scripts.items.required, ['name', 'description', 'run', 'args', 'approval'])
})

test('parseSkillFile reads frontmatter between the first two --- lines', () => {
  const parsed = parseSkillFile('\uFEFF---\r\nname: demo\r\n---\r\n# Hi\r\n')
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.frontmatter.name, 'demo')
  assert.equal(parsed.body, '# Hi\n')

  assert.equal(parseSkillFile('# no frontmatter\n').ok, false)
  assert.equal(parseSkillFile('---\nname: demo\n').ok, false)
  assert.match(parseSkillFile('---\n: [\n---\n').ok ? '' : 'yaml', /yaml/)
  const notMapping = parseSkillFile('---\n- item\n---\n')
  assert.equal(notMapping.ok, false)
  if (!notMapping.ok) assert.match(notMapping.error, /mapping/)
})

test('a skill with standard fields and no scripts is valid', () => {
  const dir = plain(`name: demo
description: ${DESCRIPTION}
license: MIT
compatibility: Requires Python
metadata:
  version: '1.0'
allowed-tools: Read Write
disable-model-invocation: true
hide: false
globs: '**/*.py'
alwaysApply: false`)
  const result = assertValid(dir)
  assert.equal(result.skill?.name, 'demo')
  assert.equal(result.skill?.dir, resolve(dir))
  assert.equal(result.skill?.body, '# Demo\n')
  assert.equal(result.skill?.frontmatter.license, 'MIT')
  assert.equal(result.skill?.frontmatter['disable-model-invocation'], true)
  assert.deepEqual(result.skill?.frontmatter.metadata, { version: '1.0' })
  assert.equal(result.skill?.phi, undefined)
  assert.equal(hasScripts(dir), false)
})

test('unknown top-level keys warn, including required_environment_variables', () => {
  const dir = plain(`name: demo
description: ${DESCRIPTION}
globs: '**/*'
alwaysApply: true
required_environment_variables:
  - name: OPENROUTER_API_KEY`)
  const result = validateSkill(dir)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].level, 'warning')
  assert.equal(result.warnings[0].path, 'required_environment_variables')
  assert.match(result.warnings[0].message, /unknown frontmatter key/)
  assert.ok(result.skill)
})

test('name, description, and SKILL.md are required and checked', () => {
  const missing = writeTree('demo', { 'README.md': 'nope' })
  assert.deepEqual(errorsOf(missing), ['SKILL.md: SKILL.md is required'])

  const noFrontmatter = plain('# Just markdown')
  assert.match(errorsOf(noFrontmatter)[0], /frontmatter/)

  const badPattern = plain(
    `name: bad_name
description: ${DESCRIPTION}`,
    {},
    'bad_name'
  )
  assert.deepEqual(errorsOf(badPattern), ['name: name must match ^[a-z0-9][a-z0-9-]{0,63}$'])

  const longName = 'a'.repeat(65)
  const tooLong = plain(
    `name: ${longName}
description: ${DESCRIPTION}`,
    {},
    longName
  )
  assert.match(errorsOf(tooLong)[0], /name must match/)

  const maxName = 'a'.repeat(64)
  assertValid(
    plain(
      `name: ${maxName}
description: ${DESCRIPTION}`,
      {},
      maxName
    )
  )

  const mismatch = plain(
    `name: demo
description: ${DESCRIPTION}`,
    {},
    'other'
  )
  assert.deepEqual(errorsOf(mismatch), ["name: name 'demo' must equal the directory name 'other'"])

  assert.deepEqual(errorsOf(plain(`name: demo\ndescription: ${'a'.repeat(1025)}`)), [
    'description: description must be 1-1024 characters'
  ])
  assertValid(plain(`name: demo\ndescription: ${'a'.repeat(1024)}`))
  assert.deepEqual(errorsOf(plain('name: demo\ndescription: ""')), [
    'description: description must be 1-1024 characters'
  ])
  assert.deepEqual(errorsOf(plain('name: demo')), ['description: description is required'])
})

test('standard field types are enforced', () => {
  const dir = plain(`name: demo
description: ${DESCRIPTION}
license: 1
compatibility: 2
allowed-tools:
  - Read
metadata:
  version: 1
disable-model-invocation: yes
hide: yes`)
  assert.deepEqual(errorsOf(dir).sort(), [
    'allowed-tools: allowed-tools must be a string',
    'compatibility: compatibility must be a string',
    'disable-model-invocation: disable-model-invocation must be a boolean',
    'hide: hide must be a boolean',
    'license: license must be a string',
    'metadata: metadata must be a map of string to string'
  ])
})

test('phi must be a mapping and its schema is enforced', () => {
  assert.deepEqual(
    errorsOf(
      plain(`name: demo
description: ${DESCRIPTION}
phi: hello`)
    ),
    ['phi: phi must be a mapping']
  )

  const dir = plain(`name: demo
description: ${DESCRIPTION}
phi:
  extra: 1
  attachTo: [bio]
  toolPrefix: A
  environment: phi:python@1
  scripts:
    - name: Bad
      description: ''
      run: []
      approval: maybe
      output: schemas/out.json
      timeoutSeconds: 0`)
  const errors = errorsOf(dir)
  for (const pattern of [
    /phi: has unknown property 'extra'/,
    /phi\.attachTo\[0\]: does not match/,
    /phi\.toolPrefix: does not match/,
    /phi\.scripts\[0\]\.name: does not match/,
    /phi\.scripts\[0\]\.description: must NOT have fewer than 1 characters/,
    /phi\.scripts\[0\]\.run: must NOT have fewer than 1 items/,
    /phi\.scripts\[0\]: is missing 'args'/,
    /phi\.scripts\[0\]\.approval: must be equal to one of the allowed values/,
    /phi\.scripts\[0\]\.output: does not match/,
    /phi\.scripts\[0\]\.timeoutSeconds: must be >= 1/
  ]) {
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `${pattern} not in\n${errors.join('\n')}`
    )
  }
})

test('toolPrefix is required standalone, rejected in a plugin, and reserved prefixes fail', () => {
  const standalone = skillDir([scriptEntry()], { toolPrefix: false })
  assert.deepEqual(errorsOf(standalone), [
    'phi.toolPrefix: toolPrefix is required when scripts is set'
  ])

  const plugin = skillDir([scriptEntry()], { toolPrefix: false })
  assertValid(plugin, { insidePlugin: true })

  const rejected = skillDir([scriptEntry()], { toolPrefix: 'demo' })
  assert.deepEqual(errorsOf(rejected, { insidePlugin: true }), [
    'phi.toolPrefix: toolPrefix is rejected inside a plugin'
  ])

  const reserved = skillDir([scriptEntry()], { toolPrefix: 'skill' })
  assert.deepEqual(errorsOf(reserved), ["phi.toolPrefix: toolPrefix 'skill' is reserved"])
  assert.deepEqual(errorsOf(reserved, { insidePlugin: true }).sort(), [
    "phi.toolPrefix: toolPrefix 'skill' is reserved",
    'phi.toolPrefix: toolPrefix is rejected inside a plugin'
  ])
})

test('hasScripts is true only for program extensions under scripts/', () => {
  const notes = plain(skillMdBody(), {
    'scripts/readme.md': 'no',
    'scripts/plot.png': 'no',
    'tool.py': 'no'
  })
  assert.equal(hasScripts(notes), false)
  assertValid(notes)

  for (const ext of ['.py', '.R', '.r', '.sh', '.js', '.mjs', '.pl']) {
    const dir = plain(skillMdBody(), { [`scripts/sub/tool${ext}`]: '' })
    assert.equal(hasScripts(dir), true, ext)
    assert.deepEqual(errorsOf(dir), [
      'phi.environment: environment is required when the skill has scripts'
    ])
  }

  const declared = skillDir([scriptEntry()], { environment: false, toolPrefix: false })
  assert.equal(hasScripts(declared), false)
  assert.deepEqual(errorsOf(declared), [
    'phi.toolPrefix: toolPrefix is required when scripts is set',
    'phi.environment: environment is required when the skill has scripts'
  ])
})

test('environment is forbidden when a skill has no scripts', () => {
  const dir = plain(`name: demo
description: ${DESCRIPTION}
phi:
  environment: phi:python@1`)
  assert.deepEqual(errorsOf(dir), [
    'phi.environment: environment must not be declared when the skill has no scripts'
  ])
})

test('environment references are parsed, and only ./environment.yml is skill-local', () => {
  const plugin = assertValid(skillDir([scriptEntry()], { environment: 'plugin:viz' }))
  assert.deepEqual(plugin.skill?.environment, { kind: 'plugin', name: 'viz' })
  const project = assertValid(skillDir([scriptEntry()], { environment: 'project:viz' }))
  assert.deepEqual(project.skill?.environment, { kind: 'project', name: 'viz' })
  const phi = assertValid(skillDir([scriptEntry()]))
  assert.deepEqual(phi.skill?.environment, { kind: 'phi', name: 'python', major: 1 })

  assert.deepEqual(errorsOf(skillDir([scriptEntry()], { environment: 'phi:python' })), [
    "phi.environment: invalid environment reference 'phi:python': phi references must be phi:<name>@<major>"
  ])
  assert.deepEqual(errorsOf(skillDir([scriptEntry()], { environment: './other.yml' })), [
    'phi.environment: skill-local environment must be ./environment.yml'
  ])
})

test('./environment.yml requires a spec and a lock for every platform', () => {
  const missingLocks = plain(
    `name: demo
description: ${DESCRIPTION}
phi:
  environment: ./environment.yml`,
    { 'scripts/qc.py': 'print(1)\n', 'environment.yml': ENV_YML }
  )
  assert.deepEqual(
    errorsOf(missingLocks).sort(),
    PHI_PLATFORMS.map(
      (platform) => `locks/${platform}.txt: lock file locks/${platform}.txt is required`
    ).sort()
  )

  const missingSpec = plain(
    `name: demo
description: ${DESCRIPTION}
phi:
  environment: ./environment.yml`,
    { 'scripts/qc.py': 'print(1)\n' }
  )
  writeLocks(missingSpec)
  assert.deepEqual(errorsOf(missingSpec), [
    'environment.yml: environment.yml is required for ./environment.yml'
  ])

  const invalid = plain(
    `name: demo
description: ${DESCRIPTION}
phi:
  environment: ./environment.yml`,
    {
      'scripts/qc.py': 'print(1)\n',
      'environment.yml': 'name: Demo\nchannels:\n  - conda-forge\ndependencies:\n  - python\n'
    }
  )
  writeLocks(invalid)
  const invalidErrors = errorsOf(invalid)
  assert.ok(invalidErrors.length > 0)
  assert.ok(invalidErrors.every((error) => error.startsWith('environment.yml:')))
  assert.ok(invalidErrors.some((error) => /name/.test(error)))

  const ready = plain(
    `name: demo
description: ${DESCRIPTION}
phi:
  environment: ./environment.yml`,
    { 'scripts/qc.py': 'print(1)\n', 'environment.yml': ENV_YML }
  )
  writeLocks(ready)
  const result = assertValid(ready)
  assert.deepEqual(result.skill?.environment, { kind: 'path', path: './environment.yml' })
})

test('script names are unique and run paths stay inside the skill', () => {
  assert.deepEqual(errorsOf(skillDir([scriptEntry({ name: 'qc' }), scriptEntry({ name: 'qc' })])), [
    "phi.scripts[1].name: duplicate script name 'qc'"
  ])

  assert.deepEqual(errorsOf(skillDir([scriptEntry({ run: '[python, ./../x.py]' })])), [
    "phi.scripts[0].run[1]: path './../x.py' resolves outside the skill directory"
  ])
  assert.deepEqual(errorsOf(skillDir([scriptEntry({ run: '[python, ./scripts/missing.py]' })])), [
    "phi.scripts[0].run[1]: path './scripts/missing.py' does not exist"
  ])

  const command = skillDir([scriptEntry({ run: '[./scripts/qc.py]' })], {
    files: { 'scripts/qc.py': 'print(1)\n' }
  })
  assert.deepEqual(errorsOf(command), [
    'phi.scripts[0].run[0]: run[0] must be a command resolved inside the environment'
  ])

  const dir = skillDir([scriptEntry({ run: '[python, ./scripts/escape.py]' })])
  writeFileSync(join(dirname(dir), 'outside.py'), 'print(1)\n')
  mkdirSync(join(dir, 'scripts'))
  symlinkSync(join(dirname(dir), 'outside.py'), join(dir, 'scripts', 'escape.py'))
  assert.deepEqual(errorsOf(dir), [
    "phi.scripts[0].run[1]: path './scripts/escape.py' resolves outside the skill directory"
  ])

  // A symlinked directory (not just a symlinked file) must not let run escape either.
  const viaDir = skillDir([scriptEntry({ run: '[python, ./scripts/qc.py]' })])
  const outsideDir = join(dirname(viaDir), 'outside-scripts')
  mkdirSync(outsideDir)
  writeFileSync(join(outsideDir, 'qc.py'), 'print(1)\n')
  symlinkSync(outsideDir, join(viaDir, 'scripts'))
  assert.ok(
    errorsOf(viaDir).includes(
      "phi.scripts[0].run[1]: path './scripts/qc.py' resolves outside the skill directory"
    )
  )
})

test('args schema meta-rules and output schemas are checked', () => {
  const objectType = skillDir([
    scriptEntry({
      args: `      args:
        type: object
        additionalProperties: false
        properties:
          meta:
            type: object`
    })
  ])
  assert.deepEqual(errorsOf(objectType), [
    "phi.scripts[0].args.properties.meta.type: property type 'object' is not supported"
  ])

  const badName = skillDir([
    scriptEntry({
      args: `      args:
        type: object
        additionalProperties: false
        properties:
          Bad-Name:
            type: string`
    })
  ])
  assert.deepEqual(errorsOf(badName), [
    "phi.scripts[0].args.properties.Bad-Name: property name 'Bad-Name' must match ^[a-z][a-z0-9_]*$"
  ])

  const open = skillDir([
    scriptEntry({
      args: `      args:
        type: object
        properties:
          input:
            type: string`
    })
  ])
  assert.deepEqual(errorsOf(open), [
    'phi.scripts[0].args.additionalProperties: args.additionalProperties must be false'
  ])

  const format = skillDir([
    scriptEntry({
      args: `      args:
        type: object
        additionalProperties: false
        properties:
          input:
            type: string
            format: uri`
    })
  ])
  assert.deepEqual(errorsOf(format), [
    "phi.scripts[0].args.properties.input.format: format 'uri' is not supported"
  ])

  assert.deepEqual(errorsOf(skillDir([scriptEntry({ output: './schemas/missing.json' })])), [
    "phi.scripts[0].output: path './schemas/missing.json' does not exist"
  ])

  const notJson = skillDir([scriptEntry({ output: './schemas/qc.json' })], {
    files: { 'schemas/qc.json': 'not json\n' }
  })
  assert.match(errorsOf(notJson)[0], /phi\.scripts\[0\]\.output: output is not valid JSON/)

  const arraySchema = skillDir([scriptEntry({ output: './schemas/qc.json' })], {
    files: { 'schemas/qc.json': '[]\n' }
  })
  assert.deepEqual(errorsOf(arraySchema), [
    'phi.scripts[0].output: output schema must be a JSON object'
  ])

  const limits = skillDir([scriptEntry({ timeout: 86400, approval: 'write' })])
  assertValid(limits)
  assert.match(errorsOf(skillDir([scriptEntry({ timeout: 86401 })]))[0], /86400/)
})

test('scriptToolsOf prefixes the tool and resolves run paths and output schemas', () => {
  assert.equal(scriptToolName('scanpy', 'qc'), 'scanpy_qc')
  const dir = skillDir(
    [
      scriptEntry({
        run: '[python, ./scripts/qc.py]',
        output: './schemas/qc.json',
        timeout: 600,
        args: `      args:
        type: object
        additionalProperties: false
        properties:
          input:
            type: string
            format: input-path
          counts:
            type: array
            items:
              type: integer
        required: [input]`
      }),
      scriptEntry({ name: 'bare' })
    ],
    {
      files: {
        'scripts/qc.py': 'print(1)\n',
        'schemas/qc.json': '{"type":"object","properties":{"ok":{"type":"boolean"}}}\n'
      }
    }
  )
  const result = assertValid(dir)
  assert.ok(result.skill)
  const tools = scriptToolsOf(result.skill, { prefix: 'scanpy' })
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'scanpy_qc')
  assert.equal(tools[0].description, 'Compute QC metrics')
  assert.deepEqual(tools[0].run, ['python', resolve(dir, 'scripts/qc.py')])
  assert.deepEqual(tools[0].outputSchema, {
    type: 'object',
    properties: { ok: { type: 'boolean' } }
  })
  assert.equal(tools[0].output, './schemas/qc.json')
  assert.equal(tools[0].timeoutSeconds, 600)
  assert.deepEqual(tools[0].attachTo, ['main'])
  assert.equal(tools[1].name, 'scanpy_bare')
  assert.equal(tools[1].outputSchema, undefined)
  assert.deepEqual(tools[1].run, ['python'])

  const attached = assertValid(skillDir([scriptEntry()], { attachTo: '[main, Bio]' }))
  assert.ok(attached.skill)
  assert.deepEqual(scriptToolsOf(attached.skill, { prefix: 'demo' })[0].attachTo, ['main', 'Bio'])
})

test('bundled scanpy fails only because environment is required', () => {
  const dir = fileURLToPath(new URL('../resources/skills/scanpy', import.meta.url))
  const result = validateSkill(dir)
  assert.equal(result.ok, false)
  assert.equal(result.skill, undefined)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(texts(result), [
    'phi.environment: environment is required when the skill has scripts'
  ])
})

function skillMdBody(): string {
  return `name: demo
description: ${DESCRIPTION}`
}
