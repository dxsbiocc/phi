import { createHash } from 'node:crypto'
import type { RemoteRuntimePromptContext } from './phi-main-system-prompt'
import type { PhiWorkMode } from '../host'

export const RPC_PROMPT_POLICY_FILE = 'prompt-policy.json'
export const RPC_PROMPT_POLICY_MAX_BYTES = 512 * 1024
const structuredPlanningTools = new Set([
  'read',
  'glob',
  'grep',
  'find',
  'ls',
  'todo',
  'ask_user_question',
  'capability_search',
  'find_skills',
  'propose_plan_steps'
])
const manualPlanningTools = new Set(
  [...structuredPlanningTools].filter((name) => name !== 'propose_plan_steps')
)
export const RPC_MARKDOWN_PLAN_PROPOSAL_TOOL = 'propose_plan_markdown'

export function rpcManualPlanDraftRead(mode: PhiWorkMode | undefined, input: unknown): boolean {
  return (
    mode === 'plan' &&
    !!input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    (input as { path?: unknown }).path === 'local://PLAN.md'
  )
}

function exactPlanDraftMutation(toolName: string, input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  if (record.path !== 'local://PLAN.md') return false
  const allowed =
    toolName === 'write'
      ? new Set(['path', 'content'])
      : new Set(['path', 'old_string', 'new_string', 'replace_all'])
  return Object.keys(record).every((key) => allowed.has(key))
}

/** Remote structured planning never admits workspace or draft writes. */
export function rpcPlanningToolDecision(
  mode: 'plan' | 'plan_execute',
  toolName: string,
  input: unknown,
  authenticatedMarkdownProposal = false
): { allowed: boolean; reason?: string } {
  if (mode === 'plan') {
    if (manualPlanningTools.has(toolName)) return { allowed: true }
    if (toolName === RPC_MARKDOWN_PLAN_PROPOSAL_TOOL && authenticatedMarkdownProposal)
      return { allowed: true }
    if ((toolName === 'write' || toolName === 'edit') && exactPlanDraftMutation(toolName, input))
      return { allowed: true }
    return {
      allowed: false,
      reason: 'Plan review permits read-only investigation and the session PLAN.md draft only.'
    }
  }
  return structuredPlanningTools.has(toolName)
    ? { allowed: true }
    : { allowed: false, reason: 'Structured plan review permits read-only investigation only.' }
}
export interface FacadePromptContext {
  readonly personaMarkdown?: string
  readonly personaPath?: string
  readonly contextFiles: readonly { readonly path: string; readonly content: string }[]
  readonly runtime?: RemoteRuntimePromptContext
  readonly recoverySummary?: string
}
export interface RpcPromptPolicy extends FacadePromptContext {
  readonly schema: 1
  readonly nonce: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly projectRoot: string
  readonly contextRoot: string
  readonly hostAlias: string
  readonly generation: number
  /** Main-owned session mode, retained across RPC generation recovery. */
  readonly workMode?: PhiWorkMode
  readonly memoryBlock?: string
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max

/** Main-owned immutable publication. No file, URL, resource or tool is discovered from this DTO. */
export function rpcPromptPolicy(value: unknown): Readonly<RpcPromptPolicy> {
  if (
    !record(value) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        ![
          'schema',
          'nonce',
          'phiSessionId',
          'projectId',
          'projectRoot',
          'contextRoot',
          'hostAlias',
          'generation',
          'workMode',
          'personaMarkdown',
          'personaPath',
          'contextFiles',
          'runtime',
          'memoryBlock',
          'recoverySummary'
        ].includes(key)
    ) ||
    value.schema !== 1 ||
    ![value.nonce, value.phiSessionId, value.projectId, value.hostAlias].every(
      (item) => text(item, 256) && !!item && !/[\r\n]/.test(item)
    ) ||
    !text(value.projectRoot, 4096) ||
    !value.projectRoot.startsWith('/') ||
    !text(value.contextRoot, 4096) ||
    !value.contextRoot.startsWith('/') ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    (value.workMode !== undefined &&
      (typeof value.workMode !== 'string' ||
        !['auto', 'direct', 'plan', 'plan_execute'].includes(value.workMode))) ||
    (value.personaMarkdown !== undefined && !text(value.personaMarkdown, 64 * 1024)) ||
    (value.personaPath !== undefined &&
      (!text(value.personaPath, 4096) || !value.personaPath.startsWith('/'))) ||
    (value.memoryBlock !== undefined && !text(value.memoryBlock, 64 * 1024)) ||
    (value.recoverySummary !== undefined && !text(value.recoverySummary, 16 * 1024)) ||
    !Array.isArray(value.contextFiles) ||
    value.contextFiles.length > 3
  )
    throw new Error('Invalid trusted Phi prompt policy')
  const paths = new Set<string>()
  for (const file of value.contextFiles) {
    if (
      !record(file) ||
      Object.keys(file).sort().join(',') !== 'content,path' ||
      !text(file.path, 4096) ||
      !text(file.content, 64 * 1024) ||
      paths.has(file.path)
    )
      throw new Error('Invalid remote prompt context')
    const url = new URL(file.path)
    const root = value.contextRoot === '/' ? '/' : value.contextRoot.replace(/\/$/, '') + '/'
    if (
      url.protocol !== 'ssh:' ||
      url.host !== value.hostAlias ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !decodeURIComponent(url.pathname).startsWith(root)
    )
      throw new Error('Remote prompt context escaped its original host or project')
    paths.add(file.path)
  }
  if (value.runtime !== undefined) {
    const runtime = value.runtime
    if (
      !record(runtime) ||
      Object.keys(runtime).some(
        (key) =>
          ![
            'rootLabel',
            'source',
            'micromambaStatus',
            'ripgrepStatus',
            'micromambaPathLabel'
          ].includes(key)
      ) ||
      !text(runtime.rootLabel, 4096) ||
      !['default', 'host', 'project'].includes(String(runtime.source)) ||
      !['installed', 'not-installed', 'outdated', 'unusable', 'unchecked'].includes(
        String(runtime.micromambaStatus)
      ) ||
      !['system', 'managed', 'not-installed'].includes(String(runtime.ripgrepStatus)) ||
      (runtime.micromambaPathLabel !== undefined && !text(runtime.micromambaPathLabel, 4096))
    )
      throw new Error('Invalid trusted remote runtime prompt')
  }
  if (Buffer.byteLength(JSON.stringify(value)) > RPC_PROMPT_POLICY_MAX_BYTES)
    throw new Error('Phi prompt policy exceeded its bound')
  return Object.freeze({
    ...value,
    contextFiles: Object.freeze(value.contextFiles.map((file) => Object.freeze({ ...file }))),
    ...(value.runtime ? { runtime: Object.freeze({ ...value.runtime }) } : {})
  }) as unknown as Readonly<RpcPromptPolicy>
}
export function rpcPromptPolicyHash(policy: Readonly<RpcPromptPolicy>): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}
