import { posix } from 'node:path'

import type { WorkspaceHost } from './types'

export type MissingToolCandidateSource =
  | 'saved'
  | 'login-path'
  | 'conda-env'
  | 'micromamba-env'
  | 'phi-micromamba-env'
  | 'user-local-bin'
  | 'common-location'

export interface MissingToolCandidate {
  path: string
  source: MissingToolCandidateSource
}

export type MissingToolHostExecution = Pick<WorkspaceHost['exec'], 'run'>

export type MissingToolPathResolution =
  | { ok: true; path: string; kind: 'executable' | 'environment' }
  | {
      ok: false
      reason: 'path-must-be-absolute' | 'invalid-path' | 'not-executable' | 'host-check-failed'
    }

const SOURCE_PRIORITY: Readonly<Record<MissingToolCandidateSource, number>> = {
  saved: 0,
  'login-path': 1,
  'conda-env': 2,
  'micromamba-env': 3,
  'phi-micromamba-env': 4,
  'user-local-bin': 5,
  'common-location': 6
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const DEFAULT_PROBE_TIMEOUT_MS = 3_000
const ENV_LIST_TIMEOUT_MS = 10_000
const LOGIN_SHELL_LAUNCHER = [
  'phi_shell=${SHELL:-/bin/sh}',
  '[ -x "$phi_shell" ] || phi_shell=/bin/sh',
  'phi_script=$1',
  'shift',
  'exec "$phi_shell" -lc "$phi_script" "$0" "$@"'
].join('\n')
const VALIDATE_PATH_SCRIPT = [
  'phi_input=$1',
  'phi_tool=$2',
  'if [ -f "$phi_input" ] && [ -x "$phi_input" ]; then',
  "  printf '%s\\n' executable",
  'elif [ -d "$phi_input" ] && [ -f "$phi_input/bin/$phi_tool" ] && [ -x "$phi_input/bin/$phi_tool" ]; then',
  "  printf '%s\\n' environment",
  'else',
  '  exit 1',
  'fi'
].join('\n')
const LOGIN_PATH_SCRIPT = [
  'phi_path=$(command -v "$1" 2>/dev/null) || exit 1',
  'case "$phi_path" in /*) ;; *) exit 1 ;; esac',
  '[ -f "$phi_path" ] && [ -x "$phi_path" ] || exit 1',
  'printf \'%s\\n\' "$phi_path"'
].join('\n')
const ENV_LIST_SCRIPT = [
  'phi_manager=$1',
  'command -v "$phi_manager" >/dev/null 2>&1 || exit 1',
  '"$phi_manager" env list'
].join('\n')
// conda records every environment prefix here, so envs are found even when conda is only
// initialised for interactive shells and is missing from the login PATH.
const CONDA_REGISTRY_SCRIPT = [
  'phi_registry=$HOME/.conda/environments.txt',
  '[ -r "$phi_registry" ] || exit 1',
  'head -n "$1" "$phi_registry"'
].join('\n')
const FILTER_PATHS_SCRIPT = [
  'for phi_candidate do',
  '  if [ -f "$phi_candidate" ] && [ -x "$phi_candidate" ]; then',
  '    printf \'%s\\n\' "$phi_candidate"',
  '  fi',
  'done'
].join('\n')
const PHI_ENVIRONMENTS_SCRIPT = [
  'phi_root=$1',
  'phi_tool=$2',
  'phi_limit=$3',
  'phi_count=0',
  'for phi_candidate in "$phi_root"/envs/*/bin/"$phi_tool"; do',
  '  if [ -f "$phi_candidate" ] && [ -x "$phi_candidate" ]; then',
  '    printf \'%s\\n\' "$phi_candidate"',
  '    phi_count=$((phi_count + 1))',
  '    [ "$phi_count" -ge "$phi_limit" ] && break',
  '  fi',
  'done'
].join('\n')
const COMMON_PATHS_SCRIPT = [
  'phi_tool=$1',
  'phi_limit=$2',
  'phi_count=0',
  'phi_candidate=$HOME/.local/bin/$phi_tool',
  'if [ -f "$phi_candidate" ] && [ -x "$phi_candidate" ]; then',
  '  printf \'user-local-bin\\t%s\\n\' "$phi_candidate"',
  '  phi_count=$((phi_count + 1))',
  'fi',
  'for phi_candidate in /usr/local/bin/"$phi_tool" /opt/homebrew/bin/"$phi_tool" /opt/local/bin/"$phi_tool" /opt/*/bin/"$phi_tool"; do',
  '  [ "$phi_count" -ge "$phi_limit" ] && break',
  '  if [ -f "$phi_candidate" ] && [ -x "$phi_candidate" ]; then',
  '    printf \'common-location\\t%s\\n\' "$phi_candidate"',
  '    phi_count=$((phi_count + 1))',
  '  fi',
  'done'
].join('\n')

function assertToolName(tool: string): void {
  if (!TOOL_NAME_PATTERN.test(tool)) throw new Error('invalid tool name')
}

export function parseMissingToolEnvironmentList(
  output: string,
  tool: string,
  source: Extract<MissingToolCandidateSource, 'conda-env' | 'micromamba-env'>
): MissingToolCandidate[] {
  assertToolName(tool)
  const candidates: MissingToolCandidate[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/(?:^|\s)(\/.*)$/)
    const prefix = match?.[1].trim()
    if (!prefix || !posix.isAbsolute(prefix)) continue
    candidates.push({ path: posix.join(prefix, 'bin', tool), source })
  }
  return candidates
}

export function dedupeAndOrderMissingToolCandidates(
  candidates: readonly MissingToolCandidate[]
): MissingToolCandidate[] {
  const firstByPath = new Map<string, MissingToolCandidate & { index: number }>()
  for (const [index, candidate] of candidates.entries()) {
    if (!posix.isAbsolute(candidate.path)) continue
    const path = posix.normalize(candidate.path)
    const previous = firstByPath.get(path)
    const next = { ...candidate, path, index }
    if (!previous || SOURCE_PRIORITY[candidate.source] < SOURCE_PRIORITY[previous.source]) {
      firstByPath.set(path, next)
    }
  }
  return [...firstByPath.values()]
    .sort(
      (left, right) =>
        SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] || left.index - right.index
    )
    .map(({ path, source }) => ({ path, source }))
}

export async function resolveMissingToolPath(input: {
  enteredPath: string
  tool: string
  cwd: string
  execution: MissingToolHostExecution
  timeoutMs?: number
}): Promise<MissingToolPathResolution> {
  assertToolName(input.tool)
  const enteredPath = input.enteredPath.trim()
  if (!posix.isAbsolute(enteredPath)) return { ok: false, reason: 'path-must-be-absolute' }
  if (/\0|\r|\n/.test(enteredPath) || enteredPath.length > 4_096) {
    return { ok: false, reason: 'invalid-path' }
  }
  const probePath = enteredPath === '/' ? enteredPath : enteredPath.replace(/\/+$/, '')
  try {
    const result = await input.execution.run(
      ['sh', '-c', VALIDATE_PATH_SCRIPT, 'phi-validate-tool-path', probePath, input.tool],
      {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        maxOutputBytes: 256
      }
    )
    if (result.terminationReason) return { ok: false, reason: 'host-check-failed' }
    if (result.code !== 0) return { ok: false, reason: 'not-executable' }
    const kind = result.stdout.trim()
    if (kind === 'executable') return { ok: true, path: probePath, kind }
    if (kind === 'environment') {
      return { ok: true, path: posix.join(probePath, 'bin', input.tool), kind }
    }
    return { ok: false, reason: 'not-executable' }
  } catch {
    return { ok: false, reason: 'host-check-failed' }
  }
}

export interface MissingToolDiscoveryInput {
  tool: string
  cwd: string
  execution: MissingToolHostExecution
  savedPath?: string
  phiRuntimeRoots?: readonly string[]
  timeoutMs?: number
  maxCandidates?: number
}

function loginShellCommand(
  script: string,
  marker: string,
  ...args: string[]
): readonly [string, ...string[]] {
  return ['sh', '-c', LOGIN_SHELL_LAUNCHER, marker, script, ...args]
}

async function runDiscoverySource(input: {
  execution: MissingToolHostExecution
  command: readonly [string, ...string[]]
  cwd: string
  timeoutMs: number
}): Promise<string> {
  try {
    const result = await input.execution.run(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: 64 * 1024
    })
    return result.code === 0 && !result.terminationReason ? result.stdout : ''
  } catch {
    return ''
  }
}

function outputPaths(output: string, limit: number): string[] {
  const paths: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const path = line.trim()
    if (!posix.isAbsolute(path)) continue
    paths.push(path)
    if (paths.length >= limit) break
  }
  return paths
}

async function filterExecutableCandidates(input: {
  candidates: readonly MissingToolCandidate[]
  execution: MissingToolHostExecution
  cwd: string
  timeoutMs: number
}): Promise<MissingToolCandidate[]> {
  if (input.candidates.length === 0) return []
  const output = await runDiscoverySource({
    ...input,
    command: [
      'sh',
      '-c',
      FILTER_PATHS_SCRIPT,
      'phi-filter-tool-paths',
      ...input.candidates.map(({ path }) => path)
    ]
  })
  const executable = new Set(outputPaths(output, input.candidates.length))
  return input.candidates.filter(({ path }) => executable.has(path))
}

async function discoverEnvironmentList(input: {
  manager: 'conda' | 'micromamba'
  source: Extract<MissingToolCandidateSource, 'conda-env' | 'micromamba-env'>
  tool: string
  execution: MissingToolHostExecution
  cwd: string
  timeoutMs: number
  maxCandidates: number
}): Promise<MissingToolCandidate[]> {
  const output = await runDiscoverySource({
    ...input,
    // `conda env list` starts Python and can take several seconds on a busy server.
    timeoutMs: Math.max(input.timeoutMs, ENV_LIST_TIMEOUT_MS),
    command: loginShellCommand(
      ENV_LIST_SCRIPT,
      input.manager === 'conda' ? 'phi-conda-env-list' : 'phi-micromamba-env-list',
      input.manager
    )
  })
  const candidates = dedupeAndOrderMissingToolCandidates(
    parseMissingToolEnvironmentList(output, input.tool, input.source)
  ).slice(0, input.maxCandidates)
  return filterExecutableCandidates({ ...input, candidates })
}

function discoverPhiEnvironments(
  input: MissingToolDiscoveryInput,
  timeoutMs: number,
  maxCandidates: number
): Promise<MissingToolCandidate[]> {
  return Promise.all(
    [...new Set(input.phiRuntimeRoots ?? [])]
      .filter((root) => posix.isAbsolute(root))
      .map(async (root): Promise<MissingToolCandidate[]> => {
        const output = await runDiscoverySource({
          execution: input.execution,
          command: [
            'sh',
            '-c',
            PHI_ENVIRONMENTS_SCRIPT,
            'phi-phi-micromamba-envs',
            root,
            input.tool,
            String(maxCandidates)
          ],
          cwd: input.cwd,
          timeoutMs
        })
        return outputPaths(output, maxCandidates).map((path) => ({
          path,
          source: 'phi-micromamba-env' as const
        }))
      })
  ).then((groups) => groups.flat())
}

async function discoverCondaRegistry(input: {
  tool: string
  execution: MissingToolHostExecution
  cwd: string
  timeoutMs: number
  maxCandidates: number
}): Promise<MissingToolCandidate[]> {
  const output = await runDiscoverySource({
    ...input,
    command: [
      'sh',
      '-c',
      CONDA_REGISTRY_SCRIPT,
      'phi-conda-registry',
      String(input.maxCandidates * 4)
    ]
  })
  const candidates = outputPaths(output, input.maxCandidates * 4).map(
    (prefix): MissingToolCandidate => ({
      path: posix.join(prefix, 'bin', input.tool),
      source: 'conda-env'
    })
  )
  return filterExecutableCandidates({ ...input, candidates })
}

function parseCommonPathOutput(output: string, limit: number): MissingToolCandidate[] {
  const candidates: MissingToolCandidate[] = []
  for (const line of output.split(/\r?\n/)) {
    const [source, path] = line.split('\t', 2)
    if (
      (source !== 'user-local-bin' && source !== 'common-location') ||
      !path ||
      !posix.isAbsolute(path)
    ) {
      continue
    }
    candidates.push({ path, source })
    if (candidates.length >= limit) break
  }
  return candidates
}

function discoverSavedCandidate(
  input: MissingToolDiscoveryInput,
  timeoutMs: number
): Promise<MissingToolCandidate[]> {
  if (!input.savedPath) return Promise.resolve([])
  return resolveMissingToolPath({
    enteredPath: input.savedPath,
    tool: input.tool,
    cwd: input.cwd,
    execution: input.execution,
    timeoutMs
  }).then((result) => (result.ok ? [{ path: result.path, source: 'saved' as const }] : []))
}

function discoverLoginCandidate(
  input: MissingToolDiscoveryInput,
  timeoutMs: number
): Promise<MissingToolCandidate[]> {
  return runDiscoverySource({
    execution: input.execution,
    command: loginShellCommand(LOGIN_PATH_SCRIPT, 'phi-login-path', input.tool),
    cwd: input.cwd,
    timeoutMs
  }).then((output) =>
    outputPaths(output, 1).map((path): MissingToolCandidate => ({ path, source: 'login-path' }))
  )
}

export async function discoverMissingToolCandidates(
  input: MissingToolDiscoveryInput
): Promise<MissingToolCandidate[]> {
  assertToolName(input.tool)
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const maxCandidates = input.maxCandidates ?? 32
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid probe timeout')
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0 || maxCandidates > 128) {
    throw new Error('invalid candidate limit')
  }

  const saved = discoverSavedCandidate(input, timeoutMs)
  const login = discoverLoginCandidate(input, timeoutMs)
  const conda = discoverEnvironmentList({
    manager: 'conda',
    source: 'conda-env',
    tool: input.tool,
    execution: input.execution,
    cwd: input.cwd,
    timeoutMs,
    maxCandidates
  })
  const micromamba = discoverEnvironmentList({
    manager: 'micromamba',
    source: 'micromamba-env',
    tool: input.tool,
    execution: input.execution,
    cwd: input.cwd,
    timeoutMs,
    maxCandidates
  })
  const phiEnvironments = discoverPhiEnvironments(input, timeoutMs, maxCandidates)
  const common = runDiscoverySource({
    execution: input.execution,
    command: [
      'sh',
      '-c',
      COMMON_PATHS_SCRIPT,
      'phi-common-tool-paths',
      input.tool,
      String(maxCandidates)
    ],
    cwd: input.cwd,
    timeoutMs
  }).then((output) => parseCommonPathOutput(output, maxCandidates))

  const condaRegistry = discoverCondaRegistry({
    tool: input.tool,
    execution: input.execution,
    cwd: input.cwd,
    timeoutMs,
    maxCandidates
  })
  const groups = await Promise.all([
    saved,
    login,
    conda,
    condaRegistry,
    micromamba,
    phiEnvironments,
    common
  ])
  return dedupeAndOrderMissingToolCandidates(groups.flat()).slice(0, maxCandidates)
}
