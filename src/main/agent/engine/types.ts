export type PhiToolSite = 'host' | 'runtime'
export type PhiToolApproval = 'read' | 'write' | 'exec'
export type PhiToolLoadMode = 'essential' | 'discoverable'

export type PhiCompactionMethod = 'remote' | 'snapcompact' | 'handoff' | 'soft' | 'shake'

export interface PhiCompactionSettings {
  enabled: boolean
  thresholdPercent: number
  thresholdTokens: number
  methodOrder: PhiCompactionMethod[]
}

export type PhiWebSearchProvider =
  | 'perplexity'
  | 'gemini'
  | 'anthropic'
  | 'codex'
  | 'xai'
  | 'zai'
  | 'exa'
  | 'tinyfish'
  | 'jina'
  | 'kagi'
  | 'tavily'
  | 'firecrawl'
  | 'brave'
  | 'kimi'
  | 'parallel'
  | 'synthetic'
  | 'searxng'
  | 'startpage'
  | 'duckduckgo'
  | 'ecosia'
  | 'google'
  | 'mojeek'
  | 'public'

export interface PhiWebSearchSettings {
  order: PhiWebSearchProvider[]
  excluded: PhiWebSearchProvider[]
  endpoint: string | undefined
  engines: string | undefined
}

export interface PhiSearxngCredentials {
  endpoint: string | undefined
  token: string | undefined
  basicUsername: string | undefined
  basicPassword: string | undefined
}

export type PhiExtensionsSourceLevel = 'user' | 'project'

export interface PhiSettings {
  compaction: {
    read(): PhiCompactionSettings
    override(values: PhiCompactionSettings): void
  }
  webSearch: {
    read(): PhiWebSearchSettings
    write(values: PhiWebSearchSettings): void
    readSearxngCredentials(): PhiSearxngCredentials
  }
  mcp: {
    read(): { enableProjectConfig: boolean; notifications: boolean }
  }
  extensions: {
    read(): { configured: string[]; sourceLevel: PhiExtensionsSourceLevel }
  }
  memory: {
    useLocalBackend(): void
  }
  flush(): Promise<void>
}

export type PhiToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PhiToolResult<TDetails = unknown> {
  content: PhiToolContent[]
  details?: TDetails
  isError?: boolean
}

export type PhiToolImage = { type: 'image'; data: string; mimeType: string }

export interface PhiToolContext {
  /** Working directory of the calling session. */
  readonly cwd: string
  /**
   * Images the user attached most recently in this session, read at call time.
   * Same rules as the current `latestUserImages` in `agents/tool.ts`: look back at
   * most 3 user messages, newest first; return the images of the first one that has
   * any, at most 5; only png, jpeg, gif and webp with non-empty data.
   */
  recentUserImages(): PhiToolImage[]
}

export type PhiToolUpdate<TDetails = unknown> = (partial: PhiToolResult<TDetails>) => void

export interface PhiTool<TParams = Record<string, unknown>, TDetails = unknown> {
  name: string
  label: string
  description: string
  /** JSON Schema object for the tool input. */
  parameters: Record<string, unknown>
  /** Where execute() does its work (plan M4). */
  site: PhiToolSite
  strict?: boolean
  hidden?: boolean
  loadMode?: PhiToolLoadMode
  approval?: PhiToolApproval
  /** OMP-recognized metadata, preserved even where its current SDK bridge omits it. */
  lenientArgValidation?: boolean
  execute(
    toolCallId: string,
    params: TParams,
    onUpdate: PhiToolUpdate<TDetails> | undefined,
    ctx: PhiToolContext,
    signal?: AbortSignal
  ): Promise<PhiToolResult<TDetails>>
}
