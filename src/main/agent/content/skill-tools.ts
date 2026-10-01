import { randomUUID } from 'node:crypto'

import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { ScriptToolResult } from './script-tools'
import type { SkillNotReady } from './skill-host'
import type { SkillRunResult } from './skill-run'
import type { ScriptToolDescriptor } from './skill-tool-types'

export type { ScriptToolDescriptor } from './skill-tool-types'

/** Host call used by the agent worker. `skills.cancel` is sent when the tool call aborts. */
export type SkillHostRequest = (method: string, params: unknown) => Promise<unknown>

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  details?: unknown
}

const SKILL_RUN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['skill', 'script'],
  properties: {
    skill: {
      type: 'string',
      description: 'Installed, enabled skill name.'
    },
    script: {
      type: 'string',
      description: 'Path relative to the skill scripts/ directory.'
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments passed verbatim after the script path.'
    },
    cwd: {
      type: 'string',
      description: 'Project-relative working directory. Defaults to the project root.'
    }
  }
} as const

const STRICT_FORBIDDEN = new Set([
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'default',
  'const',
  'nullable',
  'not',
  'if',
  'then',
  'else'
])

export interface SkillToolHostOptions {
  runtimeSessionId?: string
  /** Plugin that owns the bound specialist session. */
  pluginId?: string
  /** Environment the specialist session is bound to. The skill's own ref still wins. */
  sessionEnvironment?: string
  /**
   * Live binding shared with `env_request`. `ref` is read on each call and wins
   * over `sessionEnvironment`.
   */
  environmentBinding?: { ref: string }
}

export function buildSkillRunTool(
  request: SkillHostRequest,
  runtimeSessionIdOrOptions?: string | SkillToolHostOptions
): CustomTool {
  const options = skillHostOptions(runtimeSessionIdOrOptions)
  return {
    name: 'skill_run',
    label: 'Run Skill Script',
    description:
      "Run one program from an installed skill's scripts/ directory inside that skill's environment. The interpreter is chosen from the script extension. args are passed after the script path. cwd is a project-relative working directory.",
    approval: 'exec',
    parameters: SKILL_RUN_PARAMETERS,
    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      return runSkillTool(request, params, ctx.sessionManager.getCwd(), signal, options)
    }
  }
}

function skillHostOptions(value: string | SkillToolHostOptions | undefined): SkillToolHostOptions {
  if (typeof value === 'string') return { runtimeSessionId: value }
  return value ?? {}
}

function liveSessionEnvironment(options: SkillToolHostOptions): string | undefined {
  const live = options.environmentBinding?.ref
  if (typeof live === 'string' && live.length > 0) return live
  return options.sessionEnvironment
}

export function buildScriptTools(
  descriptors: readonly ScriptToolDescriptor[],
  request: SkillHostRequest,
  runtimeSessionIdOrOptions?: string | SkillToolHostOptions
): CustomTool[] {
  const options = skillHostOptions(runtimeSessionIdOrOptions)
  return descriptors.map((descriptor) => {
    const tool: CustomTool = {
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters as CustomTool['parameters'],
      approval: descriptor.approval,
      async execute(toolCallId, params, _onUpdate, ctx, signal) {
        return runScriptToolCall(
          request,
          descriptor.name,
          params,
          ctx.sessionManager.getCwd(),
          signal,
          options,
          toolCallId
        )
      }
    }
    if (isStrictToolSchema(descriptor.parameters)) tool.strict = true
    return tool
  })
}

async function runSkillTool(
  request: SkillHostRequest,
  params: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
  options: SkillToolHostOptions
): Promise<ToolResult> {
  const input = isRecord(params) ? params : {}
  const skill = typeof input.skill === 'string' ? input.skill : ''
  const script = typeof input.script === 'string' ? input.script : ''
  if (!skill || !script) return errorResult('skill and script are required')
  if (input.args !== undefined && !isStringArray(input.args)) {
    return errorResult('args must be an array of strings')
  }
  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    return errorResult('cwd must be a string')
  }

  const requestId = randomUUID()
  const body: Record<string, unknown> = { requestId, cwd, skill, script }
  if (isStringArray(input.args)) body.args = input.args
  if (typeof input.cwd === 'string') body.runCwd = input.cwd
  if (options.runtimeSessionId) body.runtimeSessionId = options.runtimeSessionId
  const sessionEnvironment = liveSessionEnvironment(options)
  if (sessionEnvironment) body.sessionEnvironment = sessionEnvironment
  if (options.pluginId) body.pluginId = options.pluginId

  try {
    const result = await callHost(request, 'skills.run', body, signal)
    if (isNotReady(result)) {
      return {
        content: [{ type: 'text', text: result.notReady.message }],
        isError: true,
        details: result.notReady
      }
    }
    if (!isSkillRunResult(result)) return errorResult('skill run returned an unexpected result')
    const failed = result.exitCode !== 0 || result.terminated !== undefined
    return {
      content: [{ type: 'text', text: formatSkillRun(result) }],
      ...(failed ? { isError: true } : {}),
      details: result
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

async function runScriptToolCall(
  request: SkillHostRequest,
  tool: string,
  params: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
  options: SkillToolHostOptions,
  toolCallId: string
): Promise<ToolResult> {
  const requestId = randomUUID()
  try {
    const result = await callHost(
      request,
      'skills.scriptTool',
      {
        requestId,
        cwd,
        tool,
        args: params ?? {},
        ...(options.runtimeSessionId ? { runtimeSessionId: options.runtimeSessionId } : {}),
        ...(liveSessionEnvironment(options)
          ? { sessionEnvironment: liveSessionEnvironment(options) }
          : {}),
        ...(options.pluginId ? { pluginId: options.pluginId } : {}),
        ...(toolCallId ? { toolCallId } : {})
      },
      signal
    )
    if (isScriptSuccess(result)) {
      return {
        content: [{ type: 'text', text: formatScriptSuccess(result) }],
        details: result
      }
    }
    if (isScriptFailure(result)) {
      return {
        content: [{ type: 'text', text: result.error }],
        isError: true,
        details: result
      }
    }
    return errorResult('script tool returned an unexpected result')
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

async function callHost(
  request: SkillHostRequest,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<unknown> {
  const requestId = params.requestId
  const cancel = (): void => {
    if (typeof requestId !== 'string') return
    void request('skills.cancel', { requestId }).catch(() => undefined)
  }
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await request(method, params)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

function formatSkillRun(result: SkillRunResult): string {
  const lines = [
    `exit code: ${result.exitCode === null ? 'null' : String(result.exitCode)}`,
    `env: ${result.envId}`,
    `command: ${result.resolvedCommand}`
  ]
  if (result.terminated) lines.push(`terminated: ${result.terminated}`)
  lines.push(`durationMs: ${result.durationMs}`)
  if (result.warnings.length > 0) {
    lines.push('warnings:', ...result.warnings.map((warning) => `- ${warning}`))
  }
  lines.push(result.truncated.stdout ? 'stdout: [truncated]' : 'stdout:', result.stdout)
  lines.push(stderrTruncatedLabel(result), result.stderr)
  return lines.join('\n')
}

function stderrTruncatedLabel(result: SkillRunResult): string {
  return result.truncated.stderr ? 'stderr: [truncated]' : 'stderr:'
}

function formatScriptSuccess(result: Extract<ScriptToolResult, { ok: true }>): string {
  const sections = [JSON.stringify(result.output, null, 2)]
  const presented = result.presentedArtifacts ?? []
  if (presented.length > 0) {
    sections.push(
      `artifacts:\n${presented.map((artifact) => `- ${artifact.title}: ${artifact.path}`).join('\n')}`
    )
  }
  if (result.warnings.length > 0) {
    sections.push(`warnings:\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** OpenAI-strict shape: closed objects, every property required, no decorative keywords. */
export function isStrictToolSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  for (const key of Object.keys(schema)) {
    if (STRICT_FORBIDDEN.has(key)) return false
  }
  if (typeof schema.type !== 'string') return false
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !isRecord(schema.properties)) return false
    const names = Object.keys(schema.properties)
    const required = schema.required
    if (required === undefined) return names.length === 0
    if (!Array.isArray(required) || required.some((item) => typeof item !== 'string')) return false
    if (required.length !== names.length || new Set(required).size !== names.length) return false
    const requiredSet = new Set(required)
    for (const name of names) {
      if (!requiredSet.has(name)) return false
      if (!isStrictToolSchema(schema.properties[name])) return false
    }
    return true
  }
  if (schema.type === 'array') return isStrictToolSchema(schema.items)
  return (
    schema.type === 'string' ||
    schema.type === 'number' ||
    schema.type === 'integer' ||
    schema.type === 'boolean'
  )
}

function isNotReady(value: unknown): value is SkillNotReady {
  if (!isRecord(value) || !isRecord(value.notReady)) return false
  const notReady = value.notReady
  return (
    typeof notReady.ref === 'string' &&
    typeof notReady.envId === 'string' &&
    typeof notReady.message === 'string'
  )
}

function isSkillRunResult(value: unknown): value is SkillRunResult {
  if (!isRecord(value)) return false
  return (
    typeof value.envId === 'string' &&
    typeof value.resolvedCommand === 'string' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    typeof value.durationMs === 'number' &&
    Array.isArray(value.warnings) &&
    isRecord(value.truncated)
  )
}

function isScriptSuccess(value: unknown): value is Extract<ScriptToolResult, { ok: true }> {
  return (
    isRecord(value) && value.ok === true && isRecord(value.output) && Array.isArray(value.warnings)
  )
}

function isScriptFailure(value: unknown): value is Extract<ScriptToolResult, { ok: false }> {
  return (
    isRecord(value) &&
    value.ok === false &&
    typeof value.error === 'string' &&
    Array.isArray(value.warnings)
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
