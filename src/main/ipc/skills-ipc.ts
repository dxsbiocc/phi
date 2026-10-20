// Owns Skill resources and the shared content-resource enablement IPC surface.
// Enablement stays here because it toggles Skills and their peer content resources.
import type { IpcMain } from 'electron'

import type { EnablementScope } from '../../shared/enablementTypes'
import { IPC } from '../../shared/ipcChannels'
import {
  loadRemoteProjectSkillCatalog,
  readRemoteProjectSkillContent,
  revokeRemoteProjectSkillTrust,
  trustRemoteProjectSkill,
  type RemoteProjectSkillContext
} from '../agent/content/remote-project-skill-service'
import { checkedRemoteSkillTrustMutation } from '../agent/content/remote-skill-trust-request'
import {
  enablementScopeOptions as resolveEnablementScopeOptions,
  isEnablementItemKey
} from '../agent/enablement-request'
import { getEnablementSnapshot, setEnabled } from '../agent/enablement'
import { setMcpPackageEnabled } from '../agent/mcp-connectors'
import { setPluginEnabled, type PluginNamespace } from '../agent/plugins/loader'
import {
  deleteSkill,
  listSkills,
  readGlobalSkillContent,
  readSkillContent,
  setSkillDisabled
} from '../agent/resources'
import { resetWrapperCompositionCatalogCache } from '../agent/wrappers/composition/discovery'

export interface SkillsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  lifecycle: {
    invalidateAgentSession: () => Promise<void>
  }
  workspace: {
    agentDir: string
    getCurrentCwd: () => string
    isRemoteResourceScope: (cwd?: string) => boolean
    remoteSkillProjectContext: (cwd?: string) => RemoteProjectSkillContext
    listRemoteProjectSkills: (cwd?: string) => Promise<Awaited<ReturnType<typeof listSkills>>>
  }
  plugins: {
    installedPluginNamespace: (projectDir?: string) => Promise<PluginNamespace>
  }
}

export function registerSkillsIpc(context: SkillsIpcOptions): void {
  registerEnablementIpc(context)
  registerSkillResourcesIpc(context)
}

function registerEnablementIpc(context: SkillsIpcOptions): void {
  const ipcMain = context.ipcMain
  const AGENT_DIR = context.workspace.agentDir
  const isRemoteResourceScope = context.workspace.isRemoteResourceScope
  const installedPluginNamespace = context.plugins.installedPluginNamespace
  const enablementScopeOptions = (value: unknown): { projectDir?: string } =>
    resolveEnablementScopeOptions(value, isRemoteResourceScope)

  ipcMain.handle(IPC.enablement.get, async (_, projectCwd?: unknown) => {
    if (projectCwd !== undefined && typeof projectCwd !== 'string') {
      throw new Error('项目目录无效')
    }
    if (typeof projectCwd === 'string' && isRemoteResourceScope(projectCwd)) {
      throw new Error('Skills are not available for this remote project')
    }
    return getEnablementSnapshot({
      agentDir: AGENT_DIR,
      ...(typeof projectCwd === 'string' && projectCwd.length > 0 ? { projectDir: projectCwd } : {})
    })
  })
  // eslint-disable-next-line complexity -- This handler's existing scope-specific branches are preserved verbatim.
  ipcMain.handle(IPC.enablement.set, async (_, item: unknown, value: unknown, scope: unknown) => {
    if (!isEnablementItemKey(item)) throw new Error('Invalid enablement item ID')
    if (typeof value !== 'boolean' && value !== null) throw new Error('Invalid enablement value')
    const options = enablementScopeOptions(scope as EnablementScope)
    if (item.startsWith('plugin:')) {
      const pluginId = item.slice('plugin:'.length)
      const inherited = options.projectDir
        ? getEnablementSnapshot({ agentDir: AGENT_DIR, ...options }).global[item]
        : undefined
      const desired = value ?? inherited ?? true
      const result = setPluginEnabled(pluginId, desired, {
        agentDir: AGENT_DIR,
        ...options,
        names: await installedPluginNamespace(options.projectDir)
      })
      if (!result.ok) {
        throw new Error(
          result.errors.map((problem) => problem.message).join('; ') ||
            'Invalid Plugin enabled state'
        )
      }
      if (value === null) setEnabled(item, null, { agentDir: AGENT_DIR, ...options })
    } else if (item.startsWith('mcp:')) {
      const packageId = item.slice('mcp:'.length)
      const inherited = options.projectDir
        ? getEnablementSnapshot({ agentDir: AGENT_DIR, ...options }).global[item]
        : undefined
      const desired = value ?? inherited ?? true
      setEnabled(item, value, { agentDir: AGENT_DIR, ...options })
      setMcpPackageEnabled(packageId, desired, AGENT_DIR)
    } else {
      setEnabled(item, value, { agentDir: AGENT_DIR, ...options })
    }
    if (item.startsWith('wrapper:')) resetWrapperCompositionCatalogCache()
    return getEnablementSnapshot({ agentDir: AGENT_DIR, ...options })
  })
}

function registerSkillResourcesIpc(context: SkillsIpcOptions): void {
  const ipcMain = context.ipcMain
  const isRemoteResourceScope = context.workspace.isRemoteResourceScope
  const remoteSkillProjectContext = context.workspace.remoteSkillProjectContext
  const listRemoteProjectSkills = context.workspace.listRemoteProjectSkills
  const invalidateAgentSession = context.lifecycle.invalidateAgentSession
  ipcMain.handle(IPC.skills.list, async (_, cwd?: string) =>
    isRemoteResourceScope(cwd)
      ? listRemoteProjectSkills(cwd)
      : listSkills(cwd ?? context.workspace.getCurrentCwd())
  )
  ipcMain.handle(IPC.skills.read, async (_, filePath: string, cwd?: string) => {
    if (isRemoteResourceScope(cwd)) {
      const context = remoteSkillProjectContext(cwd)
      const catalog = await loadRemoteProjectSkillCatalog(context)
      if (catalog.summaries.some((skill) => skill.filePath === filePath)) {
        return readRemoteProjectSkillContent(context, filePath)
      }
      return readGlobalSkillContent(filePath)
    }
    return readSkillContent(filePath, cwd ?? context.workspace.getCurrentCwd())
  })
  ipcMain.handle(
    IPC.skills.setDisabled,
    async (_, filePath: string, disabled: boolean, cwd?: string) => {
      if (isRemoteResourceScope(cwd)) {
        throw new Error('Skills are not available for this remote project')
      }
      return setSkillDisabled(filePath, Boolean(disabled), cwd ?? context.workspace.getCurrentCwd())
    }
  )
  ipcMain.handle(IPC.skills.delete, async (_, filePath: string, cwd?: string) => {
    if (isRemoteResourceScope(cwd)) {
      throw new Error('Skills are not available for this remote project')
    }
    return deleteSkill(filePath, cwd ?? context.workspace.getCurrentCwd())
  })
  ipcMain.handle(IPC.skills.trustRemoteProject, async (_, input: unknown) => {
    const request = checkedRemoteSkillTrustMutation(input)
    const context = remoteSkillProjectContext(request.cwd)
    await trustRemoteProjectSkill(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return listRemoteProjectSkills(request.cwd)
  })
  ipcMain.handle(IPC.skills.revokeRemoteProjectTrust, async (_, input: unknown) => {
    const request = checkedRemoteSkillTrustMutation(input)
    const context = remoteSkillProjectContext(request.cwd)
    await revokeRemoteProjectSkillTrust(context, {
      relativePath: request.relativePath,
      contentHash: request.contentHash
    })
    await invalidateAgentSession()
    return listRemoteProjectSkills(request.cwd)
  })
}
