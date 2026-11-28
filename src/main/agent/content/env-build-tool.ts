import type { PhiTool } from '../engine/types'
import { getRuntimeRoot, type PhiPlatform } from '../envs'
import { applyOverrides } from '../envs/project-environments'
import { listInstalledPlugins } from '../plugins/loader'
import { getPhiAgentDir } from '../runtime-paths'
import type { EnvironmentBuilds } from './environment-builds'
import {
  ensureEnvironmentReady,
  type ConfirmBuildRequest,
  type EnvironmentReady
} from './environment-gate'
import { describeEnvironment } from './environment-refs'
import type { SkillHostRequest } from './skill-tools'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'

export const PHI_ENV_BUILD_DESCRIPTION =
  'Prepare or build a Phi-managed environment (such as phi:nextflow@1, phi:r@1, phi:python@1, or plugin:<name>) on behalf of the user with an in-chat confirmation prompt and progress reporting. If WSL2 is required on Windows but missing, returns structured remediation guidance without failing mid-build.'

const PROPERTIES = {
  ref: {
    type: 'string',
    description:
      'Managed environment reference to build or verify (for example "phi:nextflow@1", "phi:r@1", "phi:python@1", or "plugin:viz").'
  },
  pluginId: {
    type: 'string',
    description:
      'Optional owning plugin id when building a plugin:<name> environment (inferred automatically if unique among installed plugins).'
  },
  reason: {
    type: 'string',
    description: 'Short user-facing explanation of why this environment is being prepared.'
  }
} as const

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  details?: unknown
}

export interface EnvBuildToolOptions {
  runtimeSessionId: string
  agentRunId?: string
}

export interface EnvBuildRpcResult {
  status: 'ready' | 'notReady' | 'aborted'
  ref: string
  envId?: string
  runtime?: 'native' | 'wsl2'
  message: string
  guidance?: Extract<EnvironmentReady, { status: 'notReady' }>['guidance']
}

export function buildEnvBuildTool(
  request: SkillHostRequest,
  options: EnvBuildToolOptions
): PhiTool {
  return {
    name: 'env_build',
    label: 'Build Managed Environment',
    description: PHI_ENV_BUILD_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    // Build confirmation is shown in-chat via confirmEnvironmentBuild.
    approval: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      properties: PROPERTIES
    },
    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      return runEnvBuild(request, params, ctx.cwd, signal, options)
    }
  }
}

async function runEnvBuild(
  request: SkillHostRequest,
  params: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
  options: EnvBuildToolOptions
): Promise<ToolResult> {
  if (signal?.aborted) {
    return { content: [{ type: 'text', text: 'aborted' }], isError: true }
  }
  const input = isRecord(params) ? params : {}
  const ref = optionalNonEmptyString(input.ref)
  if (!ref) {
    return { content: [{ type: 'text', text: 'ref is required' }], isError: true }
  }
  const pluginId = optionalNonEmptyString(input.pluginId)
  if (input.pluginId !== undefined && !pluginId) {
    return {
      content: [{ type: 'text', text: 'pluginId must be a non-empty string' }],
      isError: true
    }
  }
  const reason = optionalNonEmptyString(input.reason)

  try {
    const result = await request(
      'environments.build',
      {
        runtimeSessionId: options.runtimeSessionId,
        cwd,
        ref,
        ...(pluginId ? { pluginId } : {}),
        ...(reason ? { reason } : {})
      },
      options.agentRunId ? { agentRunId: options.agentRunId } : undefined
    )
    if (!isEnvBuildResult(result)) {
      return {
        content: [{ type: 'text', text: 'environments.build returned an unexpected result' }],
        isError: true
      }
    }
    return {
      content: [{ type: 'text', text: result.message }],
      ...(result.status !== 'ready' ? { isError: true } : {}),
      details: result
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: errorMessage(error) }],
      isError: true
    }
  }
}

export interface HandleEnvironmentBuildDeps {
  root?: string
  agentDir?: string
  environmentsDir?: string
  platform?: PhiPlatform
  builds?: EnvironmentBuilds
  confirmBuild?: (request: ConfirmBuildRequest) => Promise<boolean>
  probeWsl?: Parameters<typeof ensureEnvironmentReady>[0]['probeWsl']
  signal?: AbortSignal
}

/** Host RPC handler for `environments.build`. */
export async function handleEnvironmentBuildRequest(
  params: unknown,
  deps: HandleEnvironmentBuildDeps = {}
): Promise<EnvBuildRpcResult> {
  const input = isRecord(params) ? params : {}
  const runtimeSessionId = optionalNonEmptyString(input.runtimeSessionId)
  const ref = optionalNonEmptyString(input.ref)
  const cwd = optionalNonEmptyString(input.cwd)
  if (!ref) {
    return { status: 'notReady', ref: '', message: 'ref is required' }
  }

  const root = deps.root ?? getRuntimeRoot()
  const agentDir = deps.agentDir ?? getPhiAgentDir()
  const applied = cwd ? applyOverrides(ref, cwd) : { ref, warnings: [] }
  const resolvedPluginId =
    optionalNonEmptyString(input.pluginId) ?? inferPluginOwner(applied.ref, agentDir)

  let descriptor: ReturnType<typeof describeEnvironment>
  try {
    descriptor = describeEnvironment(applied.ref, {
      ...(cwd ? { projectDir: cwd } : {}),
      ...(resolvedPluginId ? { pluginId: resolvedPluginId } : {}),
      ...(deps.environmentsDir ? { environmentsDir: deps.environmentsDir } : {}),
      ...(deps.platform ? { platform: deps.platform } : {}),
      agentDir
    })
  } catch (error) {
    return {
      status: 'notReady',
      ref: applied.ref,
      message: `无法解析受管理环境 ${applied.ref}：${errorMessage(error)}`
    }
  }

  const outcome = await ensureEnvironmentReady({
    root,
    descriptor,
    ref: applied.ref,
    requester: { agent: 'Main' },
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(deps.builds ? { builds: deps.builds } : {}),
    ...(deps.confirmBuild ? { confirmBuild: deps.confirmBuild } : {}),
    ...(deps.probeWsl ? { probeWsl: deps.probeWsl } : {}),
    signal: deps.signal ?? new AbortController().signal
  })

  if (outcome.status === 'ready') {
    return {
      status: 'ready',
      ref: applied.ref,
      envId: outcome.handle.envId,
      runtime: descriptor.runtime ?? 'native',
      message: `环境 ${applied.ref} 已就绪（${outcome.handle.envId}${descriptor.runtime === 'wsl2' ? '，WSL2' : ''}）。`
    }
  }
  if (outcome.status === 'aborted') {
    return {
      status: 'aborted',
      ref: applied.ref,
      envId: outcome.envId,
      runtime: descriptor.runtime ?? 'native',
      message: `环境 ${applied.ref} 的构建已中止。`
    }
  }
  return {
    status: 'notReady',
    ref: applied.ref,
    envId: outcome.envId,
    runtime: descriptor.runtime ?? 'native',
    message: outcome.message,
    ...(outcome.guidance ? { guidance: outcome.guidance } : {})
  }
}

function inferPluginOwner(ref: string, agentDir: string): string | undefined {
  if (!ref.startsWith('plugin:')) return undefined
  const envName = ref.slice('plugin:'.length)
  const owners = listInstalledPlugins({ agentDir })
    .filter((plugin) => Boolean(plugin.manifest.environments?.[envName]))
    .map((plugin) => plugin.id)
  return owners.length === 1 ? owners[0] : undefined
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isEnvBuildResult(value: unknown): value is EnvBuildRpcResult {
  return (
    isRecord(value) &&
    (value.status === 'ready' || value.status === 'notReady' || value.status === 'aborted') &&
    typeof value.ref === 'string' &&
    typeof value.message === 'string'
  )
}
