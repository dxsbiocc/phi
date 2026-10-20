// Owns GitHub content-source IPC registration and dependent catalog refreshes.
// Receives only source storage, fetch, and update-notification collaborators.
import type { IpcMain } from 'electron'

import { isRecord } from '../../shared/guards'
import { IPC } from '../../shared/ipcChannels'
import { writeAppLog } from '../agent/app-logger'
import {
  addGithubSource,
  applyGithubSourceUpdate,
  checkGithubSourceUpdate,
  listGithubSources,
  previewGithubSource,
  removeGithubSource
} from '../agent/packages/github-source'

export interface GithubSourceIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  workspace: {
    agentDir: string
  }
  sources: {
    officialRegistryFetch: typeof fetch
  }
  updates: {
    clearCachedPackageUpdates: () => void
    sendNoAvailableUpdates: () => void
  }
}

export function registerGithubSourceIpc(options: GithubSourceIpcOptions): void {
  const refreshGithubSourceDependantsForContext = (): Promise<void> =>
    refreshGithubSourceDependants(options)
  registerGithubSourcePreviewIpc(options, refreshGithubSourceDependantsForContext)
  registerGithubSourceMutationIpc(options, refreshGithubSourceDependantsForContext)
}

function refreshGithubSourceDependants(options: GithubSourceIpcOptions): Promise<void> {
  options.updates.clearCachedPackageUpdates()
  options.updates.sendNoAvailableUpdates()
  return Promise.resolve()
}

function registerGithubSourcePreviewIpc(
  options: GithubSourceIpcOptions,
  refreshGithubSourceDependantsForContext: () => Promise<void>
): void {
  const ipcMain = options.ipcMain
  const AGENT_DIR = options.workspace.agentDir
  const officialRegistryFetch = options.sources.officialRegistryFetch
  ipcMain.handle(IPC.sources.previewGithub, async (_, url: unknown) => {
    if (typeof url !== 'string' || url.length < 1 || url.length > 2048) {
      throw new Error('Invalid GitHub repository URL')
    }
    return previewGithubSource(url, { agentDir: AGENT_DIR, fetch: officialRegistryFetch })
  })
  ipcMain.handle(IPC.sources.addGithub, async (_, input: unknown) => {
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => key !== 'url' && key !== 'sha') ||
      typeof input.url !== 'string' ||
      input.url.length < 1 ||
      input.url.length > 2048 ||
      typeof input.sha !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(input.sha)
    ) {
      throw new Error('Invalid GitHub source import request')
    }
    const source = await addGithubSource(
      { url: input.url, sha: input.sha },
      { agentDir: AGENT_DIR, fetch: officialRegistryFetch }
    )
    await refreshGithubSourceDependantsForContext()
    writeAppLog({ event: 'github_source_added', metadata: { repo: source.repo, sha: source.sha } })
    return source
  })
  ipcMain.handle(IPC.sources.checkGithubUpdate, async (_, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) {
      throw new Error('Invalid GitHub source ID')
    }
    return checkGithubSourceUpdate(id, { agentDir: AGENT_DIR, fetch: officialRegistryFetch })
  })
}

function registerGithubSourceMutationIpc(
  options: GithubSourceIpcOptions,
  refreshGithubSourceDependantsForContext: () => Promise<void>
): void {
  const ipcMain = options.ipcMain
  const AGENT_DIR = options.workspace.agentDir
  const officialRegistryFetch = options.sources.officialRegistryFetch
  ipcMain.handle(IPC.sources.applyGithubUpdate, async (_, input: unknown) => {
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => key !== 'id' && key !== 'sha') ||
      typeof input.id !== 'string' ||
      !/^[a-f0-9]{16}$/.test(input.id) ||
      typeof input.sha !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(input.sha)
    ) {
      throw new Error('Invalid GitHub source refresh request')
    }
    const source = await applyGithubSourceUpdate(input.id, input.sha, {
      agentDir: AGENT_DIR,
      fetch: officialRegistryFetch
    })
    await refreshGithubSourceDependantsForContext()
    writeAppLog({
      event: 'github_source_updated',
      metadata: { repo: source.repo, sha: source.sha }
    })
    return source
  })
  ipcMain.handle(IPC.sources.removeGithub, async (_, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) {
      throw new Error('Invalid GitHub source ID')
    }
    const source = listGithubSources({ agentDir: AGENT_DIR }).sources.find(
      (entry) => entry.id === id
    )
    const removed = await removeGithubSource(id, { agentDir: AGENT_DIR })
    if (removed) {
      await refreshGithubSourceDependantsForContext()
      if (source) {
        writeAppLog({
          event: 'github_source_removed',
          metadata: { repo: source.repo, sha: source.sha }
        })
      }
    }
    return removed
  })
  ipcMain.handle(IPC.sources.listGithub, async () => {
    const state = listGithubSources({ agentDir: AGENT_DIR })
    if (state.error) {
      writeAppLog({ level: 'warn', event: 'github_sources_invalid' })
    }
    return state.sources
  })
}
