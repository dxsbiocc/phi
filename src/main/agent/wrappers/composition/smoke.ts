import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { WrapperCompositionEntry } from './discovery'
import { validateWrapperParams } from './validate'

/**
 * Static ("tier 0") smoke checks for a bundled wrapper: everything that can be
 * verified without Nextflow or the network. `scripts/smoke-wrappers.mjs` layers
 * URL probing, `nextflow -preview` and real runs on top of these.
 */

export interface SmokeIssue {
  level: 'error' | 'warn'
  check: string
  message: string
}

const TRIAD_FILES = ['wrapper.yaml', 'main.nf', 'params.json']
const INCLUDE_PATTERN = /include\s*\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/g
const REMOTE_URL = /^https?:\/\//i

const issue = (level: SmokeIssue['level'], check: string, message: string): SmokeIssue => ({
  level,
  check,
  message
})

/** Relative `include ... from '<path>'` targets of a Nextflow script; plugin includes are skipped. */
export function resolveIncludeTargets(scriptText: string): string[] {
  const targets: string[] = []
  for (const match of scriptText.matchAll(INCLUDE_PATTERN)) {
    if (match[2].startsWith('.')) targets.push(match[2])
  }
  return targets
}

function locateInclude(fromDir: string, target: string): string | undefined {
  const base = resolve(fromDir, target)
  return [base, `${base}.nf`, join(base, 'main.nf')].find((candidate) => existsSync(candidate))
}

function readDefaults(wrapperDir: string): { params?: Record<string, unknown>; error?: string } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(wrapperDir, 'params.json'), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'params.json must contain a JSON object' }
    }
    return { params: parsed as Record<string, unknown> }
  } catch (error) {
    return { error: `params.json is not valid JSON: ${String(error)}` }
  }
}

function checkIncludes(entry: WrapperCompositionEntry): SmokeIssue[] {
  const mainNf = join(entry.wrapperDir, 'main.nf')
  if (!existsSync(mainNf)) return []
  const issues: SmokeIssue[] = []
  for (const target of resolveIncludeTargets(readFileSync(mainNf, 'utf-8'))) {
    const found = locateInclude(entry.wrapperDir, target)
    if (!found) {
      issues.push(
        issue('error', 'include', `main.nf includes a file that does not exist: ${target}`)
      )
    } else if (existsSync(join(dirname(found), 'wrapper.yaml'))) {
      issues.push(
        issue(
          'error',
          'include',
          `main.nf includes another wrapper adapter (${target}); include the module/subworkflow itself`
        )
      )
    }
  }
  return issues
}

/** Checks that need only the files on disk. An empty array means the wrapper looks structurally sound. */
export function checkWrapperStatic(entry: WrapperCompositionEntry): SmokeIssue[] {
  const issues: SmokeIssue[] = []

  for (const file of TRIAD_FILES) {
    if (!existsSync(join(entry.wrapperDir, file))) {
      issues.push(issue('error', 'files', `wrapper/${file} is missing`))
    }
  }

  if (!Object.values(entry.manifest.outputs).some((output) => output.primary)) {
    issues.push(issue('error', 'outputs', 'no output is marked primary: true'))
  }

  if (existsSync(join(entry.wrapperDir, 'params.json'))) {
    const { params, error } = readDefaults(entry.wrapperDir)
    if (error) {
      issues.push(issue('error', 'params', error))
    } else if (params) {
      for (const problem of validateWrapperParams(entry.manifest, params, {}, entry.componentDir)) {
        issues.push(issue('error', 'params', problem))
      }
    }
  }

  issues.push(...checkIncludes(entry))

  if (!existsSync(join(entry.wrapperDir, 'dag.mmd'))) {
    issues.push(
      issue('warn', 'dag', 'wrapper/dag.mmd is missing; run scripts/generate-wrapper-dags.mjs')
    )
  }

  return issues
}

/** Unique http(s) URLs among a params object's string values (top level and inside arrays). */
export function collectRemoteUrls(params: Record<string, unknown>): string[] {
  const urls = new Set<string>()
  for (const value of Object.values(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && REMOTE_URL.test(item)) urls.add(item)
    }
  }
  return [...urls]
}

export interface ProbeResult {
  ok: boolean
  status?: number
  error?: string
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Extra attempts after the first, for transient failures only. Default 2. */
  retries?: number
  /** Base delay before a retry; grows linearly with the attempt number. Default 500. */
  retryDelayMs?: number
}

const isTransientStatus = (status: number): boolean => status === 429 || status >= 500

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve()

/** One attempt: HEAD, then (some hosts reject HEAD) a 1-byte ranged GET. Throws on a network failure. */
async function probeOnce(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  const head = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal })
  if (head.ok) return { ok: true, status: head.status }
  const get = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { Range: 'bytes=0-0' },
    signal
  })
  return { ok: get.ok, status: get.status }
}

/**
 * Checks that a URL is reachable. Network errors, 429 and 5xx are retried since
 * they are usually momentary (and one shared URL failing spuriously would flag
 * every wrapper that uses it); any other status, such as 404, is final.
 */
export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const retries = options.retries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 500

  let last: ProbeResult = { ok: false }
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * attempt)
    try {
      last = await probeOnce(url, fetchImpl, timeoutMs)
      if (last.ok || !isTransientStatus(last.status ?? 0)) return last
    } catch (error) {
      last = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return last
}
