import { realpathSync } from 'node:fs'
import type { AgentSession, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { approvalIdentifier } from '../lib/rpc-approval-protocol'
import { sameRpcChildRoot, type RpcChildRootScope } from '../lib/rpc-child-protocol'
import type { RpcTaskParentRun } from './rpc-task-admission'

type Registry = ReturnType<Parameters<ExtensionFactory>[0]['pi']['AgentRegistry']['global']>
type AgentReference = NonNullable<ReturnType<Registry['get']>>
interface ChildStreamParent {
  readonly run: Readonly<RpcTaskParentRun>
  readonly root: RpcChildRootScope
  readonly ref: AgentReference
  readonly session: AgentSession
}

export interface ChildLaunch {
  session: AgentSession
  run: Readonly<RpcTaskParentRun>
  background: boolean
  ref?: AgentReference
}
export interface TrackedChild {
  session: AgentSession
  root: RpcChildRootScope
  run: Readonly<RpcTaskParentRun>
  file: string
}
export interface AcceptedTask {
  session: AgentSession
  agents: readonly string[]
  root: RpcChildRootScope
  run: Readonly<RpcTaskParentRun>
}
export function launchMatchesChild(
  launch: ChildLaunch,
  ref: AgentReference,
  child: TrackedChild | undefined
): boolean {
  return (
    (!launch.ref || launch.ref === ref) &&
    (!child ||
      (child.session === launch.session &&
        child.run.signal === launch.run.signal &&
        child.run.runId === launch.run.runId &&
        child.run.controlSequence === launch.run.controlSequence))
  )
}

export function parentMatchesLaunch(
  parent: ChildStreamParent,
  launch: ChildLaunch,
  child: TrackedChild | undefined
): boolean {
  return (
    parent.session === launch.session &&
    parent.run.runId === launch.run.runId &&
    parent.run.controlSequence === launch.run.controlSequence &&
    (!child || sameRpcChildRoot(parent.root, child.root))
  )
}

export function rootSessionMatchesChild(parent: ChildStreamParent, registry: Registry): boolean {
  const { root, ref, session } = parent
  return (
    registry.get(root.rootAgentId) === ref &&
    ref.kind === 'main' &&
    ref.session === session &&
    session.sessionId === root.rootOmpSessionId &&
    session.sessionFile === root.rootSessionFile &&
    realpathSync(session.sessionManager.getCwd()) === root.cwd
  )
}

export function nativeRefMatchesChild(
  ref: AgentReference,
  nativeAgentId: string,
  root: RpcChildRootScope,
  child: TrackedChild | undefined
): boolean {
  return (
    ref.id === nativeAgentId &&
    ref.kind === 'sub' &&
    ref.parentId === root.rootAgentId &&
    ref.status === 'running' &&
    ref.session !== null &&
    typeof ref.sessionFile === 'string' &&
    ref.sessionFile.length > 0 &&
    (!child || ref.sessionFile === child.file) &&
    ref.session.sessionFile === ref.sessionFile &&
    ref.session.sessionId === ref.session.sessionManager.getSessionId() &&
    ref.session.sessionManager.getHeader()?.parentSession === root.rootSessionFile
  )
}

export function backgroundJobMatchesChild(
  launch: ChildLaunch,
  nativeAgentId: string,
  root: RpcChildRootScope
): boolean {
  if (!launch.background) return true
  const job = launch.session.asyncJobManager?.getJob(nativeAgentId)
  return (
    !!job &&
    job.agentId === nativeAgentId &&
    job.ownerId === root.rootAgentId &&
    job.type === 'task'
  )
}

export function validStreamCandidate(
  disposed: boolean,
  signal: AbortSignal,
  nativeAgentId: string
): boolean {
  return !disposed && !signal.aborted && !!approvalIdentifier(nativeAgentId)
}

export function lifecycleMatchesTask(
  event: Record<string, unknown>,
  launch: ChildLaunch,
  parent: AcceptedTask,
  ref: AgentReference,
  session: AgentSession
): boolean {
  return (
    launch.session === session &&
    parent.run.signal === launch.run.signal &&
    parent.session === session &&
    parent.agents.includes(String(event.agent)) &&
    !!ref.session &&
    ref.kind === 'sub' &&
    ref.parentId === parent.root.rootAgentId &&
    ref.sessionFile === event.sessionFile &&
    ref.session.sessionManager.getHeader()?.parentSession === parent.root.rootSessionFile
  )
}

export function abortedChildMatches(
  child: TrackedChild,
  ref: AgentReference,
  current: Readonly<RpcTaskParentRun>,
  session: AgentSession,
  registry: Registry
): boolean {
  return (
    child.session === session &&
    registry.get(ref.id) === ref &&
    ref.kind === 'sub' &&
    ref.parentId === child.root.rootAgentId &&
    ref.sessionFile === child.file &&
    registry.get(child.root.rootAgentId)?.session === session &&
    session.sessionId === child.root.rootOmpSessionId &&
    session.sessionFile === child.root.rootSessionFile &&
    current.runId === child.run.runId &&
    current.controlSequence === child.run.controlSequence &&
    current.signal === child.run.signal
  )
}
