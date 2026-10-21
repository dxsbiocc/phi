import { AppCaches } from './app-caches'
import { MainWindowState } from './main-window-state'
import { SessionRuntime, type SessionRuntimeOptions } from './session-runtime'
import { SessionState, type SessionStateInitialization } from './session-state'
import { WorkspaceServicesState } from './workspace-services-state'

export interface MainRuntimeContext {
  window: MainWindowState
  workspaceServices: WorkspaceServicesState
  caches: AppCaches
  sessions: SessionRuntime
  session: SessionState
}

export function createMainRuntimeContext(options: {
  sessions: SessionRuntimeOptions
  session: (sessions: SessionRuntime) => SessionStateInitialization
}): MainRuntimeContext {
  const window = new MainWindowState()
  const workspaceServices = new WorkspaceServicesState()
  const caches = new AppCaches()
  const sessions = new SessionRuntime(options.sessions)
  const session = new SessionState(options.session(sessions))
  return { window, workspaceServices, caches, sessions, session }
}
