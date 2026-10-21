import type { PhiHostRequestContext } from '../engine/types'
import type { PresentArtifactsRequest } from '../content/skill-host'
import { MAX_PRESENTED_FILES, type PresentedFile } from '../../../shared/presentedFileTypes'

export interface DeliverablesPromptRun {
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  cancelled: boolean
}

interface ProjectLocation {
  kind: string
  hostProfileId?: string
  remoteRoot?: string
  canonicalRoot?: string
}

interface DeliverablesSession {
  projectId?: string | null
  projectLocation?: ProjectLocation
}

interface DeliverablesProject {
  location: ProjectLocation
}

interface FilesPresentedEvent extends Record<string, unknown> {
  type: 'files_presented'
  runId: string
  toolCallId: string
  files: PresentedFile[]
}

interface RemotePresentationIdentity {
  sessionId: string
  projectId: string
}

export interface DeliverablesPresentationDeps<StoredEvent> {
  agentDir: string
  fields: {
    optionalStringField(record: Record<string, unknown>, key: string): string | undefined
  }
  runs: {
    findByRuntimeSessionId(runtimeSessionId: string): DeliverablesPromptRun | null
  }
  sessions: {
    findById(sessionId: string): DeliverablesSession | undefined | null
  }
  projects: {
    getById(projectId: string): DeliverablesProject | undefined
  }
  remote: {
    isProjectAnchorPath(cwd: string, agentDir: string): boolean
    ownsRuntimeSession(runtimeSessionId: string): boolean
    bindingKey(identity: RemotePresentationIdentity): string
  }
  files: {
    validateLocal(cwd: string, value: unknown): PresentedFile[]
    validateRemote(identity: RemotePresentationIdentity, value: unknown): Promise<PresentedFile[]>
    statSize(path: string): number
  }
  timeline: {
    append(sessionId: string, event: FilesPresentedEvent): StoredEvent
    broadcast(sessionId: string, event: StoredEvent): void
  }
}

interface PresentableRun {
  run: DeliverablesPromptRun
  toolCallId: string
  remote?: RemotePresentationIdentity
}

function validDeliveryIdentity(
  runtimeSessionId: string | undefined,
  toolCallId: string | undefined
): { runtimeSessionId: string; toolCallId: string } {
  if (!runtimeSessionId || !toolCallId || toolCallId.length > 200) {
    throw new Error('Invalid file delivery request')
  }
  return { runtimeSessionId, toolCallId }
}

function isRemoteDelivery(
  run: DeliverablesPromptRun,
  manifest: DeliverablesSession | undefined | null,
  project: DeliverablesProject | undefined,
  deps: DeliverablesPresentationDeps<unknown>
): boolean {
  return (
    deps.remote.isProjectAnchorPath(run.cwd, deps.agentDir) ||
    manifest?.projectLocation?.kind === 'ssh' ||
    project?.location.kind === 'ssh'
  )
}

function hasRemoteProjectIdentity(
  run: DeliverablesPromptRun,
  manifest: DeliverablesSession | undefined | null,
  project: DeliverablesProject | undefined
): run is DeliverablesPromptRun & { projectId: string } {
  return Boolean(
    run.projectId &&
    manifest?.projectId === run.projectId &&
    manifest.projectLocation?.kind === 'ssh' &&
    project?.location.kind === 'ssh' &&
    manifest.projectLocation.hostProfileId === project.location.hostProfileId &&
    manifest.projectLocation.remoteRoot === project.location.remoteRoot &&
    manifest.projectLocation.canonicalRoot === project.location.canonicalRoot
  )
}

function presentableRun<StoredEvent>(
  runtimeSessionId: string | undefined,
  toolCallId: string | undefined,
  deps: DeliverablesPresentationDeps<StoredEvent>
): PresentableRun {
  const identity = validDeliveryIdentity(runtimeSessionId, toolCallId)
  const run = deps.runs.findByRuntimeSessionId(identity.runtimeSessionId)
  if (!run || run.cancelled) throw new Error('No active conversation for file delivery')
  const manifest = deps.sessions.findById(run.phiSessionId)
  const project = run.projectId ? deps.projects.getById(run.projectId) : undefined
  if (!isRemoteDelivery(run, manifest, project, deps)) {
    return { run, toolCallId: identity.toolCallId }
  }
  if (!hasRemoteProjectIdentity(run, manifest, project)) {
    throw new Error('Remote project identity is unavailable for file delivery')
  }
  return {
    run,
    toolCallId: identity.toolCallId,
    remote: { sessionId: run.phiSessionId, projectId: run.projectId }
  }
}

function assertRoutedDeliveryBinding(
  routed: boolean,
  runtimeSessionId: string | undefined,
  toolCallId: string,
  context: PhiHostRequestContext | undefined
): void {
  if (
    routed &&
    (context?.originSessionId !== runtimeSessionId ||
      context?.toolCallId !== toolCallId ||
      !context.signal)
  ) {
    throw new Error('RPC deliverable origin/call binding differs')
  }
}

function assertDeliveryStillCurrent<StoredEvent>(
  runtimeSessionId: string | undefined,
  presentation: PresentableRun,
  binding: string | undefined,
  deps: DeliverablesPresentationDeps<StoredEvent>
): void {
  if (
    presentableRun(runtimeSessionId, presentation.toolCallId, deps).run !== presentation.run ||
    (presentation.remote && deps.remote.bindingKey(presentation.remote) !== binding)
  ) {
    throw new Error('Deliverable run/project binding changed during inspection')
  }
}

function recordPresentedFiles<StoredEvent>(
  run: DeliverablesPromptRun,
  toolCallId: string,
  files: PresentedFile[],
  deps: DeliverablesPresentationDeps<StoredEvent>
): void {
  for (let index = 0; index < files.length; index += MAX_PRESENTED_FILES) {
    const batch = files.slice(index, index + MAX_PRESENTED_FILES)
    const stored = deps.timeline.append(run.phiSessionId, {
      type: 'files_presented',
      runId: run.runId,
      toolCallId,
      files: batch
    })
    deps.timeline.broadcast(run.phiSessionId, stored)
  }
}

export function createDeliverablesPresentation<StoredEvent>(
  deps: DeliverablesPresentationDeps<StoredEvent>
): {
  handlePresentFilesRequest(
    params: unknown,
    context?: PhiHostRequestContext
  ): Promise<{ files: PresentedFile[] }>
  presentScriptArtifacts(request: PresentArtifactsRequest): void
} {
  async function handlePresentFilesRequest(
    params: unknown,
    context?: PhiHostRequestContext
  ): Promise<{ files: PresentedFile[] }> {
    const record = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
    const request = record as Record<string, unknown>
    const runtimeSessionId = deps.fields.optionalStringField(request, 'runtimeSessionId')
    const toolCallId = deps.fields.optionalStringField(request, 'toolCallId')
    const presentation = presentableRun(runtimeSessionId, toolCallId, deps)
    const { run, toolCallId: callId, remote } = presentation
    const routed = runtimeSessionId && deps.remote.ownsRuntimeSession(runtimeSessionId)
    assertRoutedDeliveryBinding(Boolean(routed), runtimeSessionId, callId, context)
    context?.signal?.throwIfAborted()
    const binding = remote ? deps.remote.bindingKey(remote) : undefined
    const files = remote
      ? await deps.files.validateRemote(remote, request.files)
      : deps.files.validateLocal(run.cwd, request.files)
    context?.signal?.throwIfAborted()
    assertDeliveryStillCurrent(runtimeSessionId, presentation, binding, deps)
    recordPresentedFiles(run, callId, files, deps)
    return { files }
  }

  function presentScriptArtifacts(request: PresentArtifactsRequest): void {
    const { run, toolCallId } = presentableRun(request.runtimeSessionId, request.toolCallId, deps)
    const files: PresentedFile[] = request.artifacts.map((artifact) => ({
      path: artifact.path,
      displayPath: artifact.relativePath,
      bytes: deps.files.statSize(artifact.path),
      description: artifact.descriptor.title,
      artifact: {
        kind: artifact.descriptor.kind,
        title: artifact.descriptor.title,
        envId: request.envId
      }
    }))
    recordPresentedFiles(run, toolCallId, files, deps)
  }

  return { handlePresentFilesRequest, presentScriptArtifacts }
}
