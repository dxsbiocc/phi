import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'

import { validateAgentFile, type PhiAgentDefinition } from '../agents/definition'
import { toolPrefixError, validateSkill, type ValidatedSkill } from '../content/skill'
import {
  PHI_PLATFORMS,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock,
  type EnvironmentSpec,
  type PhiPlatform
} from '../envs/contract'
import { pluginManifestSchema, type PhiPluginManifest } from './phi-package'

const PACKAGE_FILE = 'phi-package.yaml'
const RESERVED_DIRECTORIES = ['mcp', 'wrappers', 'orchestrator'] as const

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateManifestSchema = ajv.compile(pluginManifestSchema)

export type PluginProblem = {
  level: 'error' | 'warning'
  path: string
  message: string
}

export interface ValidatedPluginEnvironment {
  name: string
  /** Manifest-relative environment spec path. */
  spec: string
  /** Absolute environment spec path. */
  specPath: string
  /** Absolute lock path for every platform Phi ships. */
  locks: Record<PhiPlatform, string>
  environment: EnvironmentSpec
}

export interface ValidatedPlugin {
  /** Absolute plugin source or installed directory. */
  dir: string
  manifest: PhiPluginManifest
  agents: PhiAgentDefinition[]
  skills: ValidatedSkill[]
  environments: Record<string, ValidatedPluginEnvironment>
}

export interface PluginValidationResult {
  ok: boolean
  errors: PluginProblem[]
  warnings: PluginProblem[]
  plugin?: ValidatedPlugin
}

/** Validate a plugin directory against Plugin contract v1 and its component contracts. */
export function validatePlugin(dir: string): PluginValidationResult {
  const pluginDir = resolve(dir)
  const errors: PluginProblem[] = []
  const warnings: PluginProblem[] = []
  const fail = (path: string, message: string): void => {
    errors.push({ level: 'error', path, message })
  }

  const manifest = readManifest(pluginDir, fail)
  if (!manifest) return finish(errors, warnings)

  for (const reserved of RESERVED_DIRECTORIES) {
    if (existsSync(join(pluginDir, reserved))) {
      fail(reserved, `'${reserved}' is reserved and must not be included in a v1 plugin`)
    }
  }

  const agentPaths = manifest.components.agents ?? []
  const skillPaths = manifest.components.skills ?? []
  if (agentPaths.length + skillPaths.length === 0) {
    fail('components', 'at least one agent or skill is required')
  }

  validateListedEntries(pluginDir, 'agents', agentPaths, 'file', fail)
  validateListedEntries(pluginDir, 'skills', skillPaths, 'directory', fail)

  const agents: PhiAgentDefinition[] = []
  for (const relativePath of agentPaths) {
    const filePath = join(pluginDir, relativePath)
    if (!isFile(filePath)) continue
    let content: string
    try {
      content = readFileSync(filePath, 'utf8')
    } catch (error) {
      fail(relativePath, `cannot read agent file: ${errorMessage(error)}`)
      continue
    }
    const result = validateAgentFile(filePath, content, 'phi')
    addComponentProblems(relativePath, result.errors, errors)
    addComponentProblems(relativePath, result.warnings, warnings)
    if (result.agent) agents.push(result.agent)
  }

  const skills: ValidatedSkill[] = []
  for (const relativePath of skillPaths) {
    const skillDir = join(pluginDir, relativePath)
    if (!isDirectory(skillDir)) continue
    const result = validateSkill(skillDir, { insidePlugin: true })
    addComponentProblems(relativePath, result.errors, errors)
    addComponentProblems(relativePath, result.warnings, warnings)
    if (result.skill) skills.push(result.skill)
  }

  const environments = validateEnvironments(pluginDir, manifest, fail)
  validateComponentEnvironmentRefs(manifest, agents, skills, fail)
  validateAttachTo(agents, skills, fail)

  const prefixProblem = toolPrefixError(manifest.toolPrefix)
  if (prefixProblem?.endsWith('is reserved')) fail('toolPrefix', prefixProblem)

  if (errors.length > 0) return finish(errors, warnings)
  return finish(errors, warnings, {
    dir: pluginDir,
    manifest,
    agents,
    skills,
    environments
  })
}

function readManifest(
  pluginDir: string,
  fail: (path: string, message: string) => void
): PhiPluginManifest | undefined {
  const path = join(pluginDir, PACKAGE_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail(PACKAGE_FILE, `cannot read ${PACKAGE_FILE}: ${errorMessage(error)}`)
    return undefined
  }

  let document: unknown
  try {
    document = parseYaml(text)
  } catch (error) {
    fail(PACKAGE_FILE, `YAML parse error: ${errorMessage(error)}`)
    return undefined
  }
  if (!isRecord(document)) {
    fail(PACKAGE_FILE, `${PACKAGE_FILE} must be a YAML mapping`)
    return undefined
  }

  if (!validateManifestSchema(document)) {
    for (const error of validateManifestSchema.errors ?? []) {
      fail(schemaPath(error), schemaMessage(error))
    }
    return undefined
  }
  return document as unknown as PhiPluginManifest
}

function validateListedEntries(
  pluginDir: string,
  component: 'agents' | 'skills',
  listedPaths: string[],
  expectedKind: 'file' | 'directory',
  fail: (path: string, message: string) => void
): void {
  const listed = new Set(listedPaths)
  for (const relativePath of listedPaths) {
    const fullPath = join(pluginDir, relativePath)
    const exists = expectedKind === 'file' ? isFile(fullPath) : isDirectory(fullPath)
    if (!exists) fail(relativePath, `listed ${expectedKind} does not exist`)
  }

  const componentDir = join(pluginDir, component)
  if (!existsSync(componentDir)) return
  if (!isDirectory(componentDir)) {
    fail(component, `${component} must be a directory`)
    return
  }

  let entries: string[]
  try {
    entries = readdirSync(componentDir)
  } catch (error) {
    fail(component, `cannot read ${component} directory: ${errorMessage(error)}`)
    return
  }
  for (const name of entries.sort()) {
    const relativePath = `${component}/${name}`
    if (!listed.has(relativePath)) {
      fail(relativePath, `${relativePath} is not listed in components.${component}`)
    }
  }
}

function validateEnvironments(
  pluginDir: string,
  manifest: PhiPluginManifest,
  fail: (path: string, message: string) => void
): Record<string, ValidatedPluginEnvironment> {
  const validated: Record<string, ValidatedPluginEnvironment> = {}
  for (const [name, declaration] of Object.entries(manifest.environments ?? {})) {
    const expectedSpec = `environments/${name}/environment.yml`
    if (declaration.spec !== expectedSpec) {
      fail(`environments.${name}.spec`, `spec for environment '${name}' must be ${expectedSpec}`)
    }

    const specPath = join(pluginDir, declaration.spec)
    let spec: EnvironmentSpec | undefined
    if (!isFile(specPath)) {
      fail(declaration.spec, 'environment spec does not exist')
    } else {
      try {
        const parsed = parseEnvironmentSpec(readFileSync(specPath, 'utf8'))
        if (!parsed.ok) {
          for (const message of parsed.errors) fail(declaration.spec, message)
        } else {
          spec = parsed.spec
          if (spec.name !== name) {
            fail(
              declaration.spec,
              `environment spec name '${spec.name}' must equal manifest name '${name}'`
            )
          }
        }
      } catch (error) {
        fail(declaration.spec, `cannot read environment spec: ${errorMessage(error)}`)
      }
    }

    const locks = {} as Record<PhiPlatform, string>
    let locksValid = true
    for (const platform of PHI_PLATFORMS) {
      const relativePath = `environments/${name}/locks/${platform}.txt`
      const lockPath = join(pluginDir, relativePath)
      if (!isFile(lockPath)) {
        locksValid = false
        fail(relativePath, `lock file ${relativePath} is required`)
        continue
      }
      locks[platform] = lockPath
      try {
        const lock = parseExplicitLock(readFileSync(lockPath, 'utf8'))
        if (!lock.ok) {
          locksValid = false
          for (const message of lock.errors) fail(relativePath, message)
        }
      } catch (error) {
        locksValid = false
        fail(relativePath, `cannot read lock file: ${errorMessage(error)}`)
      }
    }

    if (declaration.spec === expectedSpec && spec?.name === name && locksValid) {
      validated[name] = {
        name,
        spec: declaration.spec,
        specPath,
        locks,
        environment: spec
      }
    }
  }
  return validated
}

function validateComponentEnvironmentRefs(
  manifest: PhiPluginManifest,
  agents: PhiAgentDefinition[],
  skills: ValidatedSkill[],
  fail: (path: string, message: string) => void
): void {
  const declared = new Set(Object.keys(manifest.environments ?? {}))
  for (const agent of agents) {
    if (!agent.environment) continue
    const ref = parseEnvironmentRef(agent.environment)
    if (ref.kind === 'plugin' && !declared.has(ref.name)) {
      fail(
        `${relativeComponentPath(manifest.components.agents, agent.filePath)}:environment`,
        `plugin environment '${ref.name}' is not declared by plugin '${manifest.id}'`
      )
    }
  }
  for (const skill of skills) {
    const ref = skill.environment
    if (ref?.kind === 'plugin' && !declared.has(ref.name)) {
      fail(
        `${relativeComponentPath(manifest.components.skills, skill.dir)}:phi.environment`,
        `plugin environment '${ref.name}' is not declared by plugin '${manifest.id}'`
      )
    }
  }
}

function validateAttachTo(
  agents: PhiAgentDefinition[],
  skills: ValidatedSkill[],
  fail: (path: string, message: string) => void
): void {
  const ownAgents = new Set(agents.map((agent) => agent.name))
  for (const skill of skills) {
    const attachTo = skill.phi?.attachTo ?? ['main']
    for (const [index, target] of attachTo.entries()) {
      if (target !== 'main' && !ownAgents.has(target)) {
        fail(
          `${skillPath(skill)}:phi.attachTo[${index}]`,
          `attachTo target '${target}' must be main or an agent in this plugin`
        )
      }
    }
  }
}

function relativeComponentPath(paths: string[] | undefined, absolutePath: string): string {
  return paths?.find((path) => absolutePath.endsWith(path)) ?? absolutePath
}

function skillPath(skill: ValidatedSkill): string {
  return `skills/${skill.name}`
}

function addComponentProblems(
  componentPath: string,
  source: Array<{ level: 'error' | 'warning'; path: string; message: string }>,
  target: PluginProblem[]
): void {
  for (const problem of source) {
    target.push({
      level: problem.level,
      path: `${componentPath}:${problem.path}`,
      message: problem.message
    })
  }
}

function finish(
  errors: PluginProblem[],
  warnings: PluginProblem[],
  plugin?: ValidatedPlugin
): PluginValidationResult {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(plugin && errors.length === 0 ? { plugin } : {})
  }
}

function schemaPath(error: ErrorObject): string {
  const parts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'required') parts.push(String(params.missingProperty))
  if (error.keyword === 'additionalProperties') parts.push(String(params.additionalProperty))
  if (error.keyword === 'propertyNames' && typeof params.propertyName === 'string') {
    parts.push(params.propertyName)
  }
  if (parts.length === 0) return PACKAGE_FILE
  return parts.reduce(
    (path, part) => (path ? (/^\d+$/.test(part) ? `${path}[${part}]` : `${path}.${part}`) : part),
    ''
  )
}

function schemaMessage(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'additionalProperties') {
    return `unknown property '${String(params.additionalProperty)}'`
  }
  if (error.keyword === 'required') return 'is required'
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
