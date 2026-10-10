import { isAbsolute, posix, relative, sep } from 'node:path'

import { resolveSkillEnvironment } from '../content/environment-refs'
import type { ScriptTool, ValidatedSkill } from '../content/skill'
import type { SkillNotReady } from '../content/skill-host'
import type { SkillRunResult } from '../content/skill-run'
import type { ScriptToolResult } from '../content/script-tools'
import type { ScriptToolDescriptor } from '../content/skill-tool-types'
import type { CommandResult } from '../workspace-host/types'
import { parseRemoteScriptOutput, REMOTE_PATH_GUIDANCE } from './script-arguments'
import type { RemoteSkillBundle } from './skill-bundle'
import type { RemoteEnvironmentHandle, RemoteRuntimeWorkspace } from './types'

const INTERPRETERS: Readonly<Record<string, string>> = {
  '.py': 'python',
  '.R': 'Rscript',
  '.r': 'Rscript',
  '.sh': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.pl': 'perl'
}

export interface RemoteSkillRunRequest {
  requestId: string
  runtimeSessionId: string
  skill: string
  script: string
  args: string[]
  runCwd?: string
  sessionEnvironment?: string
  allowedSkills?: string[]
}

export interface RemoteScriptToolRequest {
  requestId: string
  runtimeSessionId: string
  tool: string
  args: unknown
  sessionEnvironment?: string
}

export function validRunRequest(params: unknown): RemoteSkillRunRequest {
  const record = requireRecord(params)
  const args = record.args === undefined ? [] : stringArray(record.args, 'args')
  const allowedSkills = record.allowedSkills
    ? stringArray(record.allowedSkills, 'allowedSkills')
    : undefined
  const runCwd = optionalText(record.runCwd)
  const sessionEnvironment = optionalText(record.sessionEnvironment)
  return {
    requestId: requireText(record, 'requestId'),
    runtimeSessionId: requireText(record, 'runtimeSessionId'),
    skill: requireText(record, 'skill'),
    script: requireText(record, 'script'),
    args,
    ...(runCwd !== undefined ? { runCwd } : {}),
    ...(sessionEnvironment ? { sessionEnvironment } : {}),
    ...(allowedSkills ? { allowedSkills } : {})
  }
}

export function validScriptToolRequest(params: unknown): RemoteScriptToolRequest {
  const record = requireRecord(params)
  if (!Object.hasOwn(record, 'args')) throw new Error('args is required')
  const sessionEnvironment = optionalText(record.sessionEnvironment)
  return {
    requestId: requireText(record, 'requestId'),
    runtimeSessionId: requireText(record, 'runtimeSessionId'),
    tool: requireText(record, 'tool'),
    args: record.args,
    ...(sessionEnvironment ? { sessionEnvironment } : {})
  }
}

export function requiredRequestId(params: unknown): string {
  return requireText(requireRecord(params), 'requestId')
}

export function checkedScript(bundle: RemoteSkillBundle, script: string): string {
  if (
    !script ||
    posix.isAbsolute(script) ||
    script.includes('\\') ||
    script.split('/').includes('..')
  ) {
    throw new Error(`script path must stay inside scripts/: '${script}'`)
  }
  const relativePath = posix.join('scripts', script)
  if (!bundle.files.has(relativePath)) throw new Error(`script '${script}' does not exist`)
  return posix.join(bundle.absoluteDir, relativePath)
}

export function checkedRawArgs(
  args: readonly string[],
  workspace: RemoteRuntimeWorkspace,
  bundle: RemoteSkillBundle
): string[] {
  return args.map((arg) => {
    if (arg.includes('\0')) throw new Error('skill argument contains NUL')
    if (
      posix.isAbsolute(arg) &&
      !inside(workspace.projectRoot, arg) &&
      !inside(bundle.absoluteDir, arg)
    ) {
      throw new Error(`无法把本机路径输入安全路由到远程项目：${arg}。${REMOTE_PATH_GUIDANCE}`)
    }
    return arg
  })
}

export async function projectCwd(
  workspace: RemoteRuntimeWorkspace,
  requested?: string
): Promise<string> {
  const value = requested || '.'
  if (posix.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) {
    throw new Error(`cwd 必须使用远程项目相对路径：'${value}'。${REMOTE_PATH_GUIDANCE}`)
  }
  const relativePath = posix.normalize(value)
  const stat = await workspace.projectHost.fs.stat(relativePath).catch(() => undefined)
  if (!stat || stat.kind !== 'directory') {
    throw new Error(`远程项目 cwd 不存在：'${value}'。${REMOTE_PATH_GUIDANCE}`)
  }
  return posix.join(workspace.projectRoot, relativePath)
}

export function translatedRun(
  skill: ValidatedSkill,
  tool: ScriptTool,
  bundle: RemoteSkillBundle
): string[] {
  return tool.run.map((item) => {
    if (!isAbsolute(item)) return item
    const part = relative(skill.dir, item)
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
      throw new Error('dynamic Skill command resolves outside the uploaded resource')
    }
    const remote = part.split(sep).join('/')
    if (!bundle.files.has(remote)) throw new Error('dynamic Skill command resource is missing')
    return posix.join(bundle.absoluteDir, remote)
  })
}

export function skillResult(
  result: CommandResult,
  env: RemoteEnvironmentHandle,
  command: readonly string[],
  signal: AbortSignal,
  durationMs: number,
  warnings: string[]
): SkillRunResult {
  const terminated = termination(result, signal)
  return {
    envId: env.envId,
    resolvedCommand: command.map(displayArg).join(' '),
    exitCode: result.code,
    ...(terminated ? { terminated } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: truncated(result),
    durationMs,
    warnings
  }
}

export function abortedSkillResult(): SkillRunResult {
  return {
    envId: '',
    resolvedCommand: '',
    exitCode: null,
    terminated: 'aborted',
    stdout: '',
    stderr: '',
    truncated: { stdout: false, stderr: false },
    durationMs: 0,
    warnings: []
  }
}

export function scriptToolResult(
  result: CommandResult,
  tool: ScriptTool,
  env: RemoteEnvironmentHandle,
  signal: AbortSignal,
  warnings: string[]
): ScriptToolResult {
  const ended = termination(result, signal)
  if (ended) {
    return {
      ok: false,
      error: ended === 'timeout' ? 'timed out' : 'aborted',
      envId: env.envId,
      warnings
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `exit code ${result.code}`,
      envId: env.envId,
      warnings
    }
  }
  try {
    return {
      ok: true,
      output: parseRemoteScriptOutput(tool, result.stdout),
      envId: env.envId,
      warnings
    }
  } catch (error) {
    return { ok: false, error: errorText(error), envId: env.envId, warnings }
  }
}

export function missingToolEnvironment(
  skill: ValidatedSkill,
  sessionEnvironment?: string
): ScriptToolResult {
  const ref = resolveSkillEnvironment(skill, sessionEnvironment).ref
  return { ok: false, error: `远程环境 ${ref} 尚未创建；请先调用 env_request。`, warnings: [] }
}

export function notReady(ref: string): SkillNotReady {
  return {
    notReady: { ref, envId: '', message: `远程环境 ${ref} 尚未创建；请先调用 env_request。` }
  }
}

export function descriptor(tool: ScriptTool, skill: string): ScriptToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.args,
    attachTo: [...tool.attachTo],
    skill,
    approval: tool.approval
  }
}

export function interpreter(script: string): string {
  const value = INTERPRETERS[posix.extname(script)]
  if (!value) throw new Error(`unsupported script extension for '${script}'`)
  return value
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function termination(
  result: CommandResult,
  signal: AbortSignal
): 'timeout' | 'aborted' | undefined {
  if (signal.aborted || result.terminationReason === 'cancelled') return 'aborted'
  return result.terminationReason === 'timeout' ? 'timeout' : undefined
}

function truncated(result: CommandResult): { stdout: boolean; stderr: boolean } {
  return {
    stdout: result.stdoutTruncated ?? (result.truncated && result.stdout.length > 0),
    stderr: result.stderrTruncated ?? (result.truncated && result.stderr.length > 0)
  }
}

function inside(root: string, target: string): boolean {
  const part = posix.relative(root, posix.normalize(target))
  return part === '' || (part !== '..' && !part.startsWith('../') && !posix.isAbsolute(part))
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value as string[]
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected an object')
  return value as Record<string, unknown>
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value) throw new Error(`${key} is required`)
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
