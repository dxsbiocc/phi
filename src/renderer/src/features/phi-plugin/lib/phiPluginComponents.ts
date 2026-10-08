import type { PhiPluginScriptToolDetail } from '../../../../../shared/phiPluginTypes'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import { phiPluginComponentName } from './phiPlugins'

export type PhiPluginComponentKind = 'agent' | 'skill' | 'script'
export const PHI_PLUGIN_COMPONENT_LABELS = { agent: '智能体', skill: '技能', script: '脚本工具' }
export const PHI_PLUGIN_APPROVAL_LABELS = { read: '只读', write: '写入', execute: '执行' }

export interface PhiPluginInspectableComponent {
  key: string
  kind: PhiPluginComponentKind
  name: string
  description: string
  enabled?: boolean
  approval?: PhiPluginScriptToolDetail['approval']
  skillName?: string
  environmentRefs: string[]
  warning?: string
}

export function phiPluginInspectableComponents(
  plugin: PhiPluginDisplayItem
): PhiPluginInspectableComponent[] {
  const environmentsFor = (kind: 'agent' | 'skill', name: string): string[] =>
    plugin.environmentStatuses
      .filter((environment) =>
        (kind === 'agent' ? environment.agentNames : environment.skillNames)?.includes(name)
      )
      .map((environment) => environment.ref)
  const agents =
    plugin.agentDetails ??
    (plugin.agents ?? []).map((name) => ({ name: phiPluginComponentName(name), description: '' }))
  const skills =
    plugin.skillDetails ??
    (plugin.skills ?? []).map((name) => ({
      name: phiPluginComponentName(name),
      description: '',
      enabled: undefined,
      environmentRef: undefined,
      environmentWarning: undefined
    }))
  const tools =
    plugin.scriptToolDetails ??
    (plugin.scriptTools ?? []).map((name) => ({
      name,
      description: '',
      approval: undefined,
      skillName: undefined
    }))

  return [
    ...agents.map((agent): PhiPluginInspectableComponent => ({
      key: `agent:${agent.name}`,
      kind: 'agent',
      name: agent.name,
      description: agent.description,
      environmentRefs: environmentsFor('agent', agent.name)
    })),
    ...skills.map((skill): PhiPluginInspectableComponent => ({
      key: `skill:${skill.name}`,
      kind: 'skill',
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      environmentRefs: [
        ...new Set([
          ...(skill.environmentRef ? [skill.environmentRef] : []),
          ...environmentsFor('skill', skill.name)
        ])
      ],
      warning: skill.environmentWarning
    })),
    ...tools.map((tool): PhiPluginInspectableComponent => {
      const skill = skills.find((skill) => skill.name === tool.skillName)
      return {
        key: `script:${tool.name}`,
        kind: 'script',
        name: tool.name,
        description: tool.description,
        approval: tool.approval,
        skillName: tool.skillName,
        warning: skill?.environmentWarning,
        environmentRefs: [
          ...new Set([
            ...(skill?.environmentRef ? [skill.environmentRef] : []),
            ...(tool.skillName ? environmentsFor('skill', tool.skillName) : [])
          ])
        ]
      }
    })
  ]
}

export function phiPluginComponentEnvironments(
  plugin: PhiPluginDisplayItem,
  component: PhiPluginInspectableComponent
): Array<{ ref: string; name?: string }> {
  return component.environmentRefs.flatMap<{ ref: string; name?: string }>((ref) => {
    const candidates = plugin.environmentStatuses.filter((environment) => environment.ref === ref)
    const name = component.kind === 'script' ? component.skillName : component.name
    const associated = candidates.filter((environment) => {
      const members = component.kind === 'agent' ? environment.agentNames : environment.skillNames
      return name !== undefined && members?.includes(name)
    })
    const unscopedUnique =
      candidates.length === 1 && candidates[0].scope !== 'skill' && ref.includes(':')
    const matched = associated.length > 0 ? associated : unscopedUnique ? candidates : []
    return matched.length > 0
      ? matched.map((environment) => ({ ref, name: environment.name }))
      : [{ ref }]
  })
}
