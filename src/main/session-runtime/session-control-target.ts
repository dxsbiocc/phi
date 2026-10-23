import type { RuntimeSelectionControl } from '../agent/engine/types'
import type { Project } from '../agent/projects'
import type { RemoteHostProfile } from '../agent/remote-hosts'
import type { CurrentSessionPayload } from '../agent/session/current-session-reads'
import {
  StaleSessionError,
  type SessionLifecycle,
  type SessionLifecycleRecord,
  type SessionSnapshot
} from '../agent/session/session-lifecycle'
import type { PhiSessionManifest } from '../agent/session/session-store'

export interface ControlSessionResult {
  session: {
    hasActiveAgentRuns?(): boolean
  }
}

export interface CapturedSessionControlTarget<TResult extends ControlSessionResult> {
  current: CurrentSessionPayload
  rpc: boolean
  assertCurrent(): void
  acceptManual(): void
  resolved(snapshot?: SessionSnapshot): Promise<TResult | null>
}

interface SessionControlAssertion<TResult extends ControlSessionResult> {
  key: string
  phiSessionId: string
  current: CurrentSessionPayload
  lifecycle: SessionLifecycle<TResult>
  generation: number
  promptGeneration: number
  record: SessionLifecycleRecord<TResult> | null
  initialBinding: string
  expectedJournal: string
  initializing: boolean
  acceptedManual: boolean
  manual: boolean
  requireIdle: boolean
  viewBound: boolean
}

export interface SessionControlTargetDeps<TResult extends ControlSessionResult> {
  state: {
    currentSessionKey(): string
    currentPayload(): CurrentSessionPayload
    keys: {
      canonicalize(key: string): string
      sameCanonical(left: string, right: string): boolean
      phiSessionIdFor(key: string): string | undefined
    }
    lifecycles: {
      forKey(key: string): SessionLifecycle<TResult>
    }
    runs: {
      generationFor(key: string): number
      hasActiveRun(key: string): boolean
      manualCompactionIds: {
        has(phiSessionId: string): boolean
      }
    }
    runnerActiveRun(phiSessionId: string): unknown
  }
  sessions: {
    findById(phiSessionId: string): PhiSessionManifest | null
    get(
      sessionKey: string,
      snapshot: SessionSnapshot,
      control: RuntimeSelectionControl
    ): Promise<TResult>
  }
  projects: {
    get(projectId: string): Project | undefined
    hostProfile(profileId: string): RemoteHostProfile | undefined
    connectionConfig(profile: RemoteHostProfile): unknown
  }
}

function sessionControlBinding<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>,
  manifest: PhiSessionManifest | null
): string {
  const project = manifest?.projectId ? deps.projects.get(manifest.projectId) : undefined
  const location = manifest?.projectLocation
  const profile =
    location?.kind === 'ssh' ? deps.projects.hostProfile(location.hostProfileId) : undefined
  return JSON.stringify([
    manifest?.projectId,
    manifest?.cwd,
    manifest?.cwdRealPath,
    location,
    project?.location,
    profile ? deps.projects.connectionConfig(profile) : null
  ])
}

function sessionControlJournal(manifest: PhiSessionManifest | null): string {
  return JSON.stringify([manifest?.runtimeRef?.ompSessionId, manifest?.runtimeRef?.journalBasename])
}

function assertSelectedSessionControlTarget<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>,
  assertion: SessionControlAssertion<TResult>,
  requireSelected: boolean,
  current: CurrentSessionPayload | undefined
): void {
  if (!requireSelected) return
  if (
    !current ||
    !deps.state.keys.sameCanonical(assertion.key, deps.state.currentSessionKey()) ||
    current.path !== assertion.current.path ||
    current.cwd !== assertion.current.cwd ||
    current.phiSessionId !== assertion.phiSessionId ||
    deps.state.lifecycles.forKey(deps.state.currentSessionKey()) !== assertion.lifecycle
  )
    throw new StaleSessionError()
}

function assertSessionControlAttachment<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>,
  assertion: SessionControlAssertion<TResult>,
  latest: PhiSessionManifest | null
): void {
  if (
    deps.state.keys.phiSessionIdFor(assertion.key) !== assertion.phiSessionId ||
    deps.state.lifecycles.forKey(assertion.key) !== assertion.lifecycle ||
    !assertion.lifecycle.isCurrentGeneration(assertion.generation) ||
    assertion.lifecycle.currentRecord !== assertion.record ||
    deps.state.runs.generationFor(assertion.key) !== assertion.promptGeneration ||
    sessionControlBinding(deps, latest) !== assertion.initialBinding ||
    (!assertion.initializing && sessionControlJournal(latest) !== assertion.expectedJournal)
  )
    throw new StaleSessionError()
}

function assertSessionControlIdle<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>,
  assertion: SessionControlAssertion<TResult>
): void {
  if (
    assertion.requireIdle &&
    (deps.state.runs.hasActiveRun(assertion.key) ||
      deps.state.runnerActiveRun(assertion.phiSessionId) ||
      (!assertion.manual && deps.state.runs.manualCompactionIds.has(assertion.phiSessionId)))
  )
    throw new Error('请等待当前会话运行结束后再修改压缩设置')
}

function assertSessionControlTargetCurrent<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>,
  assertion: SessionControlAssertion<TResult>
): void {
  const latest = deps.sessions.findById(assertion.phiSessionId)
  const requireSelected = assertion.viewBound && !assertion.acceptedManual
  const current = requireSelected ? deps.state.currentPayload() : undefined
  assertSelectedSessionControlTarget(deps, assertion, requireSelected, current)
  assertSessionControlAttachment(deps, assertion, latest)
  assertSessionControlIdle(deps, assertion)
}

interface CaptureControlOptions {
  manual?: boolean
  requireIdle?: boolean
  viewBound?: boolean
}

// Bind a control before its first await. RPC may advance its own checkpoint/runtime
// generation; the owner, lifecycle record, journal, project and host stay bound.
// Manual dispatch releases only the view fence so accepted work survives navigation.
function captureSessionControlTarget<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>,
  sessionKey: string,
  phiSessionId: string,
  options: CaptureControlOptions = {}
): CapturedSessionControlTarget<TResult> {
  const { manual = false, requireIdle = true, viewBound = true } = options
  const key = deps.state.keys.canonicalize(sessionKey)
  const current = deps.state.currentPayload()
  const lifecycle = deps.state.lifecycles.forKey(key)
  const generation = lifecycle.currentGeneration
  const promptGeneration = deps.state.runs.generationFor(key)
  let record = lifecycle.currentRecord
  let initializing = false
  let acceptedManual = false
  const manifest = deps.sessions.findById(phiSessionId)
  const initialBinding = sessionControlBinding(deps, manifest)
  let expectedJournal = sessionControlJournal(manifest)
  const rpc = Boolean(manifest?.runtimeRef || manifest?.projectLocation?.kind === 'ssh')
  const assertCurrent = (): void => {
    assertSessionControlTargetCurrent(deps, {
      key,
      phiSessionId,
      current,
      lifecycle,
      generation,
      promptGeneration,
      record,
      initialBinding,
      expectedJournal,
      initializing,
      acceptedManual,
      manual,
      requireIdle,
      viewBound
    })
  }
  assertCurrent()
  return {
    current,
    rpc,
    assertCurrent,
    acceptManual: (): void => {
      assertCurrent()
      if (!manual) throw new Error('只有手动压缩操作可以进入后台执行')
      acceptedManual = true
    },
    resolved: async (snapshot?: SessionSnapshot): Promise<TResult | null> => {
      assertCurrent()
      let pending = record?.promise
      if (!record && snapshot) {
        // getOrCreate installs this exact record synchronously without advancing
        // the Phi view generation. Only this call may adopt the initial attachment.
        initializing = !manifest?.runtimeRef
        pending = deps.sessions.get(key, snapshot, { assertCurrent })
        record = lifecycle.currentRecord
      }
      const result = pending ? await pending : null
      assertCurrent()
      if (requireIdle && rpc && result?.session.hasActiveAgentRuns?.())
        throw new Error('请等待专家任务运行结束后再修改会话')
      if (initializing) {
        expectedJournal = sessionControlJournal(deps.sessions.findById(phiSessionId))
        initializing = false
      }
      assertCurrent()
      return result
    }
  }
}

export interface SessionControlCapture<TResult extends ControlSessionResult> {
  capture(
    sessionKey: string,
    phiSessionId: string,
    manual?: boolean,
    requireIdle?: boolean,
    viewBound?: boolean
  ): CapturedSessionControlTarget<TResult>
}

export function createSessionControlTarget<TResult extends ControlSessionResult>(
  deps: SessionControlTargetDeps<TResult>
): SessionControlCapture<TResult> {
  return {
    capture: (sessionKey, phiSessionId, manual, requireIdle, viewBound) =>
      captureSessionControlTarget(deps, sessionKey, phiSessionId, {
        manual,
        requireIdle,
        viewBound
      })
  }
}
