import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { DefaultResourceLoader } from './session-factory'
import type { SessionResourceSnapshot } from './session-resource-input'
import { buildAgentLeaderPrompt } from '../../agents/leader-prompt'

const LIVE_RESOURCE_PREFIX = '<phi_live_resource_snapshot>'

function skillLine(skill: unknown): string | undefined {
  if (!skill || typeof skill !== 'object') return undefined
  const value = skill as {
    name?: unknown
    description?: unknown
    filePath?: unknown
    hide?: unknown
  }
  if (value.hide === true || typeof value.name !== 'string' || !value.name) return undefined
  const description = typeof value.description === 'string' ? ` — ${value.description}` : ''
  const path = typeof value.filePath === 'string' ? ` (${value.filePath})` : ''
  return `- ${value.name}${description}${path}`
}

function liveResourceBlock(
  loader: DefaultResourceLoader,
  snapshot: SessionResourceSnapshot,
  includeSkills: boolean
): string {
  const skills = (includeSkills ? (snapshot.skills ?? []) : []).flatMap((skill) => {
    const line = skillLine(skill)
    return line ? [line] : []
  })
  const context = loader
    .getAgentsFiles()
    .agentsFiles.map((file) => `--- ${file.path} ---\n${file.content}`)
  const agentLeaderPrompt = buildAgentLeaderPrompt(snapshot.phiAgents ?? [])
  return [
    LIVE_RESOURCE_PREFIX,
    'This is the current authoritative resource snapshot. It supersedes earlier persona, skill, and context-file listings in this conversation.',
    ...(snapshot.personaMarkdown ? [`<persona>\n${snapshot.personaMarkdown}\n</persona>`] : []),
    `<skills>\n${skills.join('\n')}\n</skills>`,
    `<context_files>\n${context.join('\n\n')}\n</context_files>`,
    ...(agentLeaderPrompt ? [agentLeaderPrompt] : []),
    '</phi_live_resource_snapshot>'
  ].join('\n')
}

/** Adds one replaceable resource block while preserving OMP's per-turn memory/policy prompt. */
export function createLiveResourcePromptExtension(options: {
  snapshot: SessionResourceSnapshot
  loader(): DefaultResourceLoader | undefined
  includeSkills: boolean
}): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      const loader = options.loader()
      if (!loader) return undefined
      return {
        systemPrompt: [
          ...event.systemPrompt.filter(
            (block) => !block.startsWith(LIVE_RESOURCE_PREFIX) && !block.startsWith('<phi_agents>')
          ),
          liveResourceBlock(loader, options.snapshot, options.includeSkills)
        ]
      }
    })
  }
}
