import { AppCaches } from './app-caches'
import { MainWindowState } from './main-window-state'
import { WorkspaceServicesState } from './workspace-services-state'

export interface MainRuntimeContext {
  window: MainWindowState
  workspaceServices: WorkspaceServicesState
  caches: AppCaches
}

export function createMainRuntimeContext(): MainRuntimeContext {
  return {
    window: new MainWindowState(),
    workspaceServices: new WorkspaceServicesState(),
    caches: new AppCaches()
  }
}
