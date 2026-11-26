import type { PhiTool } from '../engine/types'
import {
  diagnoseLocalEnvironment,
  formatDiagnosticReportSummary,
  type DiagnoseLocalEnvironmentOptions,
  type EnvironmentDiagnoseTopic,
  type EnvironmentDiagnosticReport
} from '../environment/diagnose'
import type { SkillHostRequest } from './skill-tools'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'

export const PHI_ENV_DIAGNOSE_DESCRIPTION =
  'Read-only diagnostic of Phi runtime environments on this machine: OS/platform, WSL2 readiness on Windows, host container runtimes (Docker/Singularity), managed environments (phi-python, phi-r, phi-nextflow, plugin environments), configured remote SSH/HPC hosts, and actionable remediation steps for WSL2 or Nextflow blockers.'

const TOPICS: readonly EnvironmentDiagnoseTopic[] = ['all', 'nextflow', 'wsl', 'managed', 'remote']

const PROPERTIES = {
  topic: {
    type: 'string',
    enum: [...TOPICS],
    description:
      'Optional diagnostic scope: "all" (default), "nextflow", "wsl", "managed", or "remote".'
  },
  ref: {
    type: 'string',
    description:
      'Optional environment reference to focus on (for example "phi:nextflow@1", "phi:r@1", "phi:python@1", or "plugin:viz").'
  },
  profile: {
    type: 'string',
    description:
      'Optional Nextflow profile being requested (for example "conda", "docker", or "singularity").'
  }
} as const

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  details?: unknown
}

export interface EnvDiagnoseToolOptions {
  runtimeSessionId: string
  agentRunId?: string
}

export function buildEnvDiagnoseTool(
  request: SkillHostRequest,
  options: EnvDiagnoseToolOptions
): PhiTool {
  return {
    name: 'env_diagnose',
    label: 'Diagnose Phi Environments',
    description: PHI_ENV_DIAGNOSE_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    approval: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: PROPERTIES
    },
    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      return runEnvDiagnose(request, params, ctx.cwd, signal, options)
    }
  }
}

async function runEnvDiagnose(
  request: SkillHostRequest,
  params: unknown,
  cwd: string,
  signal: AbortSignal | undefined,
  options: EnvDiagnoseToolOptions
): Promise<ToolResult> {
  if (signal?.aborted) {
    return { content: [{ type: 'text', text: 'aborted' }], isError: true }
  }
  const input = isRecord(params) ? params : {}
  const topic = optionalTopic(input.topic)
  if (input.topic !== undefined && !topic) {
    return {
      content: [{ type: 'text', text: `topic must be one of: ${TOPICS.join(', ')}` }],
      isError: true
    }
  }
  const ref = optionalNonEmptyString(input.ref)
  if (input.ref !== undefined && !ref) {
    return {
      content: [{ type: 'text', text: 'ref must be a non-empty string' }],
      isError: true
    }
  }
  const profile = optionalNonEmptyString(input.profile)
  if (input.profile !== undefined && !profile) {
    return {
      content: [{ type: 'text', text: 'profile must be a non-empty string' }],
      isError: true
    }
  }

  try {
    const result = await request(
      'environments.diagnose',
      {
        runtimeSessionId: options.runtimeSessionId,
        cwd,
        ...(topic ? { topic } : {}),
        ...(ref ? { ref } : {}),
        ...(profile ? { profile } : {})
      },
      options.agentRunId ? { agentRunId: options.agentRunId } : undefined
    )
    if (!isDiagnosticReport(result)) {
      return {
        content: [{ type: 'text', text: 'environments.diagnose returned an unexpected result' }],
        isError: true
      }
    }
    return {
      content: [{ type: 'text', text: formatDiagnosticReportSummary(result) }],
      details: result
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: errorMessage(error) }],
      isError: true
    }
  }
}

/** Host RPC handler for `environments.diagnose`. Always read-only. */
export async function handleEnvironmentDiagnoseRequest(
  params: unknown,
  overrides: DiagnoseLocalEnvironmentOptions = {}
): Promise<EnvironmentDiagnosticReport> {
  const input = isRecord(params) ? params : {}
  const topic = optionalTopic(input.topic)
  const ref = optionalNonEmptyString(input.ref)
  const profile = optionalNonEmptyString(input.profile)
  const cwd = optionalNonEmptyString(input.cwd)
  return diagnoseLocalEnvironment({
    ...overrides,
    ...(cwd && !overrides.projectDir ? { projectDir: cwd } : {}),
    ...(topic ? { topic } : {}),
    ...(ref ? { ref } : {}),
    ...(profile ? { profile } : {})
  })
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function optionalTopic(value: unknown): EnvironmentDiagnoseTopic | undefined {
  if (typeof value !== 'string') return undefined
  return (TOPICS as readonly string[]).includes(value)
    ? (value as EnvironmentDiagnoseTopic)
    : undefined
}

function isDiagnosticReport(value: unknown): value is EnvironmentDiagnosticReport {
  return (
    isRecord(value) &&
    isRecord(value.platform) &&
    Array.isArray(value.hostDependencies) &&
    Array.isArray(value.managedEnvironments) &&
    Array.isArray(value.remoteHosts)
  )
}
