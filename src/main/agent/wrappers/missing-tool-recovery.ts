import type {
  MissingToolCandidateSource,
  MissingToolId,
  MissingToolPrompt,
  MissingToolRejectReason
} from '../../../shared/agentInteractionTypes'
import type { RemoteDoctorReport } from '../../../shared/remoteDoctorTypes'
import type { RemoteContainerRuntime } from '../../../shared/wrapperRemoteTypes'
import type { ResolvedMissingToolChoice } from '../host-requests/missing-tool-prompt'

export interface MissingToolCandidate {
  path: string
  source: MissingToolCandidateSource
  version?: string
}

export type WrapperRecoverableTool = 'nextflow' | 'docker' | 'singularity'

export interface RemoteWrapperToolRecoveryInput {
  runtimeSessionId: string
  hostProfileId: string
  profile: RemoteContainerRuntime
  report: RemoteDoctorReport
  installLocation: string
}

export interface RemoteWrapperToolRecoveryDependencies {
  search(tool: WrapperRecoverableTool): Promise<MissingToolCandidate[]>
  prompt(input: MissingToolPrompt): Promise<ResolvedMissingToolChoice>
  validate(
    tool: WrapperRecoverableTool,
    path: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: MissingToolRejectReason }>
  save(tool: WrapperRecoverableTool, path: string): Promise<void>
  installNextflow(): Promise<string>
  rerun(): Promise<RemoteDoctorReport>
}

export type RemoteWrapperToolRecoveryResult =
  { status: 'ready'; report: RemoteDoctorReport } | { status: 'blocked'; error: string }

interface RequiredTool {
  id: WrapperRecoverableTool
  promptId: MissingToolId
  label: string
  installable: boolean
}

function failed(report: RemoteDoctorReport, id: string): boolean {
  return report.checks.some((check) => check.id === id && check.status === 'error')
}

function requiredTool(
  report: RemoteDoctorReport,
  profile: RemoteContainerRuntime
): RequiredTool | undefined {
  if (failed(report, 'nextflow') || failed(report, 'java')) {
    return { id: 'nextflow', promptId: 'nextflow', label: 'Nextflow', installable: true }
  }
  if (!failed(report, 'runtime')) return undefined
  if (profile === 'conda') return undefined
  if (profile === 'docker') {
    return { id: 'docker', promptId: 'docker', label: 'Docker', installable: false }
  }
  return {
    id: 'singularity',
    promptId: 'singularity',
    label: 'Singularity / Apptainer',
    installable: false
  }
}

function promptRequest(
  input: RemoteWrapperToolRecoveryInput,
  tool: RequiredTool,
  candidates: MissingToolCandidate[]
): MissingToolPrompt {
  return {
    runtimeSessionId: input.runtimeSessionId,
    tool: { id: tool.promptId, label: tool.label },
    candidates,
    ...(tool.installable
      ? {
          install: {
            environment: 'phi-nextflow',
            location: input.installLocation,
            packages: ['nextflow', 'openjdk>=17'],
            approximateSize: 'about 350 MiB download'
          }
        }
      : {})
  }
}

function declined(tool: RequiredTool): RemoteWrapperToolRecoveryResult {
  return {
    status: 'blocked',
    error: `${tool.label} is missing and the user declined to choose or install it.`
  }
}

const MAX_PROMPTS = 3

export async function recoverRemoteWrapperTools(
  input: RemoteWrapperToolRecoveryInput,
  dependencies: RemoteWrapperToolRecoveryDependencies
): Promise<RemoteWrapperToolRecoveryResult> {
  let current = input.report
  let rejectedPath: MissingToolPrompt['rejectedPath']
  for (let attempt = 0; attempt < MAX_PROMPTS; attempt += 1) {
    const tool = requiredTool(current, input.profile)
    if (!tool) return { status: 'ready', report: current }
    const candidates = await dependencies.search(tool.id).catch(() => [])
    const choice = await dependencies.prompt({
      ...promptRequest(input, tool, candidates),
      ...(rejectedPath ? { rejectedPath } : {})
    })
    rejectedPath = undefined
    if (choice.action === 'cancel') return declined(tool)
    let path: string
    if (choice.action === 'install') {
      if (!tool.installable) return declined(tool)
      path = await dependencies.installNextflow()
    } else {
      const validation = await dependencies.validate(tool.id, choice.path)
      if (!validation.ok) {
        // Ask again with the reason in the card; the user decides whether to retry or cancel.
        rejectedPath = { path: choice.path, reason: validation.error }
        continue
      }
      path = validation.path
    }
    await dependencies.save(tool.id, path)
    current = await dependencies.rerun()
  }
  if (rejectedPath) {
    return {
      status: 'blocked',
      error: `The ${rejectedPath.path} path was not accepted (${rejectedPath.reason}).`
    }
  }
  const remaining = requiredTool(current, input.profile)
  return remaining
    ? {
        status: 'blocked',
        error: `${remaining.label} is still unavailable after validating the selected path.`
      }
    : { status: 'ready', report: current }
}
