import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { parseEnvironmentRef } from '../envs/contract'

/**
 * A Phi agent: a specialist the main agent can delegate to. Defined by a
 * Markdown file (frontmatter + system prompt) that Phi itself scans — see
 * discovery.ts. Agents are named like `Wrapper`: capitalised, no `Agent`
 * suffix. Tool *functions* (`wrapper_search`) stay snake_case, so the two are
 * never confused.
 *
 * Field rules are agent-definition contract v1 (`docs/contracts/agent.md`).
 */
export const AGENT_CONTRACT_VERSION = '1.0.0'

export type PhiAgentSource = 'phi' | 'compat'
export type PhiAgentDelegationMode = 'required-first' | 'preferred' | 'optional'
export type PhiAgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface PhiAgentFallback {
  /** Consecutive not-found/blocked/failed runs required before generic tools may take over. */
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
  /** Environment reference. Parsed here; binding is a later step. */
  environment?: string
  /** Model selectors (`provider/id`) tried in order. Absent: the parent's model. */
  model?: string[]
  /** Overrides the delegating session's thinking level. */
  thinkingLevel?: PhiAgentThinkingLevel
  /** Guidance for the delegating (main) agent: when and how to hand work over. */
  delegation?: string
  /** Whether this specialist must get the first attempt for matching work. */
  delegationMode?: PhiAgentDelegationMode
  /** Controlled generic-tool fallback after specialist failure. */
  fallback?: PhiAgentFallback
  /** v1 agents are delegation-tool entry points. `internal` is reserved. */
  visibility: 'entry'
  /** Scan-log messages (legacy aliases, unknown keys). Never fails the agent. */
  warnings: string[]
  systemPrompt: string
  source: PhiAgentSource
  filePath: string
}

export type AgentProblem = {
  level: 'error' | 'warning'
  path: string
  message: string
}

export interface AgentValidationResult {
  ok: boolean
  errors: AgentProblem[]
  warnings: AgentProblem[]
  agent?: PhiAgentDefinition
}

const NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/
const DEFAULT_COMPAT_TOOLS = ['read', 'glob', 'grep', 'bash', 'write', 'edit']
const THINKING_LEVELS = new Set<PhiAgentThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
])
const DELEGATION_MODES = new Set<PhiAgentDelegationMode>([
  'required-first',
  'preferred',
  'optional'
])
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'tools',
  'spawns',
  'model',
  'thinkingLevel',
  'skills',
  'environment',
  'visibility',
  'delegationMode',
  'delegation_mode',
  'delegation',
  'fallback',
  'outputSchema'
])
const FALLBACK_KEYS = new Set(['afterFailures', 'after_failures', 'tools', 'match'])

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

function isThinkingLevel(value: unknown): value is PhiAgentThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.has(value as PhiAgentThinkingLevel)
}

function isDelegationMode(value: unknown): value is PhiAgentDelegationMode {
  return typeof value === 'string' && DELEGATION_MODES.has(value as PhiAgentDelegationMode)
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | undefined {
  const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  return match ? { frontmatter: match[1], body: content.slice(match[0].length) } : undefined
}

function finish(
  errors: AgentProblem[],
  warnings: AgentProblem[],
  agent?: PhiAgentDefinition
): AgentValidationResult {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(agent && errors.length === 0 ? { agent } : {})
  }
}

function problem(level: AgentProblem['level'], path: string, message: string): AgentProblem {
  return { level, path, message }
}

/** A selector string, or a list of them in try-order. Invalid shapes are rejected. */
function modelSelectors(value: unknown): { ok: true; model?: string[] } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (typeof value === 'string') {
    const selector = value.trim()
    return selector ? { ok: true, model: [selector] } : { ok: false }
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return { ok: false }
  const model = value.map((item) => item.trim()).filter(Boolean)
  return model.length > 0 ? { ok: true, model } : { ok: false }
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

interface Collected {
  errors: AgentProblem[]
  warnings: AgentProblem[]
}

function fail(collected: Collected, path: string, message: string): void {
  collected.errors.push(problem('error', path, message))
}

function warn(collected: Collected, path: string, message: string): void {
  collected.warnings.push(problem('warning', path, message))
}

function readDelegationMode(
  fm: Record<string, unknown>,
  collected: Collected
): PhiAgentDelegationMode | undefined {
  const alias = fm.delegation_mode
  const canonical = fm.delegationMode
  if (alias !== undefined) {
    warn(collected, 'delegation_mode', "legacy alias 'delegation_mode'; use delegationMode")
  }
  if (canonical !== undefined && alias !== undefined && canonical !== alias) {
    fail(collected, 'delegationMode', 'delegationMode conflicts with delegation_mode')
  }
  const chosen = canonical !== undefined ? canonical : alias
  if (chosen === undefined) return undefined
  if (!isDelegationMode(chosen)) {
    fail(
      collected,
      'delegationMode',
      'delegationMode must be required-first, preferred, or optional'
    )
    return undefined
  }
  return chosen
}

function readFallback(value: unknown, collected: Collected): PhiAgentFallback | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    fail(collected, 'fallback', 'fallback must be a YAML object')
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!FALLBACK_KEYS.has(key)) warn(collected, `fallback.${key}`, `unknown key '${key}'`)
  }
  if (value.after_failures !== undefined) {
    warn(
      collected,
      'fallback.after_failures',
      "legacy alias 'fallback.after_failures'; use fallback.afterFailures"
    )
  }
  if (
    value.afterFailures !== undefined &&
    value.after_failures !== undefined &&
    value.afterFailures !== value.after_failures
  ) {
    fail(
      collected,
      'fallback.afterFailures',
      'fallback.afterFailures conflicts with fallback.after_failures'
    )
  }
  const raw = value.afterFailures !== undefined ? value.afterFailures : value.after_failures
  const afterFailures = readPositiveInteger(raw)
  if (afterFailures === undefined) {
    fail(collected, 'fallback.afterFailures', 'fallback.afterFailures must be a positive integer')
  }
  const tools = stringList(value.tools)
  const match = stringList(value.match)
  if (!tools?.length) {
    fail(collected, 'fallback.tools', 'fallback.tools must contain at least one tool name')
  }
  if (!match?.length) {
    fail(collected, 'fallback.match', 'fallback.match must contain at least one target token')
  }
  if (afterFailures === undefined || !tools?.length || !match?.length) return undefined
  return { afterFailures, tools, match }
}

function readEnvironment(value: unknown, collected: Collected): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    fail(
      collected,
      'environment',
      'environment must be phi:<name>@<major>, plugin:<name>, or project:<name>'
    )
    return undefined
  }
  const ref = value.trim()
  try {
    const parsed = parseEnvironmentRef(ref)
    if (parsed.kind === 'path') {
      fail(
        collected,
        'environment',
        'environment must be phi:<name>@<major>, plugin:<name>, or project:<name>'
      )
      return undefined
    }
  } catch (error) {
    fail(collected, 'environment', error instanceof Error ? error.message : String(error))
    return undefined
  }
  return ref
}

function readPhiAgent(
  filePath: string,
  fm: Record<string, unknown>,
  systemPrompt: string,
  collected: Collected
): PhiAgentDefinition | undefined {
  const fileName = basename(filePath, extname(filePath))
  const declared = typeof fm.name === 'string' ? fm.name.trim() : ''
  if (!declared) fail(collected, 'name', 'name is required.')
  else if (!isValidPhiAgentName(declared)) {
    fail(
      collected,
      'name',
      `name "${declared}" must be capitalised (e.g. Wrapper) and must not end with "Agent".`
    )
  } else if (declared !== fileName) {
    fail(collected, 'name', `name "${declared}" must match the file name "${fileName}.md".`)
  }

  let description = ''
  if (typeof fm.description !== 'string') fail(collected, 'description', 'description is required.')
  else {
    description = fm.description.trim()
    if (description.length < 1) fail(collected, 'description', 'description is required.')
    else if (description.length > 1024) {
      fail(collected, 'description', 'description must be 1-1024 characters')
    }
  }

  const tools = stringList(fm.tools)
  if (!tools?.length) fail(collected, 'tools', 'tools is required (a list of tool names).')

  if (!systemPrompt) {
    fail(collected, 'systemPrompt', 'The system prompt (the Markdown body) is empty.')
  }

  if ('spawns' in fm) fail(collected, 'spawns', 'spawns is reserved')
  if ('outputSchema' in fm) fail(collected, 'outputSchema', 'outputSchema is reserved')

  const parsedModel = modelSelectors(fm.model)
  if (!parsedModel.ok) {
    fail(collected, 'model', 'model must be a selector or a list of selectors')
  }

  let thinkingLevel: PhiAgentThinkingLevel | undefined
  if (fm.thinkingLevel !== undefined) {
    if (!isThinkingLevel(fm.thinkingLevel)) {
      fail(
        collected,
        'thinkingLevel',
        'thinkingLevel must be off, minimal, low, medium, high, or xhigh'
      )
    } else {
      thinkingLevel = fm.thinkingLevel
    }
  }

  let skills: string[] = []
  if (fm.skills !== undefined) {
    const parsed = stringList(fm.skills)
    if (!parsed) fail(collected, 'skills', 'skills must be a list of skill names')
    else skills = parsed
  }

  const environment = readEnvironment(fm.environment, collected)

  if (fm.visibility !== undefined && fm.visibility !== 'entry') {
    fail(
      collected,
      'visibility',
      fm.visibility === 'internal'
        ? "visibility 'internal' is reserved"
        : "visibility must be 'entry'"
    )
  }

  const delegationMode = readDelegationMode(fm, collected)

  let delegation: string | undefined
  if (fm.delegation !== undefined) {
    if (typeof fm.delegation !== 'string')
      fail(collected, 'delegation', 'delegation must be a string')
    else if (fm.delegation.trim()) delegation = fm.delegation.trim()
  }

  const fallback = readFallback(fm.fallback, collected)

  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) warn(collected, key, `unknown key '${key}'`)
  }

  if (
    collected.errors.length > 0 ||
    !declared ||
    !isValidPhiAgentName(declared) ||
    declared !== fileName
  ) {
    return undefined
  }
  if (!description || description.length > 1024 || !tools?.length || !systemPrompt) return undefined

  return {
    name: declared,
    description,
    tools,
    skills,
    ...(environment ? { environment } : {}),
    ...(parsedModel.ok && parsedModel.model ? { model: parsedModel.model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(delegation ? { delegation } : {}),
    ...(delegationMode ? { delegationMode } : {}),
    ...(fallback ? { fallback } : {}),
    visibility: 'entry',
    warnings: collected.warnings.map((item) => item.message),
    systemPrompt,
    source: 'phi',
    filePath
  }
}

function readCompatAgent(
  filePath: string,
  fm: Record<string, unknown>,
  systemPrompt: string,
  collected: Collected
): PhiAgentDefinition | undefined {
  const fileName = basename(filePath, extname(filePath))
  const declared = typeof fm.name === 'string' ? fm.name.trim() : ''
  const raw = declared || fileName
  const name = toPhiAgentName(raw)
  if (!isValidPhiAgentName(name)) {
    fail(collected, 'name', `Cannot derive a valid agent name from "${raw}".`)
  }

  const description = typeof fm.description === 'string' ? fm.description.trim() : ''
  if (!description) fail(collected, 'description', 'description is required.')
  if (!systemPrompt) {
    fail(collected, 'systemPrompt', 'The system prompt (the Markdown body) is empty.')
  }

  const declaredTools = stringList(fm.tools)
  const tools = declaredTools
    ? [
        ...new Set(
          declaredTools.map(normalizeToolName).filter((tool): tool is string => tool !== undefined)
        )
      ]
    : [...DEFAULT_COMPAT_TOOLS]

  if (collected.errors.length > 0 || !isValidPhiAgentName(name) || !description || !systemPrompt) {
    return undefined
  }

  const parsedModel = modelSelectors(fm.model)
  const thinkingLevel = isThinkingLevel(fm.thinkingLevel) ? fm.thinkingLevel : undefined
  return {
    name,
    description,
    tools,
    skills: [],
    ...(parsedModel.ok && parsedModel.model ? { model: parsedModel.model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    visibility: 'entry',
    warnings: [],
    systemPrompt,
    source: 'compat',
    filePath
  }
}

/**
 * Checks one agent file against contract v1. `compat` ignores every Phi field
 * (including reserved `spawns` / `outputSchema` / `environment`) and never
 * reports those as errors.
 */
export function validateAgentFile(
  filePath: string,
  content: string,
  source: PhiAgentSource
): AgentValidationResult {
  const collected: Collected = { errors: [], warnings: [] }
  const parts = splitFrontmatter(content)
  if (!parts) {
    fail(
      collected,
      'frontmatter',
      'Missing frontmatter: an agent file starts with a --- YAML block.'
    )
    return finish(collected.errors, collected.warnings)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(parts.frontmatter)
  } catch (error) {
    fail(
      collected,
      'frontmatter',
      `Invalid frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`
    )
    return finish(collected.errors, collected.warnings)
  }
  if (!isRecord(parsed)) {
    fail(collected, 'frontmatter', 'frontmatter must be a YAML mapping')
    return finish(collected.errors, collected.warnings)
  }

  const systemPrompt = parts.body.trim()
  const agent =
    source === 'compat'
      ? readCompatAgent(filePath, parsed, systemPrompt, collected)
      : readPhiAgent(filePath, parsed, systemPrompt, collected)
  return finish(collected.errors, collected.warnings, agent)
}

/** Reads `filePath` and validates it as a Phi agent (not compatibility mode). */
export function validateAgent(filePath: string): AgentValidationResult {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return finish([problem('error', filePath, `cannot read agent file: ${message}`)], [])
  }
  return validateAgentFile(filePath, content, 'phi')
}

export function parsePhiAgent(
  filePath: string,
  content: string,
  source: PhiAgentSource
): PhiAgentDefinition {
  const result = validateAgentFile(filePath, content, source)
  if (!result.ok || !result.agent) {
    const message =
      result.errors.map((item) => item.message).join('\n') || `Cannot parse agent file ${filePath}`
    throw new PhiAgentParseError(filePath, message)
  }
  return result.agent
}

/** Guards a definition that crossed the main-process → worker boundary. */
export function isPhiAgentDefinition(value: unknown): value is PhiAgentDefinition {
  if (!isRecord(value)) return false
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === 'string')
  return (
    typeof value.name === 'string' &&
    isValidPhiAgentName(value.name) &&
    typeof value.description === 'string' &&
    strings(value.tools) &&
    strings(value.skills) &&
    typeof value.systemPrompt === 'string' &&
    (value.source === 'phi' || value.source === 'compat') &&
    typeof value.filePath === 'string' &&
    value.visibility === 'entry' &&
    strings(value.warnings) &&
    (value.delegation === undefined || typeof value.delegation === 'string') &&
    (value.delegationMode === undefined || isDelegationMode(value.delegationMode)) &&
    (value.environment === undefined || typeof value.environment === 'string') &&
    (value.model === undefined || (strings(value.model) && value.model.length > 0)) &&
    (value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel)) &&
    (value.fallback === undefined ||
      (isRecord(value.fallback) &&
        readPositiveInteger(value.fallback.afterFailures) !== undefined &&
        strings(value.fallback.tools) &&
        strings(value.fallback.match)))
  )
}
