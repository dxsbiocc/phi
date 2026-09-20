import { basename, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * A Phi agent: a specialist the main agent can delegate to. Defined by a
 * Markdown file (frontmatter + system prompt) that Phi itself scans — see
 * discovery.ts. Agents are named like `Wrapper`: capitalised, no `Agent`
 * suffix. Tool *functions* (`wrapper_search`) stay snake_case, so the two are
 * never confused.
 */
export type PhiAgentSource = 'phi' | 'compat'
export type PhiAgentDelegationMode = 'required-first' | 'preferred' | 'optional'

export interface PhiAgentFallback {
  /** Number of consecutive failed/blocked runs required before generic tools may take over. */
  afterFailures: number
  /** Main-agent tools that may be used as the fallback route. */
  tools: string[]
  /** Case-insensitive tokens matched against the generic tool's serialized input. */
  match: string[]
}

export interface PhiAgentDefinition {
  /** Capitalised, e.g. `Wrapper`. Also the name of the delegation tool. */
  name: string
  description: string
  /** SDK built-in tool names and Phi tool functions. */
  tools: string[]
  /** Skill names the agent may use; empty means none. */
  skills: string[]
  /** Guidance for the delegating (main) agent: when and how to hand work over. */
  delegation?: string
  /** Whether this specialist must get the first attempt for matching work. */
  delegationMode?: PhiAgentDelegationMode
  /** Controlled generic-tool fallback after specialist failure. */
  fallback?: PhiAgentFallback
  systemPrompt: string
  source: PhiAgentSource
  filePath: string
}

const NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/
const DEFAULT_COMPAT_TOOLS = ['read', 'glob', 'grep', 'bash', 'write', 'edit']

// Foreign agent definitions name tools their own way; only these map onto Phi built-ins.
const TOOL_ALIASES: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  bash: 'bash',
  glob: 'glob',
  grep: 'grep',
  websearch: 'web_search',
  web_search: 'web_search',
  ast_grep: 'ast_grep',
  ast_edit: 'ast_edit',
  todo: 'todo',
  todowrite: 'todo'
}

export class PhiAgentParseError extends Error {
  constructor(
    readonly filePath: string,
    message: string
  ) {
    super(message)
    this.name = 'PhiAgentParseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidPhiAgentName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.endsWith('Agent')
}

/** `code-reviewer` -> `CodeReviewer`, `planner-agent` -> `Planner`. Returns '' when nothing usable is left. */
export function toPhiAgentName(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  while (words.length > 0 && words[words.length - 1].toLowerCase() === 'agent') words.pop()
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join('')
}

/** Maps a foreign tool name onto a Phi built-in, or undefined when Phi has no equivalent. */
export function normalizeToolName(raw: string): string | undefined {
  return TOOL_ALIASES[raw.trim().toLowerCase()]
}

function stringList(value: unknown): string[] | undefined {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : undefined
  if (!items) return undefined
  return [
    ...new Set(
      items
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

function delegationMode(value: unknown): PhiAgentDelegationMode | undefined {
  return value === 'required-first' || value === 'preferred' || value === 'optional'
    ? value
    : undefined
}

function fallbackPolicy(value: unknown, fail: (message: string) => never): PhiAgentFallback | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return fail('fallback must be a YAML object.')
  const afterFailures = value.after_failures
  if (!Number.isInteger(afterFailures) || (afterFailures as number) < 1) {
    return fail('fallback.after_failures must be a positive integer.')
  }
  const tools = stringList(value.tools)
  const match = stringList(value.match)
  if (!tools?.length) return fail('fallback.tools must contain at least one tool name.')
  if (!match?.length) return fail('fallback.match must contain at least one target token.')
  return { afterFailures: afterFailures as number, tools, match }
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | undefined {
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  return match ? { frontmatter: match[1], body: content.slice(match[0].length) } : undefined
}

export function parsePhiAgent(
  filePath: string,
  content: string,
  source: PhiAgentSource
): PhiAgentDefinition {
  const fail = (message: string): never => {
    throw new PhiAgentParseError(filePath, message)
  }

  const parts = splitFrontmatter(content)
  if (!parts) return fail('Missing frontmatter: an agent file starts with a --- YAML block.')

  let parsed: unknown
  try {
    parsed = parseYaml(parts.frontmatter)
  } catch (error) {
    return fail(
      `Invalid frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const fm = isRecord(parsed) ? parsed : {}
  const fileName = basename(filePath, extname(filePath))
  const declared = typeof fm.name === 'string' ? fm.name.trim() : ''

  let name: string
  if (source === 'phi') {
    if (!declared) return fail('name is required.')
    if (!isValidPhiAgentName(declared)) {
      return fail(
        `name "${declared}" must be capitalised (e.g. Wrapper) and must not end with "Agent".`
      )
    }
    if (declared !== fileName) {
      return fail(`name "${declared}" must match the file name "${fileName}.md".`)
    }
    name = declared
  } else {
    const raw = declared || fileName
    name = toPhiAgentName(raw)
    if (!isValidPhiAgentName(name)) return fail(`Cannot derive a valid agent name from "${raw}".`)
  }

  const description = typeof fm.description === 'string' ? fm.description.trim() : ''
  if (!description) return fail('description is required.')

  const declaredTools = stringList(fm.tools)
  let tools: string[]
  if (source === 'phi') {
    if (!declaredTools || declaredTools.length === 0)
      return fail('tools is required (a list of tool names).')
    tools = declaredTools
  } else if (declaredTools) {
    tools = [
      ...new Set(declaredTools.map(normalizeToolName).filter((tool): tool is string => !!tool))
    ]
  } else {
    tools = [...DEFAULT_COMPAT_TOOLS]
  }

  const systemPrompt = parts.body.trim()
  if (!systemPrompt) return fail('The system prompt (the Markdown body) is empty.')

  const delegation = typeof fm.delegation === 'string' ? fm.delegation.trim() : ''
  const mode = delegationMode(fm.delegation_mode)
  if (fm.delegation_mode !== undefined && !mode) {
    return fail('delegation_mode must be required-first, preferred, or optional.')
  }
  const fallback = fallbackPolicy(fm.fallback, fail)
  return {
    name,
    description,
    tools,
    skills: stringList(fm.skills) ?? [],
    ...(delegation ? { delegation } : {}),
    ...(mode ? { delegationMode: mode } : {}),
    ...(fallback ? { fallback } : {}),
    systemPrompt,
    source,
    filePath
  }
}

/** Guards a definition that crossed the main-process → worker boundary. */
export function isPhiAgentDefinition(value: unknown): value is PhiAgentDefinition {
  if (!isRecord(value)) return false
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((item) => typeof item === 'string')
  return (
    typeof value.name === 'string' &&
    isValidPhiAgentName(value.name) &&
    typeof value.description === 'string' &&
    strings(value.tools) &&
    strings(value.skills) &&
    typeof value.systemPrompt === 'string' &&
    (value.source === 'phi' || value.source === 'compat') &&
    typeof value.filePath === 'string' &&
    (value.delegation === undefined || typeof value.delegation === 'string') &&
    (value.delegationMode === undefined || delegationMode(value.delegationMode) !== undefined) &&
    (value.fallback === undefined ||
      (isRecord(value.fallback) &&
        Number.isInteger(value.fallback.afterFailures) &&
        (value.fallback.afterFailures as number) > 0 &&
        strings(value.fallback.tools) &&
        strings(value.fallback.match)))
  )
}
