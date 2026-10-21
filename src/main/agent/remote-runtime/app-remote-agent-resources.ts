import type { SkillContent } from '../../../shared/skillTypes'
import type {
  loadRemoteProjectSkillCatalog,
  readRemoteProjectSkillContent
} from '../content/remote-project-skill-service'
import type { PhiAgentDefinition } from '../agents/definition'
import type { AppRemoteSessionRoutingOptions } from '../remote-session-routing'
import type { listGlobalSkills, readGlobalSkillContent } from '../resources'

type AgentResourceLoader = NonNullable<AppRemoteSessionRoutingOptions['loadAgentResources']>
type AgentResourceIdentity = Parameters<AgentResourceLoader>[0]

export interface AppRemoteAgentResourcesDeps {
  agentDir: string
  sessions: {
    findById(sessionId: string): { cwd: string } | null | undefined
  }
  workspace: {
    resolveBinding(input: { sessionId: string; projectId: string }): { cacheKey: string }
  }
  catalogs: {
    loadProjectSkills: typeof loadRemoteProjectSkillCatalog
    listGlobalSkills: typeof listGlobalSkills
    readProjectSkill: typeof readRemoteProjectSkillContent
    readGlobalSkill: typeof readGlobalSkillContent
  }
}

async function loadAppRemoteAgentResources(
  identity: AgentResourceIdentity,
  definitions: readonly PhiAgentDefinition[],
  signal: AbortSignal,
  deps: AppRemoteAgentResourcesDeps
): ReturnType<AgentResourceLoader> {
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const binding = deps.workspace.resolveBinding(boundary).cacheKey
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (
      deps.sessions.findById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      deps.workspace.resolveBinding(boundary).cacheKey !== binding
    )
      throw new Error('专家资源的项目或主机绑定已改变')
  }
  assertCurrent()
  const context = { ...boundary, cwd: identity.resourceCwd, agentDir: deps.agentDir }
  const [catalog, globals] = await Promise.all([
    deps.catalogs.loadProjectSkills(context),
    deps.catalogs.listGlobalSkills()
  ])
  assertCurrent()
  const wanted = [...new Set(definitions.flatMap((definition) => definition.skills))]
  if (wanted.length > 1024) throw new Error('专家技能数量超过当前限制')
  const skills: Array<{ name: string; description: string; markdown: string }> = []
  for (const name of wanted) {
    const projectMatches = catalog.summaries.filter(
      (skill) => skill.name === name && catalog.sources.some((source) => source.name === name)
    )
    const globalMatches = globals.filter((skill) => skill.enabled && skill.name === name)
    if (projectMatches.length > 1 || (!projectMatches.length && globalMatches.length !== 1))
      throw new Error(`专家技能不可用：${name}`)
    const selected = projectMatches[0] ?? globalMatches[0]
    const content: SkillContent = projectMatches.length
      ? await deps.catalogs.readProjectSkill(context, selected.filePath)
      : await deps.catalogs.readGlobalSkill(selected.filePath)
    assertCurrent()
    const markdown = typeof content === 'string' ? content : content.content
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > 64 * 1024)
      throw new Error(`专家技能正文不可用：${name}`)
    skills.push({ name, description: selected.description, markdown })
  }
  return { skills }
}

export function createAppRemoteAgentResources(
  deps: AppRemoteAgentResourcesDeps
): AgentResourceLoader {
  return (identity, definitions, signal) =>
    loadAppRemoteAgentResources(identity, definitions, signal, deps)
}
