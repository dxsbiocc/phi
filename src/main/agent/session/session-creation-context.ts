import type { RuntimeRecoveryModelSelection } from '../../../shared/runtimeRecoveryTypes'
import type { ProjectMemorySettings } from '../../../shared/projectMemoryTypes'
import { resolve } from 'node:path'
import type { RuntimeSelectionControl } from '../engine/types'
import type { Project } from '../projects'
import { isRemoteProjectAnchorPath, remoteProjectAnchorPath } from '../remote-project-anchor'
import type { PhiSessionManifest } from './session-store'
import { StaleSessionError, type SessionSnapshot } from './session-lifecycle'
import type { RemoteSessionProject } from './session-creation-options'

interface SessionCreationRun {
  cancelled: boolean
}

export interface SessionCreationOwnership {
  sessionManifest: PhiSessionManifest | null
  project: Project | undefined
  remoteProject: RemoteSessionProject | null
}

export interface SessionCreationOwnershipDependencies {
  findManifest(sessionKey: string, path: string | undefined, cwd: string): PhiSessionManifest | null
  getProject(projectId: string): Project | undefined
  getProjectByCwd(cwd: string): Project | undefined
}

export interface SessionCreationOwnershipInput {
  sessionKey: string
  snapshot: SessionSnapshot
  generation: number
  lifecycle: SessionCreationLifecycle
  control?: RuntimeSelectionControl
  agentDir: string
}

function assertLocalOwnership(
  input: SessionCreationOwnershipInput,
  project: Project | undefined,
  remoteProject: RemoteSessionProject | null
): void {
  if (
    !remoteProject &&
    (project?.location?.kind === 'ssh' ||
      isRemoteProjectAnchorPath(input.snapshot.cwd, input.agentDir))
  ) {
    throw new Error('远程项目旧会话缺少服务器位置绑定，已拒绝在本机执行工具；请新建远程会话')
  }
}

function assertRemoteOwnership(
  snapshot: SessionSnapshot,
  project: Project | undefined,
  remoteProject: RemoteSessionProject | null
): void {
  if (
    remoteProject &&
    (!project ||
      project.location.kind !== 'ssh' ||
      resolve(snapshot.cwd) !== resolve(remoteProjectAnchorPath(project.id)) ||
      remoteProject.projectId !== project.id ||
      project.location.hostProfileId !== remoteProject.location.hostProfileId ||
      project.location.canonicalRoot !== remoteProject.location.canonicalRoot)
  ) {
    throw new Error('远程项目会话归属无效，请重新选择项目')
  }
}

export function resolveSessionCreationOwnership(
  input: SessionCreationOwnershipInput,
  dependencies: SessionCreationOwnershipDependencies
): SessionCreationOwnership {
  input.control?.assertCurrent()
  if (!input.lifecycle.isCurrentGeneration(input.generation)) throw new StaleSessionError()
  const sessionManifest = dependencies.findManifest(
    input.sessionKey,
    input.snapshot.path,
    input.snapshot.cwd
  )
  const project = sessionManifest?.projectId
    ? dependencies.getProject(sessionManifest.projectId)
    : dependencies.getProjectByCwd(input.snapshot.cwd)
  const remoteProject =
    sessionManifest?.projectLocation?.kind === 'ssh' &&
    typeof sessionManifest.projectId === 'string'
      ? { projectId: sessionManifest.projectId, location: sessionManifest.projectLocation }
      : null
  assertLocalOwnership(input, project, remoteProject)
  assertRemoteOwnership(input.snapshot, project, remoteProject)
  return { sessionManifest, project, remoteProject }
}

export interface SessionCreationLifecycle {
  isCurrentGeneration(generation: number): boolean
}

export interface SessionCreationContextDependencies {
  getPromptGeneration(sessionKey: string): number
  getActiveRun(sessionKey: string): SessionCreationRun | undefined
  findManifest(sessionKey: string, path: string | undefined, cwd: string): PhiSessionManifest | null
  getProject(projectId: string): Project | undefined
  getProjectByCwd(cwd: string): Project | undefined
  normalizeMemory(memory?: ProjectMemorySettings): ProjectMemorySettings
  remoteBinding(input: { sessionId: string; projectId: string }): string
}

export interface SessionCreationContextInput extends SessionCreationOwnership {
  sessionKey: string
  snapshot: SessionSnapshot
  generation: number
  lifecycle: SessionCreationLifecycle
  control?: RuntimeSelectionControl
  remoteRecovery?: { replacementModel?: RuntimeRecoveryModelSelection }
  dependencies: SessionCreationContextDependencies
}

export class SessionCreationContext {
  readonly sessionKey: string
  readonly snapshot: SessionSnapshot
  readonly generation: number
  readonly lifecycle: SessionCreationLifecycle
  readonly control: RuntimeSelectionControl | undefined
  readonly sessionManifest: PhiSessionManifest | null
  readonly project: Project | undefined
  readonly remoteProject: RemoteSessionProject | null
  readonly remoteRecovery: { replacementModel?: RuntimeRecoveryModelSelection } | undefined
  private readonly dependencies: SessionCreationContextDependencies
  private readonly initialPromptGeneration: number
  private readonly initialRun: SessionCreationRun | undefined
  private readonly initialOwnerBinding: string
  private readonly initialJournal: string
  private readonly remoteBinding: string | undefined

  constructor(input: SessionCreationContextInput) {
    this.sessionKey = input.sessionKey
    this.snapshot = input.snapshot
    this.generation = input.generation
    this.lifecycle = input.lifecycle
    this.control = input.control
    this.sessionManifest = input.sessionManifest
    this.project = input.project
    this.remoteProject = input.remoteProject
    this.remoteRecovery = input.remoteRecovery
    this.dependencies = input.dependencies
    this.initialPromptGeneration = input.dependencies.getPromptGeneration(input.sessionKey)
    this.initialRun = input.dependencies.getActiveRun(input.sessionKey)
    this.initialOwnerBinding = this.ownerBinding()
    this.initialJournal = JSON.stringify([
      input.sessionManifest?.runtimeRef?.ompSessionId,
      input.sessionManifest?.runtimeRef?.journalBasename
    ])
    this.remoteBinding = input.remoteProject
      ? input.dependencies.remoteBinding({
          sessionId: input.sessionManifest!.sessionId,
          projectId: input.remoteProject.projectId
        })
      : undefined
  }

  ownerBinding(): string {
    const latest = this.dependencies.findManifest(
      this.sessionKey,
      this.snapshot.path,
      this.snapshot.cwd
    )
    const latestProject = latest?.projectId
      ? this.dependencies.getProject(latest.projectId)
      : this.dependencies.getProjectByCwd(this.snapshot.cwd)
    return JSON.stringify([
      latest?.sessionId,
      latest?.projectId,
      latest?.cwd,
      latest?.cwdRealPath,
      latest?.projectLocation,
      latestProject?.location,
      this.dependencies.normalizeMemory(latestProject?.memory)
    ])
  }

  private initialRunChanged(): boolean {
    return Boolean(
      this.initialRun &&
      (this.initialRun.cancelled ||
        this.dependencies.getActiveRun(this.sessionKey) !== this.initialRun)
    )
  }

  private journalChanged(
    latest: PhiSessionManifest | null,
    allowInitialAdoption: boolean
  ): boolean {
    return Boolean(
      (!allowInitialAdoption || this.sessionManifest?.runtimeRef) &&
      JSON.stringify([latest?.runtimeRef?.ompSessionId, latest?.runtimeRef?.journalBasename]) !==
        this.initialJournal
    )
  }

  private remoteBindingChanged(): boolean {
    return Boolean(
      this.remoteProject &&
      this.dependencies.remoteBinding({
        sessionId: this.sessionManifest!.sessionId,
        projectId: this.remoteProject.projectId
      }) !== this.remoteBinding
    )
  }

  assertCurrent(allowInitialAdoption = false): void {
    this.control?.assertCurrent()
    const latest = this.dependencies.findManifest(
      this.sessionKey,
      this.snapshot.path,
      this.snapshot.cwd
    )
    if (
      !this.lifecycle.isCurrentGeneration(this.generation) ||
      this.dependencies.getPromptGeneration(this.sessionKey) !== this.initialPromptGeneration ||
      this.initialRunChanged() ||
      this.ownerBinding() !== this.initialOwnerBinding ||
      this.journalChanged(latest, allowInitialAdoption) ||
      this.remoteBindingChanged()
    ) {
      throw new StaleSessionError()
    }
  }
}
