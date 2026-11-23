import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Per-trial filesystem & state isolation plus hidden-reference canary verification (R03).
 *
 * Guarantees:
 * - Every trial receives its own isolated `cwd`, `agentDir`, `tmpDir`, `historyDir`, and
 *   `memoryDir` so state or memory written by trial A can never be read by trial B.
 * - Explicitly whitelisted read-only shared software/reference caches are checked to ensure
 *   they do not overlap with hidden reference roots or contain trial/answer artifacts.
 * - Boundary verification (`verifyIsolationBoundary`) tests path-traversal (`..`), absolute
 *   reference paths, and symlink escapes against a canary file; skipped checks are reported
 *   as `unverified`, never `verified`.
 */

export interface TrialSandbox {
  trialId: string
  rootDir: string
  cwd: string
  agentDir: string
  historyDir: string
  memoryDir: string
  tmpDir: string
  /** Explicitly declared read-only software/reference caches allowed for the trial. */
  sharedReadOnlyCaches: string[]
  /** Environment variables scoping Phi and temp directories strictly inside this trial. */
  env: Record<string, string>
  cleanup: () => void
}

export interface CreateTrialSandboxOptions {
  trialId?: string
  baseTempDir?: string
  sharedReadOnlyCaches?: readonly string[]
  hiddenReferenceRoot?: string
}

export interface CacheAuditResult {
  ok: boolean
  violations: string[]
}

export interface IsolationCanaryReport {
  status: 'verified' | 'failed' | 'unverified'
  canaryPath?: string
  checks: Array<{
    name: string
    status: 'blocked' | 'leaked' | 'skipped'
    detail: string
  }>
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Checks that no declared shared cache overlaps with the hidden reference root
 * or contains files named like reference answers / trial outputs.
 */
export function auditSharedCaches(
  caches: readonly string[],
  hiddenReferenceRoot?: string
): CacheAuditResult {
  const violations: string[] = []
  const resolvedHidden = hiddenReferenceRoot ? resolve(hiddenReferenceRoot) : undefined
  const realHidden =
    resolvedHidden && existsSync(resolvedHidden) ? realpathSync(resolvedHidden) : resolvedHidden

  for (const cache of caches) {
    const absCache = resolve(cache)
    const realCache = existsSync(absCache) ? realpathSync(absCache) : absCache
    if (realHidden && (isInside(realHidden, realCache) || isInside(realCache, realHidden))) {
      violations.push(`shared cache "${cache}" overlaps with hidden reference root`)
      continue
    }
    if (!existsSync(realCache)) continue
    try {
      for (const entry of readdirSync(realCache)) {
        if (/^(hidden[-_]?ref|ground[-_]?truth|answers?\.json|score\.json)$/i.test(entry)) {
          violations.push(`shared cache "${cache}" contains forbidden answer-like entry "${entry}"`)
        }
      }
    } catch {
      violations.push(`shared cache "${cache}" could not be inspected`)
    }
  }
  return { ok: violations.length === 0, violations }
}

/** Creates an isolated per-trial execution directory tree and scoped environment variables. */
export function createTrialSandbox(options: CreateTrialSandboxOptions = {}): TrialSandbox {
  const trialId = options.trialId ?? `trial_${randomUUID().slice(0, 12)}`
  const base = options.baseTempDir ?? tmpdir()
  const sharedReadOnlyCaches = [...(options.sharedReadOnlyCaches ?? [])]

  const cacheAudit = auditSharedCaches(sharedReadOnlyCaches, options.hiddenReferenceRoot)
  if (!cacheAudit.ok) {
    throw new Error(`Unsafe shared cache configuration: ${cacheAudit.violations.join('; ')}`)
  }

  const rootDir = resolve(base, `phi-eval-${trialId}-${randomUUID().slice(0, 8)}`)
  const cwd = join(rootDir, 'workspace')
  const agentDir = join(rootDir, 'agent-home')
  const historyDir = join(agentDir, 'history')
  const memoryDir = join(agentDir, 'memory')
  const tmpDir = join(rootDir, 'tmp')

  for (const dir of [cwd, agentDir, historyDir, memoryDir, tmpDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
    PHI_AGENT_DIR: agentDir,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir
  }

  return {
    trialId,
    rootDir,
    cwd,
    agentDir,
    historyDir,
    memoryDir,
    tmpDir,
    sharedReadOnlyCaches,
    env,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true })
    }
  }
}

/**
 * Pure path-boundary check matching Phi's workspace containment rules: rejects
 * `..` traversal, out-of-root absolute paths, and symlinks resolving outside `allowedRoot`.
 */
export function isPathContainedInTrial(allowedRoot: string, candidatePath: string): boolean {
  const realRoot = realpathSync(resolve(allowedRoot))
  const resolvedCandidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(realRoot, candidatePath)
  if (!isInside(realRoot, resolvedCandidate)) return false
  if (existsSync(resolvedCandidate)) {
    const stats = lstatSync(resolvedCandidate)
    if (stats.isSymbolicLink()) {
      const realTarget = realpathSync(resolvedCandidate)
      return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
    }
    const realTarget = realpathSync(resolvedCandidate)
    return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
  }
  return true
}

/**
 * Runs negative canary probes verifying that a trial's file-read gate blocks
 * access to a hidden reference file placed outside the trial workspace.
 */
export async function verifyIsolationBoundary(input: {
  sandbox: TrialSandbox
  hiddenReferenceDir: string
  /** Real file-access probe executed with the agent's own read boundary. Returns true if read succeeded (LEAK). */
  attemptRead: (targetPath: string) => Promise<boolean>
}): Promise<IsolationCanaryReport> {
  const hiddenDir = resolve(input.hiddenReferenceDir)
  mkdirSync(hiddenDir, { recursive: true, mode: 0o700 })
  const canaryToken = `PHI_CANARY_${randomUUID()}`
  const canaryPath = join(hiddenDir, `.canary-${randomUUID().slice(0, 8)}.txt`)
  writeFileSync(canaryPath, canaryToken, { encoding: 'utf-8', mode: 0o600 })

  const symlinkEscape = join(input.sandbox.cwd, '.canary-link.txt')
  const checks: IsolationCanaryReport['checks'] = []

  try {
    const probes: Array<{ name: string; target: string }> = [
      { name: 'absolute_hidden_path', target: canaryPath },
      { name: 'relative_traversal', target: relative(input.sandbox.cwd, canaryPath) }
    ]
    try {
      symlinkSync(canaryPath, symlinkEscape)
      probes.push({ name: 'symlink_escape', target: symlinkEscape })
    } catch {
      checks.push({
        name: 'symlink_escape',
        status: 'skipped',
        detail: 'symlink creation unavailable on host filesystem'
      })
    }

    for (const probe of probes) {
      const leaked = await input.attemptRead(probe.target)
      checks.push({
        name: probe.name,
        status: leaked ? 'leaked' : 'blocked',
        detail: leaked
          ? `SECURITY BREACH: trial read canary via ${probe.name}`
          : `blocked read attempt via ${probe.name}`
      })
    }
  } finally {
    rmSync(symlinkEscape, { force: true })
    rmSync(canaryPath, { force: true })
  }

  const anyLeaked = checks.some((c) => c.status === 'leaked')
  const anySkipped = checks.some((c) => c.status === 'skipped')
  return {
    status: anyLeaked ? 'failed' : anySkipped ? 'unverified' : 'verified',
    canaryPath,
    checks
  }
}
