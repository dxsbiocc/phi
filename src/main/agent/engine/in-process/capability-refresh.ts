import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  CreateAgentSessionResult,
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition
} from '@oh-my-pi/pi-coding-agent'
import type { PhiTool, PhiToolUpdate } from '../types'
import { recentUserImages } from '../tool-adapter'
import { pickDeclaredToolInput } from '../../remote-workspace-tool-input'
import { listActiveSkillPackages } from '../../packages/store'
import { loadedPlugins } from '../../plugins/loader'
import { isRecord } from './common'

import { errorMessage } from '../../../../shared/errorCodes'
/** Keep the array passed by the legacy loader shim to the SDK alive across reloads. */
export function createLiveSkillSnapshot<T extends { name: string; source?: string }>(
  enabled: (skills: readonly T[]) => readonly T[]
): { skills: T[]; allowedSkills: string[]; sync(skills: readonly T[]): T[] } {
  const skills: T[] = []
  const allowedSkills: string[] = []
  return {
    skills,
    allowedSkills,
    sync(discovered) {
      const enabledNames = new Set(enabled(discovered).map((skill) => skill.name))
      const selected = discovered.filter(
        (skill) => skill.source === 'server-project' || enabledNames.has(skill.name)
      )
      skills.splice(0, skills.length, ...selected)
      allowedSkills.splice(0, allowedSkills.length, ...new Set(selected.map((skill) => skill.name)))
      return skills
    }
  }
}

export function installedCapabilitySkillFiles(agentDir: string, projectDir?: string): string[] {
  return [
    ...listActiveSkillPackages(agentDir).map((entry) => join(entry.dir, 'SKILL.md')),
    ...loadedPlugins({ agentDir, ...(projectDir ? { projectDir } : {}) }).flatMap((plugin) =>
      plugin.components.skills.map((dir) => join(dir, 'SKILL.md'))
    )
  ]
}

export function isInstalledCapabilitySkillFile(filePath: string, agentDir: string): boolean {
  return ['skill', 'plugin'].some((type) => {
    const inside = relative(resolve(agentDir, 'packages', type), resolve(filePath))
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
  })
}

type RuntimeSession = Pick<
  CreateAgentSessionResult['session'],
  'getAllToolInfos' | 'getEnabledToolNames' | 'runToolRegistryMutation'
>

/** A live extension adds tools without replacing SDK tools or another resource owner. */
export function createCapabilityToolRegistrar(current: () => RuntimeSession | undefined): {
  extension: ExtensionFactory
  register(tools: readonly PhiTool[], signal?: AbortSignal): Promise<string[]>
} {
  let api: ExtensionAPI | undefined
  const owned = new Set<string>()
  return {
    extension: (pi) => {
      // Reloading the discovery loader also evaluates inline factories. The session
      // owns the first loaded instance; later loader snapshots must not replace it.
      api ??= pi
    },
    async register(tools, signal) {
      signal?.throwIfAborted()
      const session = current()
      if (!api || !session) throw new Error('当前任务的模块工具注册器不可用')
      const existing = new Set(session.getAllToolInfos().map((tool) => tool.name))
      const previouslyEnabled = new Set(session.getEnabledToolNames())
      const added: string[] = []
      for (const tool of tools) {
        signal?.throwIfAborted()
        if (existing.has(tool.name) && !owned.has(tool.name)) continue
        if (owned.has(tool.name) && existing.has(tool.name) && previouslyEnabled.has(tool.name))
          continue
        api.registerTool(capabilityExtensionTool(tool))
        owned.add(tool.name)
        existing.add(tool.name)
        added.push(tool.name)
      }
      // SDK registerTool schedules its registry mutation synchronously. This public
      // barrier waits for both registration and presentation before the next turn.
      await session.runToolRegistryMutation(async () => undefined, signal)
      signal?.throwIfAborted()
      const registered = new Set(session.getAllToolInfos().map((tool) => tool.name))
      const enabled = new Set(session.getEnabledToolNames())
      const missing = added.filter((name) => !registered.has(name) || !enabled.has(name))
      if (missing.length > 0) {
        throw new Error(`模块工具尚未在当前任务生效：${missing.join('、')}`)
      }
      return added
    }
  }
}

function capabilityExtensionTool(tool: PhiTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as ToolDefinition['parameters'],
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    ...(tool.hidden === undefined ? {} : { hidden: tool.hidden }),
    ...(tool.loadMode === undefined ? {} : { loadMode: tool.loadMode }),
    ...(tool.approval === undefined ? {} : { approval: tool.approval }),
    execute: async (id, input, signal, onUpdate, ctx) =>
      tool.execute(
        id,
        pickDeclaredToolInput(input, tool.parameters),
        onUpdate as PhiToolUpdate | undefined,
        { cwd: ctx.sessionManager.getCwd(), recentUserImages: () => recentUserImages(ctx) },
        signal
      )
  }
}

export interface CapabilityRefreshDependencies {
  reloadResources(): Promise<void>
  refreshSkills(): Promise<void>
  refreshTools(signal?: AbortSignal): Promise<void>
  refreshConnector(name: string): Promise<void>
}

/** Installation approval stays on the host; only a completed installation refreshes a run. */
export async function refreshInstalledCapabilities(
  result: unknown,
  deps: CapabilityRefreshDependencies,
  signal?: AbortSignal
): Promise<void> {
  if (!isRecord(result) || result.ok !== true || result.installed !== true) return
  signal?.throwIfAborted()
  try {
    await deps.reloadResources()
    signal?.throwIfAborted()
    await deps.refreshSkills()
    signal?.throwIfAborted()
    await deps.refreshTools(signal)
    // Installer packages lists every installed package; usage identifies this approved plan.
    const packages = Array.isArray(result.usage)
      ? result.usage
      : Array.isArray(result.packages)
        ? result.packages
        : []
    const connectors = new Set(
      [...packages, result.root].flatMap((entry) =>
        isRecord(entry) && entry.type === 'mcp' && typeof entry.id === 'string' ? [entry.id] : []
      )
    )
    for (const name of connectors) {
      signal?.throwIfAborted()
      await deps.refreshConnector(name)
    }
  } catch (error) {
    signal?.throwIfAborted()
    const message = errorMessage(error)
    throw new Error(`模块已安装，但当前任务加载失败：${message}。请重新打开当前会话后继续。`)
  }
}
