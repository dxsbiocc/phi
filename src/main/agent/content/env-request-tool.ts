import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { SkillHostRequest } from './skill-tools'

/** Live session binding. `env_request` replaces `ref` and `variables` after a successful rebind. */
export interface EnvRequestBinding {
  ref: string
  variables: Record<string, string>
  pluginId?: string
}

export interface EnvRequestToolOptions {
  runtimeSessionId: string
  /** Bound specialist session. `environment` defaults to `binding.ref`. */
  binding?: EnvRequestBinding
  /** Agent name sent to `environments.bindSession` after a bound request succeeds. */
  agent?: string
  /** Main agent: the model must pass `environment`. Omitted approval would be treated as exec. */
  requireEnvironment?: boolean
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  details?: unknown
}

const PROPERTIES = {
  packages: {
    type: 'array',
    items: { type: 'string' },
    description:
      '1\u201320 conda match specs (name, name=1.2, name>=1.2,<2). No channel prefixes (::) and no pip.'
  },
  reason: {
    type: 'string',
    description: 'Why these packages are needed (1\u2013500 characters). Shown to the user.'
  },
  environment: {
    type: 'string',
    description:
      'Environment reference to extend (phi:<name>@<major>, plugin:<name>, or project:<name>). Required for the main agent. In a bound session, defaults to the session environment.'
  }
} as const

export function buildEnvRequestTool(
  request: SkillHostRequest,
  options: EnvRequestToolOptions
): CustomTool {
  const required = options.requireEnvironment
    ? ['packages', 'reason', 'environment']
    : ['packages', 'reason']
  return {
    name: 'env_request',
    label: 'Request Environment Packages',
    description:
      'Ask the user to add conda packages to an environment in this project. On confirmation Phi solves a project environment, installs it, and (in a bound session) switches the session to it. Does not modify the original environment.',
    // The in-chat \u6dfb\u52a0/\u53d6\u6d88 question is the confirmation. `read` keeps this off the exec approval path; omitting approval is treated as exec.
    approval: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required,
      properties: PROPERTIES
    },
    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      return runEnvRequest(request, params, ctx.sessionManager.getCwd(), signal, options)
    }
  }
}

async function runEnvRequest(
  request: SkillHostRequest,
  params: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
  options: EnvRequestToolOptions
): Promise<ToolResult> {
  if (signal?.aborted) return errorResult('aborted')
  const input = isRecord(params) ? params : {}
  const environment = explicitEnvironment(input.environment) ?? options.binding?.ref
  if (!environment) return errorResult('environment is required')
  if (input.packages !== undefined && !isStringArray(input.packages)) {
    return errorResult('packages must contain 1 to 20 conda match specs')
  }
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    return errorResult('reason must be 1 to 500 characters')
  }

  try {
    const result = await request('environments.request', {
      runtimeSessionId: options.runtimeSessionId,
      cwd,
      packages: input.packages,
      reason: input.reason,
      environment,
      ...(options.binding?.pluginId ? { pluginId: options.binding.pluginId } : {})
    })
    if (isDeclined(result)) {
      return {
        content: [{ type: 'text', text: '\u7528\u6237\u53d6\u6d88\u4e86\u6dfb\u52a0' }],
        isError: true,
        details: result
      }
    }
    if (isFailure(result)) return errorResult(result.error, result)
    if (!isSuccess(result)) return errorResult('environments.request returned an unexpected result')
    if (options.binding) {
      const rebound = await rebind(request, options, result.ref, cwd)
      if (rebound) return rebound
    }
    return {
      content: [
        {
          type: 'text',
          text: `\u5df2\u6dfb\u52a0 ${result.added.join('\u3001')}\u3002\u73af\u5883 ${result.name}\uff08${result.ref}\uff09`
        }
      ],
      details: result
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

async function rebind(
  request: SkillHostRequest,
  options: EnvRequestToolOptions,
  ref: string,
  cwd: string
): Promise<ToolResult | undefined> {
  const binding = options.binding
  if (!binding) return undefined
  if (!options.agent) return errorResult('environment binding requires an agent name')
  const bound = await request('environments.bindSession', {
    runtimeSessionId: options.runtimeSessionId,
    ref,
    agent: options.agent,
    cwd,
    ...(binding.pluginId ? { pluginId: binding.pluginId } : {})
  })
  if (!isRecord(bound)) return errorResult('environments.bindSession returned an unexpected result')
  if (isRecord(bound.notReady)) {
    const message = bound.notReady.message
    if (typeof message === 'string' && message.length > 0) return errorResult(message)
    return errorResult('environments.bindSession returned an unexpected result')
  }
  const variables = stringRecord(bound.variables)
  if (typeof bound.ref !== 'string' || bound.ref.length === 0 || !variables) {
    return errorResult('environments.bindSession returned an unexpected result')
  }
  binding.ref = bound.ref
  binding.variables = variables
  return undefined
}

function explicitEnvironment(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

function isDeclined(value: unknown): value is { declined: true } {
  return isRecord(value) && value.declined === true
}

function isFailure(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string' && value.error.length > 0
}

function isSuccess(
  value: unknown
): value is { ref: string; envId: string; name: string; added: string[] } {
  if (!isRecord(value)) return false
  return (
    typeof value.ref === 'string' &&
    value.ref.length > 0 &&
    typeof value.envId === 'string' &&
    value.envId.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    isStringArray(value.added)
  )
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    record[key] = item
  }
  return record
}

function errorResult(text: string, details?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...(details !== undefined ? { details } : {})
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
