import type { ModelSelection, PermissionMode, Project } from '../agent/projects'

export interface SessionStateInitialization {
  freshSessionCounter: number
  cwd: string
  selectedModel: ModelSelection | null | undefined
  sessionKey: string
}

interface SessionSwitchCollaborators {
  createSessionKey: (path: string | undefined, cwd: string) => string
  resolveSessionPermissionMode: (
    sessionKey: string,
    snapshot: { path: string | undefined; cwd: string }
  ) => PermissionMode
  resolveSessionKeyAlias: (sessionKey: string) => string
  sessionPermissionModes: Pick<Map<string, PermissionMode>, 'set'>
}

interface CreatedSessionPathCollaborators {
  isCurrentGeneration: (generation: number) => boolean
  sameCanonicalSessionKey: (left: string, right: string) => boolean
  uiSessionPathForKey: (sessionKey: string, path: string | undefined) => string | null
  notifySessionChanged: () => void
}

interface ProjectPermissionModeCollaborators {
  findPhiManifestForSession: (
    sessionKey: string,
    path: string | undefined,
    cwd: string
  ) => { projectId?: string | null } | null
  resolveSessionKeyAlias: (sessionKey: string) => string
  sessionPermissionModes: Pick<Map<string, PermissionMode>, 'set'>
  notifySessionChanged: () => void
}

export class SessionState {
  private currentFreshSessionCounter: number
  private currentSessionPath: string | undefined
  private currentCwd: string
  private currentPermissionMode: PermissionMode = 'auto'
  private currentSelectedModel: ModelSelection | null | undefined
  private currentModelSelectionRequest = 0
  private currentLastRememberedModelSelectionRequest = 0
  private currentSessionKey: string
  private currentSessionSwitchRequest = 0

  constructor(initial: SessionStateInitialization) {
    this.currentFreshSessionCounter = initial.freshSessionCounter
    this.currentCwd = initial.cwd
    this.currentSelectedModel = initial.selectedModel
    this.currentSessionKey = initial.sessionKey
  }

  get freshSessionCounter(): number {
    return this.currentFreshSessionCounter
  }

  get sessionPath(): string | undefined {
    return this.currentSessionPath
  }

  get cwd(): string {
    return this.currentCwd
  }

  get permissionMode(): PermissionMode {
    return this.currentPermissionMode
  }

  get selectedModel(): ModelSelection | null | undefined {
    return this.currentSelectedModel
  }

  get lastRememberedModelSelectionRequest(): number {
    return this.currentLastRememberedModelSelectionRequest
  }

  get sessionKey(): string {
    return this.currentSessionKey
  }

  get sessionSwitchRequest(): number {
    return this.currentSessionSwitchRequest
  }

  switchTo(
    path: string | undefined,
    cwd: string,
    permissionMode: PermissionMode,
    collaborators: SessionSwitchCollaborators
  ): void {
    if (!path) {
      this.currentFreshSessionCounter += 1
    }
    this.currentSessionPath = path
    this.currentCwd = cwd
    this.currentSessionKey = collaborators.createSessionKey(path, cwd)
    this.currentPermissionMode = collaborators.resolveSessionPermissionMode(
      this.currentSessionKey,
      {
        path,
        cwd
      }
    )
    if (!path) {
      collaborators.sessionPermissionModes.set(
        collaborators.resolveSessionKeyAlias(this.currentSessionKey),
        permissionMode
      )
      this.currentPermissionMode = permissionMode
    }
  }

  linkPhiManagedSessionKey(
    sessionKey: string,
    stablePath: string,
    stableKey: string,
    sameCanonicalSessionKey: (left: string, right: string) => boolean
  ): void {
    if (sameCanonicalSessionKey(sessionKey, this.currentSessionKey)) {
      this.currentSessionPath = stablePath
      this.currentSessionKey = stableKey
    }
  }

  linkMaterializedSessionKey(
    sessionKey: string,
    materializedKey: string,
    sameCanonicalSessionKey: (left: string, right: string) => boolean
  ): void {
    if (sameCanonicalSessionKey(sessionKey, this.currentSessionKey)) {
      this.currentSessionKey = materializedKey
    }
  }

  recordPromptRunMaterialization(
    runSessionKey: string,
    stableSessionPath: string,
    sameCanonicalSessionKey: (left: string, right: string) => boolean
  ): void {
    if (sameCanonicalSessionKey(runSessionKey, this.currentSessionKey)) {
      this.currentSessionPath = stableSessionPath
    }
  }

  updateCreatedSessionPath(
    sessionKey: string,
    generation: number,
    creationPath: string | undefined,
    collaborators: CreatedSessionPathCollaborators
  ): void {
    if (
      collaborators.isCurrentGeneration(generation) &&
      collaborators.sameCanonicalSessionKey(sessionKey, this.currentSessionKey)
    ) {
      const nextSessionPath = collaborators.uiSessionPathForKey(sessionKey, creationPath)
      if (this.currentSessionPath !== nextSessionPath) {
        this.currentSessionPath = nextSessionPath ?? undefined
        collaborators.notifySessionChanged()
      }
    }
  }

  refreshPermissionMode(
    resolveSessionPermissionMode: (
      sessionKey: string,
      snapshot: { path: string | undefined; cwd: string }
    ) => PermissionMode
  ): void {
    this.currentPermissionMode = resolveSessionPermissionMode(this.currentSessionKey, {
      path: this.currentSessionPath,
      cwd: this.currentCwd
    })
  }

  setPermissionMode(permissionMode: PermissionMode): void {
    this.currentPermissionMode = permissionMode
  }

  applyProjectPermissionMode(
    id: string,
    project: Pick<Project, 'workingDirectory'>,
    permissionMode: PermissionMode,
    collaborators: ProjectPermissionModeCollaborators
  ): void {
    const selected = collaborators.findPhiManifestForSession(
      this.currentSessionKey,
      this.currentSessionPath,
      this.currentCwd
    )
    if (selected?.projectId === id || project.workingDirectory === this.currentCwd) {
      this.currentPermissionMode = permissionMode
      collaborators.sessionPermissionModes.set(
        collaborators.resolveSessionKeyAlias(this.currentSessionKey),
        permissionMode
      )
      collaborators.notifySessionChanged()
    }
  }

  nextModelSelectionRequest(): number {
    return ++this.currentModelSelectionRequest
  }

  rememberModelSelection(
    request: number,
    model: ModelSelection | null,
    writeLastSelectedModel: (model: ModelSelection | null) => void
  ): void {
    if (request < this.currentLastRememberedModelSelectionRequest) return
    writeLastSelectedModel(model)
    this.currentSelectedModel = model
    this.currentLastRememberedModelSelectionRequest = request
  }

  nextSessionSwitchRequest(): number {
    return ++this.currentSessionSwitchRequest
  }
}
