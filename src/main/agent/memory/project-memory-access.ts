import type { ProjectMemorySnapshot } from '../../../shared/projectMemoryTypes'
import { normalizeProjectMemorySettings } from '../../../shared/projectMemoryTypes'
import { getPhiEngine } from '../engine/in-process-engine'
import type { Project } from '../projects'
import { ensureRemoteProjectAnchor } from '../remote-project-anchor'

export interface ProjectMemoryAccessOptions {
  agentDir: string
  requireProject: (id: string) => Project
}

export function createProjectMemoryAccess(options: ProjectMemoryAccessOptions): {
  projectMemoryTarget: (project: Project) => { agentDir: string; cwd: string }
  projectMemorySnapshot: (id: string) => Promise<ProjectMemorySnapshot>
} {
  const AGENT_DIR = options.agentDir
  const requireProject = options.requireProject

  /** The session manager cwd memory is keyed by: the project directory or the remote anchor. */
  function projectMemoryTarget(project: Project): { agentDir: string; cwd: string } {
    return {
      agentDir: AGENT_DIR,
      cwd:
        project.location.kind === 'ssh'
          ? ensureRemoteProjectAnchor(project.id)
          : project.workingDirectory
    }
  }

  async function projectMemorySnapshot(id: string): Promise<ProjectMemorySnapshot> {
    const project = requireProject(id)
    const files = await getPhiEngine().memory.read(projectMemoryTarget(project))
    return {
      projectId: id,
      settings: normalizeProjectMemorySettings(project.memory),
      summary: files.summary,
      summaryUpdatedAt: files.summaryUpdatedAt,
      lessons: files.lessons
    }
  }

  return { projectMemoryTarget, projectMemorySnapshot }
}
