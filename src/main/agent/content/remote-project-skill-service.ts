import { posix } from 'node:path'

import type { SkillContent, SkillSummary } from '../../../shared/skillTypes'
import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import type { RemoteWorkspaceReadResult } from '../remote-workspace-read'
import { SshHost } from '../workspace-host/ssh-host'
import type { WorkspaceHost } from '../workspace-host/types'
import {
  revokeRemoteProjectAgentTrust,
  trustRemoteProjectAgent
} from '../agents/remote-agent-trust-store'
import {
  discoverRemoteProjectSkills,
  type RemoteProjectSkillDiscoveryResult,
  type RemoteProjectSkillEntry,
  type RemoteProjectSkillSource
} from './remote-project-skill-discovery'

const MAX_RESOURCE_BYTES = 1024 * 1024
const MAX_RESOURCE_ENTRIES = 1000

export interface RemoteProjectSkillContext {
  sessionId: string
  projectId: string
  cwd: string
  agentDir: string
}

export interface RemoteProjectSkillTrustMutation {
  relativePath: string
  contentHash: string
}

export interface RemoteProjectSkillCatalog extends RemoteProjectSkillDiscoveryResult {
  summaries: SkillSummary[]
}

interface RemoteProjectSkillServiceDependencies {
  resolveBinding?: (input: { sessionId: string; projectId: string }) => RemoteWorkspaceHostBinding
  createHost?: (binding: RemoteWorkspaceHostBinding) => WorkspaceHost
}

function bindingFor(
  context: RemoteProjectSkillContext,
  dependencies: RemoteProjectSkillServiceDependencies
): RemoteWorkspaceHostBinding {
  return (
    dependencies.resolveBinding ??
    ((input) => resolveRemoteWorkspaceHostBinding(input, { agentDir: context.agentDir }))
  )(context)
}

function hostFor(
  binding: RemoteWorkspaceHostBinding,
  dependencies: RemoteProjectSkillServiceDependencies
): WorkspaceHost {
  return dependencies.createHost?.(binding) ?? new SshHost(binding.config)
}

function entryUri(binding: RemoteWorkspaceHostBinding, entry: RemoteProjectSkillEntry): string {
  return remoteWorkspaceUri(
    binding.hostAlias,
    posix.join(binding.canonicalRoot, entry.relativePath)
  )
}

function summary(
  binding: RemoteWorkspaceHostBinding,
  entry: RemoteProjectSkillEntry
): SkillSummary {
  const uri = entryUri(binding, entry)
  return {
    id: uri,
    name: entry.name,
    description: entry.description,
    filePath: uri,
    source: 'server-project',
    sourceId: 'server-project',
    scope: 'project',
    sourceCategory: 'project',
    sourceCategoryLabel: '服务器项目',
    enabled: entry.available,
    globalEnabled: false,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: !entry.available,
    trustState: entry.trustState,
    available: entry.available,
    diagnostics: [...entry.diagnostics],
    relativePath: entry.relativePath,
    contentHash: entry.contentHash
  }
}

async function scanWithBinding(
  context: RemoteProjectSkillContext,
  dependencies: RemoteProjectSkillServiceDependencies
): Promise<{
  binding: RemoteWorkspaceHostBinding
  scan: RemoteProjectSkillDiscoveryResult
}> {
  const binding = bindingFor(context, dependencies)
  const host = hostFor(binding, dependencies)
  try {
    const scan = await discoverRemoteProjectSkills({
      host,
      projectRoot: binding.canonicalRoot,
      hostAlias: binding.hostAlias,
      agentDir: context.agentDir
    })
    return { binding, scan }
  } finally {
    await host.close?.().catch(() => undefined)
  }
}

export async function loadRemoteProjectSkillCatalog(
  context: RemoteProjectSkillContext,
  dependencies: RemoteProjectSkillServiceDependencies = {}
): Promise<RemoteProjectSkillCatalog> {
  const { binding, scan } = await scanWithBinding(context, dependencies)
  return { ...scan, summaries: scan.entries.map((entry) => summary(binding, entry)) }
}

async function mutateTrust(
  context: RemoteProjectSkillContext,
  mutation: RemoteProjectSkillTrustMutation,
  trusted: boolean,
  dependencies: RemoteProjectSkillServiceDependencies
): Promise<void> {
  const { binding, scan } = await scanWithBinding(context, dependencies)
  const entry = scan.entries.find((candidate) => candidate.relativePath === mutation.relativePath)
  if (!entry || entry.contentHash !== mutation.contentHash || entry.trustState === 'invalid') {
    throw new Error('服务器项目 Skill 已变化或不可用，请刷新列表后重试')
  }
  const identity = {
    hostAlias: binding.hostAlias,
    projectRoot: binding.canonicalRoot,
    relativePath: entry.relativePath,
    contentHash: entry.contentHash
  }
  if (trusted) trustRemoteProjectAgent(identity, context.agentDir)
  else revokeRemoteProjectAgentTrust(identity, context.agentDir)
}

export function trustRemoteProjectSkill(
  context: RemoteProjectSkillContext,
  mutation: RemoteProjectSkillTrustMutation,
  dependencies: RemoteProjectSkillServiceDependencies = {}
): Promise<void> {
  return mutateTrust(context, mutation, true, dependencies)
}

export function revokeRemoteProjectSkillTrust(
  context: RemoteProjectSkillContext,
  mutation: RemoteProjectSkillTrustMutation,
  dependencies: RemoteProjectSkillServiceDependencies = {}
): Promise<void> {
  return mutateTrust(context, mutation, false, dependencies)
}

export async function readRemoteProjectSkillContent(
  context: RemoteProjectSkillContext,
  filePath: string,
  dependencies: RemoteProjectSkillServiceDependencies = {}
): Promise<SkillContent> {
  const { binding, scan } = await scanWithBinding(context, dependencies)
  const entry = scan.entries.find((candidate) => entryUri(binding, candidate) === filePath)
  if (!entry) throw new Error('服务器项目 Skill 已变化或不可用，请刷新列表后重试')
  return { filePath, content: entry.content }
}

function parsedSkillUri(uri: string): { name: string; relativePath?: string } {
  const match = /^skill:\/\/([^/?#]+)(\/[^?#]*)?$/u.exec(uri)
  if (!match) throw new Error('Invalid skill:// URL')
  let name: string
  let relativePath: string | undefined
  try {
    name = decodeURIComponent(match[1])
    relativePath = match[2]
      ? match[2]
          .slice(1)
          .split('/')
          .map((part) => decodeURIComponent(part))
          .join('/')
      : undefined
  } catch {
    throw new Error('Invalid skill:// URL')
  }
  if (
    !name ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    (relativePath !== undefined &&
      (!relativePath ||
        posix.isAbsolute(relativePath) ||
        relativePath.includes('\\') ||
        relativePath.includes('\0') ||
        relativePath.split('/').some((part) => !part || part === '.' || part === '..')))
  ) {
    throw new Error('Path traversal is not allowed in skill:// URLs')
  }
  return { name, ...(relativePath ? { relativePath } : {}) }
}

function resourceFile(
  uri: string,
  source: RemoteProjectSkillSource,
  relativePath: string
): RemoteWorkspaceReadResult {
  const file = source.files.find((candidate) => candidate.relativePath === relativePath)
  if (!file) throw new Error(`skill:// resource does not exist: ${uri}`)
  if (file.content.byteLength > MAX_RESOURCE_BYTES) {
    throw new Error('skill:// file exceeds the 1 MiB read limit')
  }
  if (file.content.includes(0)) throw new Error('skill:// resource is binary')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.content)
  } catch {
    throw new Error('skill:// resource is binary')
  }
  const extension = posix.extname(relativePath).toLowerCase()
  return {
    kind: 'file',
    path: uri,
    content,
    fileSize: file.content.byteLength,
    contentType:
      extension === '.md' || extension === '.mdx' || extension === '.markdown'
        ? 'text/markdown'
        : extension === '.json'
          ? 'application/json'
          : 'text/plain'
  }
}

function resourceDirectory(
  uri: string,
  source: RemoteProjectSkillSource,
  relativePath: string
): RemoteWorkspaceReadResult {
  const prefix = relativePath ? `${relativePath}/` : ''
  const children = new Map<string, boolean>()
  for (const file of source.files) {
    if (!file.relativePath.startsWith(prefix)) continue
    const suffix = file.relativePath.slice(prefix.length)
    if (!suffix) continue
    const separator = suffix.indexOf('/')
    const name = separator < 0 ? suffix : suffix.slice(0, separator)
    children.set(name, separator >= 0 || children.get(name) === true)
  }
  if (children.size === 0) throw new Error(`skill:// resource does not exist: ${uri}`)
  if (children.size > MAX_RESOURCE_ENTRIES)
    throw new Error('skill:// directory has too many entries')
  const entries = [...children]
    .map(([name, isDirectory]) => ({ name, isDirectory }))
    .sort(
      (left, right) =>
        Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name)
    )
  return {
    kind: 'directory',
    path: uri,
    content: entries.map((entry) => `${entry.name}${entry.isDirectory ? '/' : ''}`).join('\n'),
    entries
  }
}

function readSnapshotResource(
  uri: string,
  sources: readonly RemoteProjectSkillSource[]
): RemoteWorkspaceReadResult {
  const parsed = parsedSkillUri(uri)
  const source = sources.find((candidate) => candidate.name === parsed.name)
  if (!source) throw new Error(`Unknown skill: ${parsed.name}`)
  const relativePath = parsed.relativePath ?? 'SKILL.md'
  if (source.files.some((file) => file.relativePath === relativePath)) {
    return resourceFile(uri, source, relativePath)
  }
  return resourceDirectory(uri, source, parsed.relativePath ?? '')
}

export async function readRemoteProjectSkillResource(
  context: RemoteProjectSkillContext,
  uri: string,
  dependencies: RemoteProjectSkillServiceDependencies = {}
): Promise<RemoteWorkspaceReadResult> {
  const { scan } = await scanWithBinding(context, dependencies)
  return readSnapshotResource(uri, scan.sources)
}
