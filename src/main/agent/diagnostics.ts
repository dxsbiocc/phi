import type { McpServerSummary, SkillSummary } from './resources'
import type { ModelSelection, PermissionMode, Project, ThinkingLevel } from './projects'
import { redactSensitiveText } from './redaction'

type ProviderSummary = {
  providerId: string
  name: string
  configured: boolean
  source?: string
  hasApiKey: boolean
  hasOAuth: boolean
  hasConfigError: boolean
  statusText?: string
}

type SessionSummary = {
  path: string
  phiSessionId?: string
  status?: string
  unreadKind?: string | null
  lastRunOutcome?: string
  currentRunId?: string
  cwd?: string
}

type PluginSummary = {
  id?: string
  name?: string
  source?: string
  installed?: boolean
  installedPath?: string
}

export interface DiagnosticsSnapshot {
  generatedAt: string
  app: {
    name: string
    version: string
  }
  platform: {
    os: NodeJS.Platform
    node: string
    electron?: string
  }
  currentSession: {
    path: string | null
    phiSessionId?: string
    cwd: string
    permissionMode: PermissionMode
    status?: string
    unreadKind?: string | null
    activeRunId?: string
  }
  model: {
    selected: ModelSelection | null
    thinkingLevel: ThinkingLevel
    availableCount: number
  }
  providers: ProviderSummary[]
  projects: Project[]
  sessions: SessionSummary[]
  skills: SkillSummary[]
  mcpServers: McpServerSummary[]
  plugins: PluginSummary[]
  activeRunCount: number
  logs: {
    directory: string
    retentionDays: number
  }
  recentErrors: string[]
}

function bool(value: boolean): string {
  return value ? 'yes' : 'no'
}

function optional(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  return redactSensitiveText(String(value))
}

function line(label: string, value: unknown): string {
  return `${label}: ${optional(value)}`
}

function names(values: Array<string | undefined>): string {
  const visible = values.filter((value): value is string => Boolean(value)).slice(0, 10)
  return visible.length > 0 ? visible.map(redactSensitiveText).join(', ') : '-'
}

export function formatDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const selectedModel = snapshot.model.selected
    ? `${snapshot.model.selected.providerId}/${snapshot.model.selected.modelId}`
    : '-'

  return [
    '# Phi Diagnostics',
    line('Generated', snapshot.generatedAt),
    line('App', `${snapshot.app.name} ${snapshot.app.version}`),
    line('Platform', snapshot.platform.os),
    line('Node', snapshot.platform.node),
    line('Electron', snapshot.platform.electron),
    '',
    '## Current Session',
    line('Phi session ID', snapshot.currentSession.phiSessionId),
    line('Runtime session path', snapshot.currentSession.path),
    line('CWD', snapshot.currentSession.cwd),
    line('Permission mode', snapshot.currentSession.permissionMode),
    line('Status', snapshot.currentSession.status),
    line('Unread kind', snapshot.currentSession.unreadKind),
    line('Active run ID', snapshot.currentSession.activeRunId),
    '',
    '## Model',
    line('Selected', selectedModel),
    line('Thinking level', snapshot.model.thinkingLevel),
    line('Available models', snapshot.model.availableCount),
    '',
    '## Providers',
    ...snapshot.providers.map((provider) =>
      [
        `- ${optional(provider.name)} (${optional(provider.providerId)})`,
        `configured=${bool(provider.configured)}`,
        `source=${optional(provider.source)}`,
        `apiKey=${bool(provider.hasApiKey)}`,
        `oauth=${bool(provider.hasOAuth)}`,
        `configError=${bool(provider.hasConfigError)}`,
        `status=${optional(provider.statusText)}`
      ].join(' ')
    ),
    snapshot.providers.length === 0 ? '- none' : '',
    '',
    '## Projects',
    ...snapshot.projects.map((project) =>
      [
        `- ${optional(project.name)}`,
        `id=${optional(project.id)}`,
        `path=${optional(project.workingDirectory)}`,
        `available=${bool(project.pathAvailable)}`,
        `permission=${project.permissionMode}`,
        `defaultModel=${optional(
          project.defaultModel
            ? `${project.defaultModel.providerId}/${project.defaultModel.modelId}`
            : undefined
        )}`,
        `defaultThinking=${optional(project.defaultThinkingLevel)}`
      ].join(' ')
    ),
    snapshot.projects.length === 0 ? '- none' : '',
    '',
    '## Sessions',
    ...snapshot.sessions
      .slice(0, 20)
      .map((session) =>
        [
          `- ${optional(session.phiSessionId ?? session.path)}`,
          `status=${optional(session.status)}`,
          `unread=${optional(session.unreadKind)}`,
          `lastRun=${optional(session.lastRunOutcome)}`,
          `activeRun=${optional(session.currentRunId)}`
        ].join(' ')
      ),
    snapshot.sessions.length > 20 ? `- ...${snapshot.sessions.length - 20} more` : '',
    snapshot.sessions.length === 0 ? '- none' : '',
    '',
    '## Resources',
    line('Skills', snapshot.skills.length),
    line('Disabled skills', snapshot.skills.filter((skill) => skill.disabled).length),
    line(
      'Disabled skill names',
      names(snapshot.skills.filter((skill) => skill.disabled).map((skill) => skill.name))
    ),
    line('MCP servers', snapshot.mcpServers.length),
    line('MCP server names', names(snapshot.mcpServers.map((server) => server.name))),
    line('Plugins', snapshot.plugins.length),
    line('Installed plugins', snapshot.plugins.filter((plugin) => plugin.installed).length),
    line(
      'Installed plugin names',
      names(
        snapshot.plugins
          .filter((plugin) => plugin.installed)
          .map((plugin) => plugin.name ?? plugin.id)
      )
    ),
    '',
    '## Runtime',
    line('Active runs', snapshot.activeRunCount),
    line('Log directory', snapshot.logs.directory),
    line('Log retention days', snapshot.logs.retentionDays),
    '',
    '## Recent Errors',
    ...(snapshot.recentErrors.length > 0
      ? snapshot.recentErrors.map((error) => `- ${redactSensitiveText(error)}`)
      : ['- none'])
  ]
    .filter((item, index, all) => item !== '' || all[index - 1] !== '')
    .join('\n')
    .trim()
}
