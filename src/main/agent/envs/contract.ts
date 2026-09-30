import { createHash } from 'node:crypto'

import Ajv, { type ErrorObject } from 'ajv'
import { parse as parseYaml } from 'yaml'

import { type PhiPlatform } from './platform'
import { environmentSpecSchema } from './schemas'

export { PHI_PLATFORMS, condaSubdir, currentPlatform, findPlatform } from './platform'
export type { PhiPlatform } from './platform'

export const ENVIRONMENT_CONTRACT_VERSION = '1.1.0'

const ENV_NAME = /^[a-z][a-z0-9-]{0,62}$/

export interface HostRequirement {
  name: string
  description?: string
  platforms?: PhiPlatform[]
  candidates?: string[]
}

export interface SourcePackage {
  language: 'r'
  name: string
  source: 'cran' | 'github'
  repo?: string
  ref: string
  sha256: string
}

export type CondaDependency = string | { pip: string[] }

export interface EnvironmentSpec {
  name: string
  channels: string[]
  dependencies: CondaDependency[]
  description?: string
  host?: HostRequirement[]
  sourcePackages?: SourcePackage[]
}

export interface CondaEnvironmentSpec {
  name: string
  channels: string[]
  dependencies: CondaDependency[]
}

export type EnvStatus = 'absent' | 'building' | 'ready' | 'failed' | 'drifted'
export type EnvKind = 'base' | 'package' | 'project'
/** `skill` (a standalone skill's own environment) was added in contract 1.1.0. */
export type EnvScope = 'phi' | 'plugin' | 'project' | 'skill'

export interface EnvMetadata {
  envId: string
  name: string
  kind: EnvKind
  platform: PhiPlatform
  lockSha256: string
  createdAt: string
  micromambaVersion: string
  activation: {
    set: Record<string, string>
    pathPrepend: string[]
  }
  host: Record<string, string>
  sourcePackages: SourcePackage[]
  status: EnvStatus
  contractVersion: string
}

export type EnvironmentSpecParseResult =
  { ok: true; spec: EnvironmentSpec } | { ok: false; errors: string[] }

export interface LockEntry {
  url: string
  md5: string
}

export type LockParseResult = { ok: true; entries: LockEntry[] } | { ok: false; errors: string[] }

export type EnvironmentRef =
  | { kind: 'phi'; name: string; major: number }
  | { kind: 'plugin'; name: string }
  | { kind: 'project'; name: string }
  | { kind: 'path'; path: string }

export const ENV_STATUS_TRANSITIONS: Record<EnvStatus, readonly EnvStatus[]> = {
  absent: ['building'],
  building: ['ready', 'failed'],
  ready: ['drifted', 'building'],
  drifted: ['building'],
  failed: ['building']
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validateEnvironmentSpec = ajv.compile(environmentSpecSchema)

function formatAjvError(error: ErrorObject): string {
  const path = error.instancePath || '(root)'
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'additionalProperties') {
    return `${path} has unknown property '${String(params.additionalProperty)}'`
  }
  if (error.keyword === 'required') {
    return `${path} is missing '${String(params.missingProperty)}'`
  }
  if (error.keyword === 'not') {
    return `${path} must not include repo when source is cran`
  }
  if (error.keyword === 'pattern') {
    return `${path} does not match ${String(params.pattern)}`
  }
  return `${path} ${error.message ?? 'is invalid'}`.trim()
}

export function parseEnvironmentSpec(yamlText: string): EnvironmentSpecParseResult {
  let document: unknown
  try {
    document = parseYaml(yamlText)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, errors: [`YAML parse error: ${message}`] }
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, errors: ['environment spec must be a YAML mapping'] }
  }
  if (validateEnvironmentSpec(document)) {
    return { ok: true, spec: document as unknown as EnvironmentSpec }
  }
  const errors = (validateEnvironmentSpec.errors ?? []).map(formatAjvError)
  return { ok: false, errors: errors.length > 0 ? errors : ['environment spec is invalid'] }
}

export function condaSpecOf(spec: EnvironmentSpec): CondaEnvironmentSpec {
  return {
    name: spec.name,
    channels: [...spec.channels],
    dependencies: spec.dependencies.map((dependency) =>
      typeof dependency === 'string' ? dependency : { pip: [...dependency.pip] }
    )
  }
}

const LOCK_URL = /^https:\/\/\S+#([0-9a-f]{32})$/

function lockLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

export function parseExplicitLock(text: string): LockParseResult {
  const errors: string[] = []
  const entries: LockEntry[] = []
  let seenHeader = false

  for (const [index, raw] of lockLines(text).entries()) {
    const line = raw.trimEnd()
    if (line.trim() === '' || line.startsWith('#')) continue
    const lineNo = index + 1
    if (!seenHeader) {
      if (line.trim() !== '@EXPLICIT') {
        return {
          ok: false,
          errors: [`line ${lineNo}: explicit lock must start with @EXPLICIT`]
        }
      }
      seenHeader = true
      continue
    }
    const match = LOCK_URL.exec(line.trim())
    if (!match) {
      const trimmed = line.trim()
      errors.push(
        trimmed.startsWith('https://')
          ? `line ${lineNo}: package URL must end with a 32-character lowercase md5`
          : `line ${lineNo}: package URL must use https`
      )
      continue
    }
    entries.push({ url: line.trim(), md5: match[1] })
  }

  if (!seenHeader) {
    errors.push('explicit lock must start with @EXPLICIT')
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, entries }
}

/** Comment and blank lines removed, whitespace trimmed, line endings normalised to `\n`. */
export function normalizeLockText(text: string): string {
  return lockLines(text)
    .map((raw) => raw.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n')
}

export function lockSha256(text: string): string {
  return createHash('sha256').update(normalizeLockText(text), 'utf8').digest('hex')
}

const DOWNLOAD_BYTES = /^# download-bytes: ([0-9]+)$/

/** Bytes recorded by `scripts/runtime/lock-env.ts`, or `undefined` when the header is absent. */
export function parseLockDownloadBytes(lockText: string): number | undefined {
  for (const raw of lockLines(lockText)) {
    const match = DOWNLOAD_BYTES.exec(raw.trim())
    if (!match) continue
    const bytes = Number(match[1])
    if (!Number.isSafeInteger(bytes)) return undefined
    return bytes
  }
  return undefined
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function canonicalSourcePackage(pkg: SourcePackage): Record<string, string> {
  const canonical: Record<string, string> = {
    language: pkg.language,
    name: pkg.name,
    ref: pkg.ref,
    sha256: pkg.sha256,
    source: pkg.source
  }
  if (pkg.repo !== undefined) canonical.repo = pkg.repo
  return canonical
}

export interface EnvIdInput {
  scope: EnvScope
  owner?: string
  name: string
  platform: PhiPlatform
  lockText: string
  sourcePackages?: SourcePackage[]
}

export function computeEnvId(input: EnvIdInput): string {
  if (input.scope !== 'phi' && !input.owner) {
    throw new Error(`computeEnvId requires owner when scope is '${input.scope}'`)
  }
  if (!ENV_NAME.test(input.name)) {
    throw new Error(`computeEnvId: invalid environment name '${input.name}'`)
  }
  if (input.scope !== 'phi' && !ENV_NAME.test(input.owner ?? '')) {
    throw new Error(`computeEnvId: invalid owner '${input.owner}'`)
  }
  const canonical = canonicalJson({
    platform: input.platform,
    lockSha256: lockSha256(input.lockText),
    sourcePackages: (input.sourcePackages ?? []).map(canonicalSourcePackage)
  })
  const hash12 = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)
  if (input.scope === 'phi') return `phi-${input.name}-${hash12}`
  return `${input.scope}-${input.owner}-${input.name}-${hash12}`
}

export function parseEnvironmentRef(ref: string): EnvironmentRef {
  const phi = new RegExp(`^phi:(${ENV_NAME.source.slice(1, -1)})@(0|[1-9][0-9]*)$`).exec(ref)
  if (phi) {
    return { kind: 'phi', name: phi[1], major: Number(phi[2]) }
  }
  if (ref.startsWith('phi:')) {
    throw new Error(
      `invalid environment reference '${ref}': phi references must be phi:<name>@<major>`
    )
  }
  const named = new RegExp(`^(plugin|project):(${ENV_NAME.source.slice(1, -1)})$`).exec(ref)
  if (named) {
    const scope = named[1]
    if (scope === 'plugin') return { kind: 'plugin', name: named[2] }
    return { kind: 'project', name: named[2] }
  }
  if (ref.startsWith('./')) {
    const segments = ref.slice(2).split('/')
    if (
      segments.length === 0 ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`invalid environment reference '${ref}': relative path must stay under ./`)
    }
    return { kind: 'path', path: ref }
  }
  throw new Error(
    `unsupported environment reference '${ref}': expected phi:<name>@<major>, plugin:<name>, project:<name>, or ./…`
  )
}

export function canTransition(from: EnvStatus, to: EnvStatus): boolean {
  return ENV_STATUS_TRANSITIONS[from].includes(to)
}
