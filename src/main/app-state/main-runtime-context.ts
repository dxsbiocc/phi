import { AppCaches } from './app-caches'
import { MainWindowState } from './main-window-state'
import { SessionRuntime, type SessionRuntimeOptions } from './session-runtime'
import { SessionState, type SessionStateInitialization } from './session-state'
import { WorkspaceServicesState } from './workspace-services-state'

export interface MainRuntimeContext<TResult = unknown> {
  window: MainWindowState
  workspaceServices: WorkspaceServicesState
  caches: AppCaches
  sessions: SessionRuntime<TResult>
  session: SessionState
}

export function createMainRuntimeContext<TResult = unknown>(options: {
  sessions: SessionRuntimeOptions
  session: (sessions: SessionRuntime<TResult>) => SessionStateInitialization
}): MainRuntimeContext<TResult> {
  const window = new MainWindowState()
  const workspaceServices = new WorkspaceServicesState()
  const caches = new AppCaches()
  const sessions = new SessionRuntime<TResult>(options.sessions)
  const session = new SessionState(options.session(sessions))
  return { window, workspaceServices, caches, sessions, session }
}
