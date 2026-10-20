import { AppCaches } from './app-caches'
import { MainWindowState } from './main-window-state'
import { SessionState, type SessionStateInitialization } from './session-state'
import { WorkspaceServicesState } from './workspace-services-state'

export interface MainRuntimeContext {
  window: MainWindowState
  workspaceServices: WorkspaceServicesState
  caches: AppCaches
  session: SessionState
}

export function createMainRuntimeContext(options: {
  session: SessionStateInitialization
}): MainRuntimeContext {
  return {
    window: new MainWindowState(),
    workspaceServices: new WorkspaceServicesState(),
    caches: new AppCaches(),
    session: new SessionState(options.session)
  }
}
