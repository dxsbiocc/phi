import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { getPhiEngine } from '../agent/engine/in-process-engine'
import { createProjectMemoryAccess } from '../agent/memory/project-memory-access'
import type { Project } from '../agent/projects'

export interface MemoryIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  workspace: {
    agentDir: string
  }
  projects: {
    requireProject: (id: string) => Project
  }
  memory: {
    retireProjectAdapters: (projectId: string) => Promise<void>
  }
}

export function registerMemoryIpc(options: MemoryIpcOptions): void {
  const ipcMain = options.ipcMain
  const requireProject = options.projects.requireProject
  const retireDesktopProjectMemoryAdapters = options.memory.retireProjectAdapters
  const { projectMemoryTarget, projectMemorySnapshot } = createProjectMemoryAccess({
    agentDir: options.workspace.agentDir,
    requireProject
  })

  ipcMain.handle(IPC.memory.snapshot, async (_, id: string) => projectMemorySnapshot(id))
  ipcMain.handle(IPC.memory.deleteLesson, async (_, id: string, index: unknown, text: unknown) => {
    const project = requireProject(id)
    await retireDesktopProjectMemoryAdapters(id)
    await getPhiEngine().memory.deleteLesson({
      ...projectMemoryTarget(project),
      index,
      text
    })
    return projectMemorySnapshot(id)
  })
  ipcMain.handle(IPC.memory.clear, async (_, id: string) => {
    const project = requireProject(id)
    await retireDesktopProjectMemoryAdapters(id)
    await getPhiEngine().memory.clear(projectMemoryTarget(project))
    return projectMemorySnapshot(id)
  })
}
