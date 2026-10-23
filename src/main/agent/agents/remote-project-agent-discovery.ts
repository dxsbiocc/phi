import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { RemoteWorkspaceTargetMissingError } from '../remote-workspace-boundary'
import type { WorkspaceHost, WorkspaceEntry } from '../workspace-host/types'
import {
  validateAgentFile,
  type PhiAgentDefinition,
  type PhiAgentInvocation,
  type PhiAgentSource
} from './definition'
import type { PhiAgentDiagnostic } from './discovery'
import { remoteAgentTrustState, type RemoteAgentTrustState } from './remote-agent-trust-store'

import { errorMessage } from '../../../shared/errorCodes'

export const MAX_REMOTE_AGENT_FILE_BYTES = 256 * 1024
export const MAX_REMOTE_AGENT_DIRECTORY_ENTRIES = 256

const ROOTS = [
  { directory: '.phi/agents', source: 'phi' },
  { directory: '.omp/agents', source: 'compat' },
  { directory: '.pi/agents', source: 'compat' },
  { directory: '.claude/agents', source: 'compat' }
] as const satisfies readonly { directory: string; source: PhiAgentSource }[]

export type RemoteProjectAgentTrustState = RemoteAgentTrustState | 'invalid'

export interface RemoteProjectAgentEntry {
  id: string
  name: string
  description: string
  relativePath: string
  contentHash: string
  trustState: RemoteProjectAgentTrustState
  available: boolean
  diagnostics: string[]
  invocation?: PhiAgentInvocation
}

export interface RemoteProjectAgentDiscoveryResult {
  agents: PhiAgentDefinition[]
  entries: RemoteProjectAgentEntry[]
  diagnostics: PhiAgentDiagnostic[]
}

export interface RemoteProjectAgentDiscoveryOptions {
  host: WorkspaceHost
  projectRoot: string
  hostAlias: string
  agentDir: string
}

interface RemoteAgentFile {
  relativePath: string
  source: PhiAgentSource
  content: string
  contentHash: string
}

function diagnostic(filePath: string, message: string): PhiAgentDiagnostic {
  return { filePath, message, level: 'error' }
}

function missingPath(error: unknown): boolean {
  return (
    error instanceof RemoteWorkspaceTargetMissingError ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
  )
}

async function rootEntries(
  host: WorkspaceHost,
  directory: string,
  diagnostics: PhiAgentDiagnostic[]
): Promise<readonly WorkspaceEntry[]> {
  try {
    const result = await host.fs.list(directory, {
      limit: MAX_REMOTE_AGENT_DIRECTORY_ENTRIES + 1
    })
    if (result.nextCursor || result.entries.length > MAX_REMOTE_AGENT_DIRECTORY_ENTRIES) {
      diagnostics.push(
        diagnostic(directory, `agent 目录项超过 ${MAX_REMOTE_AGENT_DIRECTORY_ENTRIES} 个上限`)
      )
      return []
    }
    return result.entries
  } catch (error) {
    if (!missingPath(error)) {
      diagnostics.push(diagnostic(directory, errorMessage(error)))
    }
    return []
  }
}

function markdownEntry(entry: WorkspaceEntry): boolean {
  return entry.kind === 'file' && entry.name.endsWith('.md') && !entry.name.includes('\0')
}

async function readRemoteAgentFile(
  options: RemoteProjectAgentDiscoveryOptions,
  relativePath: string,
  source: PhiAgentSource
): Promise<RemoteAgentFile> {
  const stat = await options.host.fs.stat(relativePath)
  if (stat.kind !== 'file') throw new Error('远程 agent 不是普通文件')
  if (stat.size > MAX_REMOTE_AGENT_FILE_BYTES) {
    throw new Error('远程 agent 文件超过 256 KiB 上限')
  }
  const result = await options.host.fs.readRange(relativePath, {
    offset: 0,
    length: MAX_REMOTE_AGENT_FILE_BYTES + 1
  })
  if (!result.eof || result.bytesRead > MAX_REMOTE_AGENT_FILE_BYTES) {
    throw new Error('远程 agent 文件超过 256 KiB 上限')
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(result.content)
  } catch {
    throw new Error('远程 agent 文件不是有效 UTF-8 文本')
  }
  if (content.includes('\0')) throw new Error('远程 agent 文件是二进制内容')
  return {
    relativePath,
    source,
    content,
    contentHash: createHash('sha256').update(result.content).digest('hex')
  }
}

function invalidEntry(file: RemoteAgentFile, messages: string[]): RemoteProjectAgentEntry {
  const name = posix.basename(file.relativePath, '.md')
  return {
    id: `remote-project:${file.relativePath}:${file.contentHash}`,
    name,
    description: '服务器项目 agent 定义无效',
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    trustState: 'invalid',
    available: false,
    diagnostics: messages
  }
}

function parsedEntry(
  options: RemoteProjectAgentDiscoveryOptions,
  file: RemoteAgentFile,
  definition: PhiAgentDefinition
): { entry: RemoteProjectAgentEntry; definition?: PhiAgentDefinition } {
  const trustState = remoteAgentTrustState(
    {
      hostAlias: options.hostAlias,
      projectRoot: options.projectRoot,
      relativePath: file.relativePath,
      contentHash: file.contentHash
    },
    options.agentDir
  )
  const messages = [
    ...definition.warnings,
    trustState === 'trusted'
      ? ''
      : trustState === 'changed'
        ? '来自服务器项目，内容已变化，需要重新信任'
        : '来自服务器项目，未信任'
  ].filter(Boolean)
  return {
    entry: {
      id: `remote-project:${file.relativePath}:${file.contentHash}`,
      name: definition.name,
      description: definition.description,
      relativePath: file.relativePath,
      contentHash: file.contentHash,
      trustState,
      available: trustState === 'trusted',
      diagnostics: messages,
      ...(definition.invocation ? { invocation: definition.invocation } : {})
    },
    ...(trustState === 'trusted' ? { definition } : {})
  }
}

async function inspectFile(
  options: RemoteProjectAgentDiscoveryOptions,
  file: RemoteAgentFile,
  diagnostics: PhiAgentDiagnostic[]
): Promise<{ entry: RemoteProjectAgentEntry; definition?: PhiAgentDefinition }> {
  const filePath = posix.join(options.projectRoot, file.relativePath)
  const validation = validateAgentFile(filePath, file.content, file.source)
  const problems = [...validation.errors, ...validation.warnings]
  for (const problem of problems) {
    diagnostics.push({ filePath, level: problem.level, message: problem.message })
  }
  if (!validation.ok || !validation.agent) {
    return {
      entry: invalidEntry(
        file,
        validation.errors.map((problem) => problem.message)
      )
    }
  }
  return parsedEntry(options, file, validation.agent)
}

export async function discoverRemoteProjectAgents(
  options: RemoteProjectAgentDiscoveryOptions
): Promise<RemoteProjectAgentDiscoveryResult> {
  const diagnostics: PhiAgentDiagnostic[] = []
  const entries: RemoteProjectAgentEntry[] = []
  const agents: PhiAgentDefinition[] = []
  for (const root of ROOTS) {
    for (const entry of await rootEntries(options.host, root.directory, diagnostics)) {
      if (!markdownEntry(entry)) continue
      const relativePath = posix.join(root.directory, entry.name)
      try {
        const file = await readRemoteAgentFile(options, relativePath, root.source)
        const inspected = await inspectFile(options, file, diagnostics)
        entries.push(inspected.entry)
        if (inspected.definition) agents.push(inspected.definition)
      } catch (error) {
        const message = errorMessage(error)
        diagnostics.push(diagnostic(posix.join(options.projectRoot, relativePath), message))
      }
    }
  }
  return { agents, entries, diagnostics }
}
