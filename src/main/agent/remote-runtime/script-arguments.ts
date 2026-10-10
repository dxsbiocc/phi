import { posix } from 'node:path'

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'

import type { ScriptTool } from '../content/skill'
import type { RemoteRuntimeWorkspace } from './types'

const OPTIONS = { allErrors: true, strict: false } as const
const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema'
const ajv = configured(new Ajv(OPTIONS))
const ajv2020 = configured(new Ajv2020(OPTIONS))
const validators = new WeakMap<object, ValidateFunction>()
export const REMOTE_PATH_GUIDANCE =
  '请先将输入上传或复制到远程项目，并传项目相对路径；没有回退到本机。'

export async function remoteScriptArguments(
  workspace: RemoteRuntimeWorkspace,
  schema: Record<string, unknown>,
  value: unknown
): Promise<{ args: Record<string, unknown>; flags: string[] }> {
  const validate = validatorFor(schema)
  if (!validate(value)) throw new Error(formatErrors(validate.errors))
  if (!isRecord(value)) throw new Error('arguments must be an object')
  const args: Record<string, unknown> = { ...value }
  for (const [name, property] of Object.entries(properties(schema))) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) continue
    const format = pathFormat(property)
    if (!format) continue
    args[name] = await resolvePathValue(workspace, property, format, args[name], name)
  }
  return { args, flags: flagsFor(schema, args) }
}

export function parseRemoteScriptOutput(tool: ScriptTool, stdout: string): Record<string, unknown> {
  let output: unknown
  try {
    output = JSON.parse(stdout) as unknown
  } catch {
    throw new Error('stdout is not a JSON object')
  }
  if (!isRecord(output)) throw new Error('stdout is not a JSON object')
  if (tool.outputSchema) {
    const validate = validatorFor(tool.outputSchema)
    if (!validate(output)) {
      throw new Error(`output does not match the schema: ${formatErrors(validate.errors)}`)
    }
  }
  return output
}

function configured<T extends Ajv | Ajv2020>(compiler: T): T {
  compiler.addFormat('input-path', true)
  compiler.addFormat('project-path', true)
  return compiler
}

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const cached = validators.get(schema)
  if (cached) return cached
  const compiler = schema.$schema === DRAFT_2020 ? ajv2020 : ajv
  const validate = compiler.compile(schema)
  validators.set(schema, validate)
  return validate
}

async function resolvePathValue(
  workspace: RemoteRuntimeWorkspace,
  property: unknown,
  format: 'input-path' | 'project-path',
  value: unknown,
  name: string
): Promise<unknown> {
  if (isRecord(property) && property.type === 'array') {
    if (!Array.isArray(value)) return value
    return Promise.all(value.map((item) => resolveRemotePath(workspace, format, item, name)))
  }
  return resolveRemotePath(workspace, format, value, name)
}

async function resolveRemotePath(
  workspace: RemoteRuntimeWorkspace,
  format: 'input-path' | 'project-path',
  value: unknown,
  name: string
): Promise<string> {
  if (typeof value !== 'string') throw new Error(`${name} must be a string path`)
  const relative = projectRelative(workspace.projectRoot, value)
  const target = posix.join(workspace.projectRoot, relative)
  if (format === 'input-path') {
    const stat = await workspace.projectHost.fs.stat(relative).catch(() => undefined)
    if (!stat || stat.kind === 'symlink') {
      throw new Error(`input-path '${value}' 不存在或无法安全解析。${REMOTE_PATH_GUIDANCE}`)
    }
  } else {
    const parent = posix.dirname(relative)
    const stat = await workspace.projectHost.fs.stat(parent).catch(() => undefined)
    if (!stat || stat.kind !== 'directory') {
      throw new Error(`project-path '${value}' 的远程父目录不存在。${REMOTE_PATH_GUIDANCE}`)
    }
    await rejectUnsafeExistingTarget(workspace, relative, value)
  }
  return target
}

async function rejectUnsafeExistingTarget(
  workspace: RemoteRuntimeWorkspace,
  relative: string,
  original: string
): Promise<void> {
  try {
    const target = await workspace.projectHost.fs.stat(relative)
    if (target.kind === 'symlink') throw new Error('symlink')
    return
  } catch {
    const parent = posix.dirname(relative)
    const name = posix.basename(relative)
    if (await directoryContains(workspace, parent, name)) {
      throw new Error(
        `project-path '${original}' 是不安全的符号链接或越界。${REMOTE_PATH_GUIDANCE}`
      )
    }
  }
}

async function directoryContains(
  workspace: RemoteRuntimeWorkspace,
  directory: string,
  name: string
): Promise<boolean> {
  let cursor: string | undefined
  do {
    const page = await workspace.projectHost.fs.list(directory, {
      limit: 1000,
      ...(cursor ? { cursor } : {})
    })
    if (page.entries.some((entry) => entry.name === name)) return true
    cursor = page.nextCursor
  } while (cursor)
  return false
}

function projectRelative(root: string, value: string): string {
  if (!value || value.includes('\0') || value.startsWith('~/')) {
    throw new Error(`path '${value}' 不属于远程项目。${REMOTE_PATH_GUIDANCE}`)
  }
  const relative = posix.isAbsolute(value) ? posix.relative(root, posix.normalize(value)) : value
  if (posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error(`path '${value}' 不属于远程项目。${REMOTE_PATH_GUIDANCE}`)
  }
  return posix.normalize(relative)
}

function flagsFor(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const argv: string[] = []
  for (const [name, property] of Object.entries(properties(schema))) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) continue
    const value = args[name]
    const type = isRecord(property) ? property.type : undefined
    if (type === 'boolean') {
      if (value === true) argv.push(`--${name}`)
    } else if (type === 'array' && Array.isArray(value)) {
      for (const item of value) argv.push(`--${name}`, String(item))
    } else argv.push(`--${name}`, String(value))
  }
  return argv
}

function properties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {}
}

function pathFormat(value: unknown): 'input-path' | 'project-path' | undefined {
  if (!isRecord(value)) return undefined
  const format = value.type === 'array' && isRecord(value.items) ? value.items.format : value.format
  return format === 'input-path' || format === 'project-path' ? format : undefined
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'is invalid'
  return errors
    .map(
      (error) =>
        `${error.instancePath ? `${error.instancePath} ` : ''}${error.message ?? 'is invalid'}`
    )
    .join('; ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
