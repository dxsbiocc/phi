import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

import { runInEnvironment, type EnvHandle, type PhiPlatform, type RunResult } from '../envs'
import type { ScriptTool, ValidatedSkill } from './skill'
import {
  EnvironmentNotReadyError,
  describeEnvironment,
  readyEnvironment,
  resolveSkillEnvironment
} from './environment-refs'

const DEFAULT_TIMEOUT_SECONDS = 600
const STDERR_TAIL = 2000

const ajv = new Ajv({ allErrors: true, strict: false })
// Path formats are checked against the project tree, not by Ajv.
ajv.addFormat('input-path', true)
ajv.addFormat('project-path', true)
const validators = new WeakMap<object, ValidateFunction>()

export interface PresentedArtifactSummary {
  title: string
  path: string
}

export type ScriptToolResult =
  | {
      ok: true
      output: Record<string, unknown>
      envId: string
      warnings: string[]
      /** Project-relative paths of the valid artifacts, in listed order. */
      presented?: string[]
      /** Titles for `presented`, in the same order. Not written back to the descriptor. */
      presentedArtifacts?: PresentedArtifactSummary[]
    }
  | { ok: false; error: string; envId?: string; warnings: string[] }

export interface RunScriptToolInput {
  root: string
  projectDir: string
  skill: ValidatedSkill
  tool: ScriptTool
  args: unknown
  sessionEnvironment?: string
  environmentsDir?: string
  platform?: PhiPlatform
  signal?: AbortSignal
}

export async function runScriptTool(input: RunScriptToolInput): Promise<ScriptToolResult> {
  const warnings: string[] = []
  let validate: ValidateFunction
  try {
    validate = validatorFor(input.tool.args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `invalid arguments schema: ${message}`, warnings }
  }
  if (!validate(input.args)) {
    return { ok: false, error: formatErrors(validate.errors), warnings }
  }
  if (!isRecord(input.args)) {
    return { ok: false, error: 'arguments must be an object', warnings }
  }

  let args: Record<string, unknown>
  try {
    args = resolveArgumentPaths(input.projectDir, input.tool.args, input.args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message, warnings }
  }

  const choice = resolveSkillEnvironment(input.skill, input.sessionEnvironment)
  warnings.push(...choice.warnings)
  let env: EnvHandle
  try {
    const descriptor = describeEnvironment(choice.ref, {
      skill: input.skill,
      environmentsDir: input.environmentsDir,
      platform: input.platform
    })
    env = readyEnvironment(input.root, descriptor)
  } catch (error) {
    if (error instanceof EnvironmentNotReadyError) {
      return { ok: false, error: error.message, envId: error.envId, warnings }
    }
    return { ok: false, error: errorMessage(error), warnings }
  }

  let cwd: string
  try {
    cwd = realpathSync(input.projectDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: `project directory does not exist: ${input.projectDir} (${message})`,
      envId: env.envId,
      warnings
    }
  }

  let result: RunResult
  try {
    result = await runInEnvironment(env, [...input.tool.run, ...flagsFor(input.tool.args, args)], {
      cwd,
      signal: input.signal,
      timeoutMs: (input.tool.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
    })
  } catch (error) {
    return { ok: false, error: errorMessage(error), envId: env.envId, warnings }
  }

  if (result.terminated === 'timeout') {
    return { ok: false, error: 'timed out', envId: result.envId, warnings }
  }
  if (result.terminated === 'aborted') {
    return { ok: false, error: 'aborted', envId: result.envId, warnings }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: failureMessage(result.stdout, result.stderr, result.exitCode),
      envId: result.envId,
      warnings
    }
  }

  let output: unknown
  try {
    output = JSON.parse(result.stdout) as unknown
  } catch {
    return { ok: false, error: 'stdout is not a JSON object', envId: result.envId, warnings }
  }
  if (!isRecord(output)) {
    return { ok: false, error: 'stdout is not a JSON object', envId: result.envId, warnings }
  }
  if (input.tool.outputSchema) {
    let check: ValidateFunction
    try {
      check = validatorFor(input.tool.outputSchema)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: `output schema is invalid: ${message}`,
        envId: result.envId,
        warnings
      }
    }
    if (!check(output)) {
      return {
        ok: false,
        error: `output does not match the schema: ${formatErrors(check.errors)}`,
        envId: result.envId,
        warnings
      }
    }
  }
  return { ok: true, output, envId: result.envId, warnings }
}

/**
 * § 5.6. `write` tools, and any tool that declares a `project-path` argument, need approval.
 * A `read` tool whose path arguments are all `input-path` does not.
 */
export function scriptToolApproval(tool: ScriptTool, args: unknown): 'read' | 'write' {
  if (tool.approval === 'write') return 'write'
  if (schemaHasProjectPath(tool.args) || suppliedProjectPath(tool.args, args)) return 'write'
  return 'read'
}

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = schema as object
  const cached = validators.get(key)
  if (cached) return cached
  const compiled = ajv.compile(schema)
  validators.set(key, compiled)
  return compiled
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  const list = errors ?? []
  if (list.length === 0) return 'is invalid'
  return list
    .map((error) => {
      const message = error.message ?? 'is invalid'
      return error.instancePath ? `${error.instancePath} ${message}` : message
    })
    .join('; ')
}

function resolveArgumentPaths(
  projectDir: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args }
  for (const [name, prop] of Object.entries(objectProperties(schema))) {
    if (!Object.hasOwn(next, name) || next[name] === undefined) continue
    const format = pathFormat(prop)
    if (!format) continue
    const value = next[name]
    if (isRecord(prop) && prop.type === 'array') {
      if (!Array.isArray(value)) continue
      next[name] = value.map((item) => resolveFormattedPath(projectDir, format, item, name))
      continue
    }
    next[name] = resolveFormattedPath(projectDir, format, value, name)
  }
  return next
}

function resolveFormattedPath(
  projectDir: string,
  format: 'input-path' | 'project-path',
  value: unknown,
  name: string
): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string path`)
  return format === 'input-path'
    ? resolveInputPath(projectDir, value)
    : resolveProjectPath(projectDir, value)
}

function resolveInputPath(projectDir: string, value: string): string {
  if (value.length === 0) throw new Error(`input-path '${value}' is outside the project`)
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectDir, value)
  if (!isAbsolute(value) && !isInside(resolve(projectDir), absolute)) {
    throw new Error(`input-path '${value}' is outside the project`)
  }
  let real: string
  let realRoot: string
  try {
    real = realpathSync(absolute)
    realRoot = realpathSync(projectDir)
  } catch {
    throw new Error(`input-path '${value}' does not exist`)
  }
  if (!isInside(realRoot, real)) throw new Error(`input-path '${value}' is outside the project`)
  return real
}

function resolveProjectPath(projectDir: string, value: string): string {
  if (value.length === 0) throw new Error(`project-path '${value}' is outside the project`)
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectDir, value)
  if (!isInside(resolve(projectDir), absolute)) {
    throw new Error(`project-path '${value}' is outside the project`)
  }
  const realRoot = realpathSync(projectDir)
  const parent = dirname(absolute)
  let realParent: string
  try {
    realParent = realpathSync(parent)
  } catch {
    throw new Error(`project-path '${value}' parent does not exist`)
  }
  if (!isInside(realRoot, realParent)) {
    throw new Error(`project-path '${value}' is outside the project`)
  }
  const resolved = join(realParent, basename(absolute))
  if (!isInside(realRoot, resolved)) {
    throw new Error(`project-path '${value}' is outside the project`)
  }
  try {
    const real = realpathSync(absolute)
    if (!isInside(realRoot, real)) {
      throw new Error(`project-path '${value}' is outside the project`)
    }
    return real
  } catch (error) {
    if (error instanceof Error && error.message.includes('outside the project')) throw error
    return resolved
  }
}

function flagsFor(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const argv: string[] = []
  for (const [name, prop] of Object.entries(objectProperties(schema))) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) continue
    const value = args[name]
    const type = isRecord(prop) && typeof prop.type === 'string' ? prop.type : undefined
    if (type === 'boolean') {
      if (value === true) argv.push(`--${name}`)
      continue
    }
    if (type === 'array') {
      if (!Array.isArray(value)) continue
      for (const item of value) argv.push(`--${name}`, String(item))
      continue
    }
    argv.push(`--${name}`, String(value))
  }
  return argv
}

function failureMessage(stdout: string, stderr: string, exitCode: number | null): string {
  const reported = stdoutError(stdout)
  if (reported !== undefined) return reported
  if (stderr.length > 0) return stderr.slice(-STDERR_TAIL)
  return `exit code ${exitCode}`
}

function stdoutError(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!isRecord(parsed)) return undefined
    if (typeof parsed.error !== 'string' || parsed.error.length === 0) return undefined
    return parsed.error
  } catch {
    return undefined
  }
}

function schemaHasProjectPath(schema: Record<string, unknown>): boolean {
  return Object.values(objectProperties(schema)).some((prop) => pathFormat(prop) === 'project-path')
}

function suppliedProjectPath(schema: Record<string, unknown>, args: unknown): boolean {
  if (!isRecord(args)) return false
  const properties = objectProperties(schema)
  return Object.entries(args).some(([name, value]) => {
    if (value === undefined) return false
    return pathFormat(properties[name]) === 'project-path'
  })
}

function objectProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {}
}

function pathFormat(schema: unknown): 'input-path' | 'project-path' | undefined {
  if (!isRecord(schema)) return undefined
  if (schema.type === 'array') return pathFormat(schema.items)
  if (schema.type !== 'string') return undefined
  if (schema.format === 'input-path' || schema.format === 'project-path') return schema.format
  return undefined
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
