import type { SkillSummary } from '../../../shared/skillTypes'
import {
  loadRemoteProjectSkillCatalog,
  type RemoteProjectSkillContext
} from '../content/remote-project-skill-service'
import { listGlobalSkills } from '../resources'

export interface RemoteProjectSkillServices {
  listGlobalSkills: typeof listGlobalSkills
  loadRemoteProjectSkillCatalog: typeof loadRemoteProjectSkillCatalog
}

const defaultServices: RemoteProjectSkillServices = {
  listGlobalSkills,
  loadRemoteProjectSkillCatalog
}

export interface RemoteProjectSkillsDeps {
  remoteSkillProjectContext: (cwd?: string) => RemoteProjectSkillContext
  services?: RemoteProjectSkillServices
}

export interface RemoteProjectSkills {
  listRemoteProjectSkills: (cwd?: string) => Promise<SkillSummary[]>
}

export function createRemoteProjectSkills(deps: RemoteProjectSkillsDeps): RemoteProjectSkills {
  const services = deps.services ?? defaultServices

  const listRemoteProjectSkills: RemoteProjectSkills['listRemoteProjectSkills'] = async (cwd) => {
    const [globalSkills, projectCatalog] = await Promise.all([
      services.listGlobalSkills(),
      services.loadRemoteProjectSkillCatalog(deps.remoteSkillProjectContext(cwd))
    ])
    const trustedNames = new Set(projectCatalog.sources.map((skill) => skill.name))
    return [
      ...globalSkills.filter((skill) => !trustedNames.has(skill.name)),
      ...projectCatalog.summaries
    ]
  }

  return { listRemoteProjectSkills }
}
