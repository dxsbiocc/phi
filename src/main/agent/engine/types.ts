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
