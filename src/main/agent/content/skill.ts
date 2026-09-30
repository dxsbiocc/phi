import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import Ajv, { type ErrorObject } from 'ajv'
import { parse as parseYaml } from 'yaml'

import {
  PHI_PLATFORMS,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  type EnvironmentRef
} from '../envs/contract'
import { phiSkillBlockSchema } from './skill-schema'

const ajv = new Ajv({ allErrors: true, strict: false })
const validatePhiBlock = ajv.compile(phiSkillBlockSchema)

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const ARG_NAME = /^[a-z][a-z0-9_]*$/
const SCRIPT_EXTENSIONS = new Set(['.py', '.R', '.r', '.sh', '.js', '.mjs', '.pl'])
const RESERVED_TOOL_PREFIXES = new Set(['skill', 'env', 'http', 'wrapper', 'agent', 'db', 'mcp'])
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9]{1,11}$/

/** Skill contract § 2.2: pattern and engine-reserved prefixes. */
export function toolPrefixError(prefix: string): string | undefined {
  if (!TOOL_PREFIX_PATTERN.test(prefix)) {
    return `toolPrefix '${prefix}' does not match ^[a-z][a-z0-9]{1,11}$`
  }
  if (RESERVED_TOOL_PREFIXES.has(prefix)) return `toolPrefix '${prefix}' is reserved`
  return undefined
}
const SCALAR_ARG_TYPES = new Set(['string', 'number', 'integer', 'boolean'])
const PATH_FORMATS = new Set(['input-path', 'project-path'])
const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
  'hide',
  'globs',
  'alwaysApply',
  'phi'
])
const LOCAL_ENVIRONMENT = './environment.yml'

export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
  'disable-model-invocation'?: boolean
  hide?: boolean
  globs?: unknown
  alwaysApply?: unknown
  phi?: PhiSkillBlock
}

export interface PhiSkillBlock {
  environment?: string
  attachTo?: string[]
  toolPrefix?: string
  scripts?: ScriptToolDeclaration[]
}

export interface ScriptToolDeclaration {
  name: string
  description: string
  run: string[]
  args: Record<string, unknown>
  approval: 'read' | 'write'
  output?: string
  timeoutSeconds?: number
}

export type SkillProblem = {
  level: 'error' | 'warning'
  path: string
  message: string
}

export interface ValidatedSkill {
  /** Absolute skill directory. */
  dir: string
  name: string
  description: string
  body: string
  frontmatter: SkillFrontmatter
  phi?: PhiSkillBlock
  environment?: EnvironmentRef
}

/** A script tool after prefixing, path resolution, and output-schema parsing. */
export interface ScriptTool {
  /** Registered name, `<prefix>_<declaration name>`. */
  name: string
  description: string
  /** Argv. Elements that start with `./` are absolute paths inside the skill directory. */
  run: string[]
  args: Record<string, unknown>
  approval: 'read' | 'write'
  output?: string
  outputSchema?: Record<string, unknown>
  timeoutSeconds?: number
  attachTo: string[]
}

export interface SkillValidationResult {
  ok: boolean
  errors: SkillProblem[]
  warnings: SkillProblem[]
  skill?: ValidatedSkill
}

export type SkillFileParseResult =
  { ok: true; frontmatter: Record<string, unknown>; body: string } | { ok: false; error: string }

export function parseSkillFile(skillMdText: string): SkillFileParseResult {
  const text = skillMdText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { ok: false, error: 'SKILL.md must start with YAML frontmatter (---)' }
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close < 0) {
    return { ok: false, error: 'SKILL.md frontmatter is missing the closing ---' }
  }

  let document: unknown
  try {
    document = parseYaml(lines.slice(1, close).join('\n'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `YAML parse error: ${message}` }
  }
  if (!isRecord(document)) {
    return { ok: false, error: 'frontmatter must be a YAML mapping' }
  }
  return { ok: true, frontmatter: document, body: lines.slice(close + 1).join('\n') }
}

/** True when `scripts/` contains a program file, recursively (§ 3.1). Does not read SKILL.md. */
export function hasScripts(dir: string): boolean {
  return walkScripts(join(dir, 'scripts'), new Set())
}

export function scriptToolName(prefix: string, name: string): string {
  return `${prefix}_${name}`
}

export function scriptToolsOf(skill: ValidatedSkill, options: { prefix: string }): ScriptTool[] {
  const scripts = skill.phi?.scripts ?? []
  const attachTo = [...(skill.phi?.attachTo ?? ['main'])]
  return scripts.map((declaration) => {
    const tool: ScriptTool = {
      name: scriptToolName(options.prefix, declaration.name),
      description: declaration.description,
      run: declaration.run.map((arg) => (arg.startsWith('./') ? resolve(skill.dir, arg) : arg)),
      args: { ...declaration.args },
      approval: declaration.approval,
      attachTo: [...attachTo]
    }
    if (declaration.output) {
      tool.output = declaration.output
      tool.outputSchema = readOutputSchema(skill.dir, declaration.output)
    }
    if (declaration.timeoutSeconds !== undefined) tool.timeoutSeconds = declaration.timeoutSeconds
    return tool
  })
}

export function validateSkill(
  dir: string,
  options?: { insidePlugin?: boolean }
): SkillValidationResult {
  const insidePlugin = options?.insidePlugin === true
  const errors: SkillProblem[] = []
  const warnings: SkillProblem[] = []
  const fail = (path: string, message: string): void => {
    errors.push({ level: 'error', path, message })
  }

  const skillDir = resolve(dir)
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!isFile(skillMdPath)) {
    fail('SKILL.md', 'SKILL.md is required')
    return finish(errors, warnings)
  }

  let text: string
  try {
    text = readFileSync(skillMdPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail('SKILL.md', `cannot read SKILL.md: ${message}`)
    return finish(errors, warnings)
  }

  const parsed = parseSkillFile(text)
  if (!parsed.ok) {
    fail('SKILL.md', parsed.error)
    return finish(errors, warnings)
  }

  const fm = parsed.frontmatter
  for (const key of Object.keys(fm)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      warnings.push({
        level: 'warning',
        path: key,
        message: `unknown frontmatter key '${key}'`
      })
    }
  }

  const dirName = basename(skillDir)
  let name: string | undefined
  if (fm.name === undefined) {
    fail('name', 'name is required')
  } else if (typeof fm.name !== 'string') {
    fail('name', 'name must be a string')
  } else {
    name = fm.name
    if (!SKILL_NAME.test(name)) fail('name', 'name must match ^[a-z0-9][a-z0-9-]{0,63}$')
    if (name !== dirName) fail('name', `name '${name}' must equal the directory name '${dirName}'`)
  }

  let description: string | undefined
  if (fm.description === undefined) {
    fail('description', 'description is required')
  } else if (typeof fm.description !== 'string') {
    fail('description', 'description must be a string')
  } else {
    description = fm.description
    if (description.length < 1 || description.length > 1024) {
      fail('description', 'description must be 1-1024 characters')
    }
  }

  expectString(fm, 'license', fail)
  expectString(fm, 'compatibility', fail)
  expectString(fm, 'allowed-tools', fail)
  expectBoolean(fm, 'disable-model-invocation', fail)
  expectBoolean(fm, 'hide', fail)
  if (fm.metadata !== undefined && !isStringMap(fm.metadata)) {
    fail('metadata', 'metadata must be a map of string to string')
  }

  let phi: PhiSkillBlock | undefined
  let environment: EnvironmentRef | undefined
  if (fm.phi !== undefined && !isRecord(fm.phi)) {
    fail('phi', 'phi must be a mapping')
  } else if (isRecord(fm.phi)) {
    if (!validatePhiBlock(fm.phi)) {
      for (const error of validatePhiBlock.errors ?? []) {
        fail(schemaPath(error.instancePath), schemaMessage(error))
      }
    }
    const scriptsSet = fm.phi.scripts !== undefined
    const toolPrefix = fm.phi.toolPrefix
    if (scriptsSet && !insidePlugin && toolPrefix === undefined) {
      fail('phi.toolPrefix', 'toolPrefix is required when scripts is set')
    }
    if (insidePlugin && toolPrefix !== undefined) {
      fail('phi.toolPrefix', 'toolPrefix is rejected inside a plugin')
    }
    if (typeof toolPrefix === 'string') {
      const reserved = toolPrefixError(toolPrefix)
      if (reserved?.endsWith('is reserved')) fail('phi.toolPrefix', reserved)
    }

    if (typeof fm.phi.environment === 'string' && fm.phi.environment.length > 0) {
      try {
        environment = parseEnvironmentRef(fm.phi.environment)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        fail('phi.environment', message)
      }
      if (environment?.kind === 'path' && environment.path !== LOCAL_ENVIRONMENT) {
        fail('phi.environment', 'skill-local environment must be ./environment.yml')
      }
      if (environment?.kind === 'path' && environment.path === LOCAL_ENVIRONMENT) {
        validateLocalEnvironment(skillDir, fail)
      }
    }

    if (scriptsSet) validateScriptDeclarations(skillDir, fm.phi.scripts, fail)
    phi = toPhiBlock(fm.phi)
  }

  const scriptsDeclared = isRecord(fm.phi) && fm.phi.scripts !== undefined
  const skillHasScripts = hasScripts(skillDir) || scriptsDeclared
  const environmentDeclared = isRecord(fm.phi) && typeof fm.phi.environment === 'string'
  if (skillHasScripts && !environmentDeclared) {
    fail('phi.environment', 'environment is required when the skill has scripts')
  }
  if (!skillHasScripts && environmentDeclared) {
    fail('phi.environment', 'environment must not be declared when the skill has no scripts')
  }

  if (errors.length > 0 || name === undefined || description === undefined) {
    return finish(errors, warnings)
  }

  const frontmatter: SkillFrontmatter = { name, description }
  if (typeof fm.license === 'string') frontmatter.license = fm.license
  if (typeof fm.compatibility === 'string') frontmatter.compatibility = fm.compatibility
  if (isStringMap(fm.metadata)) frontmatter.metadata = fm.metadata
  if (typeof fm['allowed-tools'] === 'string') frontmatter['allowed-tools'] = fm['allowed-tools']
  if (typeof fm['disable-model-invocation'] === 'boolean') {
    frontmatter['disable-model-invocation'] = fm['disable-model-invocation']
  }
  if (typeof fm.hide === 'boolean') frontmatter.hide = fm.hide
  if ('globs' in fm) frontmatter.globs = fm.globs
  if ('alwaysApply' in fm) frontmatter.alwaysApply = fm.alwaysApply
  if (phi) frontmatter.phi = phi

  return finish(errors, warnings, {
    dir: skillDir,
    name,
    description,
    body: parsed.body,
    frontmatter,
    ...(phi ? { phi } : {}),
    ...(environment ? { environment } : {})
  })
}

function finish(
  errors: SkillProblem[],
  warnings: SkillProblem[],
  skill?: ValidatedSkill
): SkillValidationResult {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(skill && errors.length === 0 ? { skill } : {})
  }
}

function validateLocalEnvironment(
  skillDir: string,
  fail: (path: string, message: string) => void
): void {
  const specPath = join(skillDir, 'environment.yml')
  if (!isFile(specPath)) {
    fail('environment.yml', 'environment.yml is required for ./environment.yml')
  } else {
    try {
      const parsed = parseEnvironmentSpec(readFileSync(specPath, 'utf8'))
      if (!parsed.ok) {
        for (const message of parsed.errors) fail('environment.yml', message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail('environment.yml', `cannot read environment.yml: ${message}`)
    }
  }
  for (const platform of PHI_PLATFORMS) {
    const rel = `locks/${platform}.txt`
    if (!isFile(join(skillDir, 'locks', `${platform}.txt`))) {
      fail(rel, `lock file ${rel} is required`)
    }
  }
}

function validateScriptDeclarations(
  skillDir: string,
  scripts: unknown,
  fail: (path: string, message: string) => void
): void {
  if (!Array.isArray(scripts)) return
  const seen = new Set<string>()
  for (const [index, script] of scripts.entries()) {
    if (!isRecord(script)) continue
    const base = `phi.scripts[${index}]`
    if (typeof script.name === 'string') {
      if (seen.has(script.name)) fail(`${base}.name`, `duplicate script name '${script.name}'`)
      seen.add(script.name)
    }
    if (Array.isArray(script.run)) {
      script.run.forEach((arg, argIndex) => {
        if (typeof arg !== 'string' || !arg.startsWith('./')) return
        if (argIndex === 0) {
          fail(`${base}.run[0]`, 'run[0] must be a command resolved inside the environment')
        }
        const resolved = resolveInsideSkill(skillDir, arg)
        if (!resolved.ok) fail(`${base}.run[${argIndex}]`, resolved.message)
      })
    }
    if (isRecord(script.args)) validateArgs(script.args, `${base}.args`, fail)
    if (typeof script.output === 'string' && script.output.startsWith('./')) {
      validateOutput(skillDir, script.output, `${base}.output`, fail)
    }
  }
}

function validateArgs(
  args: Record<string, unknown>,
  path: string,
  fail: (path: string, message: string) => void
): void {
  if (args.type !== 'object') fail(`${path}.type`, 'args.type must be object')
  if (!isRecord(args.properties)) fail(`${path}.properties`, 'args.properties is required')
  if (args.additionalProperties !== false) {
    fail(`${path}.additionalProperties`, 'args.additionalProperties must be false')
  }
  if (args.required !== undefined) {
    if (!Array.isArray(args.required) || args.required.some((item) => typeof item !== 'string')) {
      fail(`${path}.required`, 'args.required must be an array of strings')
    } else if (isRecord(args.properties)) {
      for (const requiredName of args.required) {
        if (!Object.hasOwn(args.properties, requiredName)) {
          fail(`${path}.required`, `args.required lists unknown property '${requiredName}'`)
        }
      }
    }
  }
  if (!isRecord(args.properties)) return
  for (const [propName, schema] of Object.entries(args.properties)) {
    const propPath = `${path}.properties.${propName}`
    if (!ARG_NAME.test(propName)) {
      fail(propPath, `property name '${propName}' must match ^[a-z][a-z0-9_]*$`)
    }
    validateArgProperty(schema, propPath, fail, true)
  }
}

function validateArgProperty(
  schema: unknown,
  path: string,
  fail: (path: string, message: string) => void,
  allowArray: boolean
): void {
  if (!isRecord(schema)) {
    fail(path, 'property schema must be an object')
    return
  }
  if (schema.type === 'array') {
    if (!allowArray) {
      fail(`${path}.type`, "property type 'array' is not supported")
      return
    }
    if (schema.format !== undefined) {
      fail(`${path}.format`, 'format is only allowed on string properties')
    }
    if (!isRecord(schema.items)) {
      fail(`${path}.items`, 'array items must be string, number, integer, or boolean')
      return
    }
    validateArgProperty(schema.items, `${path}.items`, fail, false)
    return
  }
  if (typeof schema.type !== 'string' || !SCALAR_ARG_TYPES.has(schema.type)) {
    const typeName = schema.type === undefined ? 'missing' : String(schema.type)
    fail(`${path}.type`, `property type '${typeName}' is not supported`)
    return
  }
  if (schema.format === undefined) return
  if (schema.type !== 'string') {
    fail(`${path}.format`, 'format is only allowed on string properties')
    return
  }
  if (typeof schema.format !== 'string' || !PATH_FORMATS.has(schema.format)) {
    fail(`${path}.format`, `format '${String(schema.format)}' is not supported`)
  }
}

function validateOutput(
  skillDir: string,
  output: string,
  path: string,
  fail: (path: string, message: string) => void
): void {
  const resolved = resolveInsideSkill(skillDir, output)
  if (!resolved.ok) {
    fail(path, resolved.message)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolved.absolute, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(path, `output is not valid JSON: ${message}`)
    return
  }
  if (!isRecord(parsed)) fail(path, 'output schema must be a JSON object')
}

function resolveInsideSkill(
  skillDir: string,
  declared: string
): { ok: true; absolute: string } | { ok: false; message: string } {
  const segments = declared.startsWith('./') ? declared.slice(2).split('/') : []
  if (
    !declared.startsWith('./') ||
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return { ok: false, message: `path '${declared}' resolves outside the skill directory` }
  }
  const root = resolve(skillDir)
  const absolute = resolve(root, ...segments)
  if (escapes(root, absolute)) {
    return { ok: false, message: `path '${declared}' resolves outside the skill directory` }
  }
  // Compare real paths whatever the link sits on: a symlinked `scripts/` directory would
  // otherwise let `./scripts/x.py` point outside the skill.
  let realFile: string
  let realRoot: string
  try {
    realFile = realpathSync(absolute)
    realRoot = realpathSync(root)
  } catch {
    return { ok: false, message: `path '${declared}' does not exist` }
  }
  if (escapes(realRoot, realFile)) {
    return { ok: false, message: `path '${declared}' resolves outside the skill directory` }
  }
  if (!statSync(realFile).isFile()) {
    return { ok: false, message: `path '${declared}' is not a file` }
  }
  return { ok: true, absolute }
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function readOutputSchema(skillDir: string, output: string): Record<string, unknown> {
  const resolved = resolveInsideSkill(skillDir, output)
  if (!resolved.ok) {
    throw new Error(`output schema ${output} is not inside the skill: ${resolved.message}`)
  }
  const parsed: unknown = JSON.parse(readFileSync(resolved.absolute, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`output schema ${output} is not a JSON object`)
  return parsed
}

function walkScripts(current: string, seen: Set<string>): boolean {
  let real: string
  try {
    if (!statSync(current).isDirectory()) return false
    real = realpathSync(current)
  } catch {
    return false
  }
  if (seen.has(real)) return false
  seen.add(real)

  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const full = join(current, entry.name)
    if (SCRIPT_EXTENSIONS.has(extname(entry.name)) && isScriptFile(entry, full)) return true
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    try {
      if (statSync(full).isDirectory() && walkScripts(full, seen)) return true
    } catch {
      // Unreadable entries are not scripts.
    }
  }
  return false
}

function isScriptFile(
  entry: { isFile(): boolean; isSymbolicLink(): boolean },
  full: string
): boolean {
  if (entry.isFile()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(full).isFile()
  } catch {
    return false
  }
}

function toPhiBlock(value: Record<string, unknown>): PhiSkillBlock {
  const block: PhiSkillBlock = {}
  if (typeof value.environment === 'string') block.environment = value.environment
  if (Array.isArray(value.attachTo) && value.attachTo.every((item) => typeof item === 'string')) {
    block.attachTo = value.attachTo
  }
  if (typeof value.toolPrefix === 'string') block.toolPrefix = value.toolPrefix
  if (Array.isArray(value.scripts)) {
    block.scripts = value.scripts.filter(isRecord).map(toScriptDeclaration)
  }
  return block
}

function toScriptDeclaration(value: Record<string, unknown>): ScriptToolDeclaration {
  const run = Array.isArray(value.run)
    ? value.run.filter((item): item is string => typeof item === 'string')
    : []
  const declaration: ScriptToolDeclaration = {
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    run,
    args: isRecord(value.args) ? value.args : {},
    approval: value.approval === 'write' ? 'write' : 'read'
  }
  if (typeof value.output === 'string') declaration.output = value.output
  if (typeof value.timeoutSeconds === 'number') declaration.timeoutSeconds = value.timeoutSeconds
  return declaration
}

function expectString(
  fm: Record<string, unknown>,
  key: string,
  fail: (path: string, message: string) => void
): void {
  if (fm[key] !== undefined && typeof fm[key] !== 'string') fail(key, `${key} must be a string`)
}

function expectBoolean(
  fm: Record<string, unknown>,
  key: string,
  fail: (path: string, message: string) => void
): void {
  if (fm[key] !== undefined && typeof fm[key] !== 'boolean') fail(key, `${key} must be a boolean`)
}

function schemaPath(instancePath: string): string {
  if (!instancePath) return 'phi'
  let path = 'phi'
  for (const part of instancePath.split('/').filter(Boolean)) {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~')
    path += /^\d+$/.test(decoded) ? `[${decoded}]` : `.${decoded}`
  }
  return path
}

function schemaMessage(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'additionalProperties') {
    return `has unknown property '${String(params.additionalProperty)}'`
  }
  if (error.keyword === 'required') return `is missing '${String(params.missingProperty)}'`
  if (error.keyword === 'pattern') return `does not match ${String(params.pattern)}`
  return (error.message ?? 'is invalid').trim()
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}
