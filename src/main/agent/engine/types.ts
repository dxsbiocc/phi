export type PhiToolSite = 'host' | 'runtime'
export type PhiToolApproval = 'read' | 'write' | 'exec'
export type PhiToolLoadMode = 'essential' | 'discoverable'

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

export type PhiCredentialType = 'api_key' | 'oauth'

export interface PhiStoredCredential {
  id: string
  providerId: string
  type: PhiCredentialType
  /** OAuth: email, else accountId, else providerId. API key: providerId. */
  label: string
}

export type PhiCredentialOrigin =
  | 'stored'
  | 'runtime'
  | 'environment'
  | 'fallback'
  | 'models_json_key'
  | 'models_json_command'
  | undefined

export interface PhiCredentialStatus {
  /** hasAuth || hasConcreteAuth (the stored-credential part stays with the caller). */
  available: boolean
  origin: PhiCredentialOrigin
  label: string | undefined
}

export interface PhiLoginCallbacks {
  signal?: AbortSignal
  onAuth(info: { url: string; instructions?: string }): void
  onProgress(message: string): void
  onManualCodeInput(): Promise<string>
  onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>
}

export interface PhiMcpOAuthCredential {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
  enterpriseUrl?: string
  projectId?: string
  email?: string
  accountId?: string
  apiEndpoint?: string
  orgId?: string
  orgName?: string
  authorizedAt?: number
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
  resource?: string
  authorizationUrl?: string
}

export interface PhiAuth {
  listCredentials(authId?: string): PhiStoredCredential[]
  credentialStatus(providerId: string): PhiCredentialStatus
  hasOAuth(providerId: string): boolean
  isFromEnvironment(authId: string): boolean
  setApiKey(providerId: string, key: string): Promise<void>
  replaceApiKey(authId: string, key: string): Promise<void>
  clearApiKeys(authId: string): Promise<void>
  login(providerId: string, callbacks: PhiLoginCallbacks): Promise<void>
  logout(providerId: string): Promise<void>
  hasMcpOAuth(url: string): boolean
  hasMcpOAuthToken(url: string): boolean
  setMcpOAuth(url: string, credential: PhiMcpOAuthCredential): Promise<void>
}
