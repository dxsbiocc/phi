import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import semver from 'semver'

import { isEnabled, setEnabled } from '../enablement'
import type { PhiHostRequestContext } from '../engine/types'
import { setMcpPackageConfigEnabled } from '../mcp/package-config'
import { setPluginEnabled } from '../plugins/loader'
import { resetWrapperCompositionCatalogCache } from '../wrappers/composition/discovery'
import { prepareContentPackageInstall } from './content-source'
import { listInstalledPackages } from './installed'
import type {
  InstalledPackage,
  InstallerOptions,
  InstallPlan,
  LocalRegistry,
  PackageRequest,
  RegistryPackageEntry
} from './installer-types'
import { isRecord } from './installer-utils'
import { installPackages } from './lifecycle'
import type { PackageType } from './manifest'
import { runPackageMutation } from './mutation-queue'
import { planInstall } from './planning'
import type {
  CapabilityApprovalPackage,
  CapabilityApprovalRequest,
  CapabilityCandidate,
  CapabilityInstallResult,
  CapabilityPrepare,
  CapabilitySearchResult,
  CapabilityServiceDependencies,
  CapabilityService,
  RememberExternalCapabilitiesParams
} from './capability-service-types'
import { errorMessage } from '../../../shared/errorCodes'
export type {
  CapabilityApprovalPackage,
  CapabilityApprovalRequest,
  CapabilityCandidate,
  CapabilityInstallResult,
  CapabilityPrepare,
  CapabilitySearchResult,
  CapabilityServiceDependencies,
  CapabilityService,
  RememberExternalCapabilitiesParams
} from './capability-service-types'

const PACKAGE_TYPES = ['wrapper', 'skill', 'plugin', 'mcp'] as const
const MAX_CANDIDATES = 256
const CANDIDATE_LIFETIME_MS = 30 * 60_000
const silentLogger = { info: (): void => undefined, warn: (): void => undefined }

interface RememberedCandidate {
  sessionId: string
  createdAt: number
  registry: LocalRegistry
  entry: RegistryPackageEntry
  prepare?: CapabilityPrepare
}

/** The model can select only opaque candidates produced by a trusted registry search. */
export function createCapabilityService(deps: CapabilityServiceDependencies): CapabilityService {
  const remembered = new Map<string, RememberedCandidate>()
  const listInstalled =
    deps.listInstalled ?? (() => listInstalledPackages({ agentDir: deps.agentDir }))
  const planningOptions = { agentDir: deps.agentDir, appVersion: deps.appVersion }

  function remember(
    sessionId: string,
    registry: LocalRegistry,
    entry: RegistryPackageEntry,
    installed: InstalledPackage[],
    prepare?: CapabilityPrepare
  ): CapabilityCandidate {
    pruneCandidates()
    while (remembered.size >= MAX_CANDIDATES) remembered.delete(remembered.keys().next().value!)
    const candidateId = randomUUID()
    const snapshot = structuredClone(registry)
    const fixedEntry = snapshot.packages.find(
      (item) => item.type === entry.type && item.id === entry.id && item.version === entry.version
    )!
    remembered.set(candidateId, {
      sessionId,
      createdAt: Date.now(),
      registry: snapshot,
      entry: fixedEntry,
      ...(prepare ? { prepare } : {})
    })
    const current = installed.find((item) => item.type === entry.type && item.id === entry.id)
    return {
      candidateId,
      type: entry.type,
      id: entry.id,
      version: entry.version,
      title: entry.title,
      summary: entry.summary,
      source: sourceLabel(registry),
      trust: registry.trust,
      installed: current !== undefined,
      enabled: current !== undefined && packageEnabled(current, deps.agentDir),
      size: entry.size
    }
  }

  function pruneCandidates(): void {
    for (const [id, candidate] of remembered) {
      if (Date.now() - candidate.createdAt > CANDIDATE_LIFETIME_MS) remembered.delete(id)
    }
  }

  async function search(
    params: unknown,
    context: PhiHostRequestContext
  ): Promise<CapabilitySearchResult> {
    const input = searchInput(params)
    assertCurrent(context)
    let official: Awaited<ReturnType<NonNullable<typeof deps.searchOfficial>>> = {
      matches: [],
      available: false
    }
    if (deps.searchOfficial) {
      try {
        official = await deps.searchOfficial(input.query, input.type, context.signal)
      } catch (error) {
        assertCurrent(context)
        official.notice = `官网目录暂不可用：${errorMessage(error)}`
      }
    }
    assertCurrent(context)
    const loaded = await deps.loadRegistries(input.type)
    assertCurrent(context)
    const installed = listInstalled()
    const selected = selectEntries(loaded.registries, input, official.matches)
    const candidates = selected.map(({ registry, entry }) =>
      remember(input.runtimeSessionId, registry, entry, installed)
    )
    const errors = [...loaded.errors, ...(loaded.stateError ? [loaded.stateError] : [])]
    return {
      candidates,
      errors,
      officialAvailable: official.available,
      canFindExternal:
        candidates.length === 0 &&
        loaded.registries.some(isOfficialSource) &&
        !errors.some((error) => /Phi Packages|Phi 官网|official|官方/i.test(error)),
      ...(official.notice ? { notice: official.notice } : {})
    }
  }

  /** Trusted-host bridge for find_skills results; never register this method as a model tool. */
  function rememberExternalCandidates(
    params: RememberExternalCapabilitiesParams,
    context: PhiHostRequestContext
  ): CapabilitySearchResult {
    const input = searchInput({ ...params, type: 'skill' })
    assertCurrent(context)
    const installed = listInstalled()
    return {
      candidates: selectEntries(params.registries, input, [], true).map(({ registry, entry }) =>
        remember(input.runtimeSessionId, registry, entry, installed, params.prepare)
      ),
      errors: [],
      officialAvailable: true,
      canFindExternal: false
    }
  }

  async function install(
    params: unknown,
    context: PhiHostRequestContext
  ): Promise<CapabilityInstallResult> {
    const input = installInput(params)
    if (context.signal?.aborted) return cancelled()
    assertCurrent(context)
    pruneCandidates()
    const candidate = remembered.get(input.candidateId)
    if (!candidate || candidate.sessionId !== input.runtimeSessionId) {
      throw new Error('安装候选无效或已过期；请在当前会话重新搜索')
    }
    remembered.delete(input.candidateId)
    const request = {
      type: candidate.entry.type,
      id: candidate.entry.id,
      version: candidate.entry.version
    }
    const plan = planInstall(candidate.registry, request, planningOptions)
    const before = listInstalled()
    const fingerprint = planFingerprint(plan, before)
    const existingRoot = before.find(
      (item) =>
        item.type === request.type && item.id === request.id && item.version === request.version
    )
    const approval: CapabilityApprovalRequest = {
      runtimeSessionId: input.runtimeSessionId,
      candidateId: input.candidateId,
      root: plan.root,
      action: plan.packages.length === 0 ? 'enable' : 'install',
      reason: input.reason,
      source: existingRoot?.registry ?? sourceLabel(candidate.registry),
      trust: existingRoot?.trust ?? candidate.registry.trust,
      packages: approvalPackages(plan, candidate.entry, before),
      totalSize: plan.totalSize,
      environments: plan.environments
    }
    assertCurrent(context)
    const approved = await approvalDecision(deps.confirm(approval, context), context.signal)
    if (context.signal?.aborted) return cancelled()
    assertCurrent(context)
    if (approved !== true) {
      return {
        ok: false,
        installed: false,
        status: 'denied',
        message: '用户拒绝安装；请继续使用现有功能'
      }
    }
    return runPackageMutation(async () => {
      if (context.signal?.aborted) return cancelled()
      assertCurrent(context)
      const checkPlan = (registry: LocalRegistry): InstallPlan => {
        const current = planInstall(registry, request, planningOptions)
        if (planFingerprint(current, listInstalled()) !== fingerprint) {
          throw new Error('安装计划已在审批后发生变化；请重新搜索并请求批准')
        }
        return current
      }
      checkPlan(candidate.registry)
      const callerOptions = await deps.installerOptions?.(context)
      const options: InstallerOptions = {
        ...callerOptions,
        ...planningOptions,
        beforeCommit: () => {
          assertCurrent(context)
          callerOptions?.beforeCommit?.()
          assertCurrent(context)
        }
      }
      if (context.signal?.aborted) return cancelled()
      assertCurrent(context)
      let prepared = candidate.registry
      if (plan.packages.length > 0) {
        const prepare = candidate.prepare ?? deps.prepare ?? prepareApprovedContent
        try {
          prepared = await prepare(candidate.registry, request, options, context.signal)
        } catch (error) {
          if (context.signal?.aborted) return cancelled()
          throw error
        }
      }
      if (context.signal?.aborted) return cancelled()
      assertCurrent(context)
      const currentPlan = checkPlan(prepared)
      if (currentPlan.packages.length > 0) {
        try {
          await (deps.installPackages ?? installPackages)(currentPlan, options)
        } catch (error) {
          if (context.signal?.aborted) return cancelled()
          throw error
        }
      }
      if (context.signal?.aborted) return cancelled()
      assertCurrent(context)
      const installed = listInstalled()
      for (const item of installed) {
        const isRoot = item.type === request.type && item.id === request.id
        const isNew = !before.some(
          (previous) => previous.type === item.type && previous.id === item.id
        )
        if (isRoot || isNew) enablePackage(item, options)
      }
      if (installed.some((item) => item.type === 'wrapper')) resetWrapperCompositionCatalogCache()
      const packages = listInstalled()
      const result: Extract<CapabilityInstallResult, { ok: true }> = {
        ok: true,
        installed: true,
        root: currentPlan.root,
        packages,
        usage: packages
          .filter(
            (item) =>
              (item.type === request.type && item.id === request.id) ||
              currentPlan.packages.some((entry) => entry.type === item.type && entry.id === item.id)
          )
          .map((item) => ({
            type: item.type,
            id: item.id,
            path: item.type === 'skill' ? join(item.dir, 'SKILL.md') : item.dir
          }))
      }
      assertCurrent(context)
      await deps.afterInstall?.(result, context)
      return result
    })
  }

  function assertCurrent(context: PhiHostRequestContext): void {
    context.signal?.throwIfAborted()
    deps.assertCurrent?.(context)
  }

  return { search, install, rememberExternalCandidates }
}

async function prepareApprovedContent(
  registry: LocalRegistry,
  request: PackageRequest,
  options: InstallerOptions,
  signal?: AbortSignal
): Promise<LocalRegistry> {
  return prepareContentPackageInstall(registry, request, {
    agentDir: options.agentDir,
    appVersion: options.appVersion,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: signal
          ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
          : init?.signal
      })
  })
}

function searchInput(params: unknown): {
  runtimeSessionId: string
  query: string
  type?: PackageType
  limit: number
} {
  if (
    !isRecord(params) ||
    !validSession(params.runtimeSessionId) ||
    typeof params.query !== 'string' ||
    !params.query.trim() ||
    params.query.length > 500 ||
    (params.type !== undefined && !PACKAGE_TYPES.includes(params.type as PackageType)) ||
    (params.limit !== undefined &&
      (!Number.isInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 50))
  ) {
    throw new Error('功能搜索参数无效')
  }
  return {
    runtimeSessionId: params.runtimeSessionId,
    query: params.query.trim(),
    ...(params.type !== undefined ? { type: params.type as PackageType } : {}),
    limit: Number(params.limit ?? 12)
  }
}

function installInput(params: unknown): {
  runtimeSessionId: string
  candidateId: string
  reason: string
} {
  if (
    !isRecord(params) ||
    Object.keys(params).some(
      (key) =>
        !['runtimeSessionId', 'candidateId', 'reason', 'toolCallId', 'requestId'].includes(key)
    ) ||
    !validSession(params.runtimeSessionId) ||
    typeof params.candidateId !== 'string' ||
    typeof params.reason !== 'string' ||
    !params.reason.trim() ||
    params.reason.length > 2000
  ) {
    throw new Error('安装参数无效；只能使用搜索返回的候选标识并说明原因')
  }
  return {
    runtimeSessionId: params.runtimeSessionId,
    candidateId: params.candidateId,
    reason: params.reason.trim()
  }
}

function validSession(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function selectEntries(
  registries: LocalRegistry[],
  input: ReturnType<typeof searchInput>,
  officialMatches: readonly { type: PackageType; id: string }[],
  includeAll = false
): Array<{ registry: LocalRegistry; entry: RegistryPackageEntry }> {
  const preferred = new Map<string, { registry: LocalRegistry; entry: RegistryPackageEntry }>()
  for (const registry of registries)
    for (const entry of registry.packages) {
      if (input.type && input.type !== entry.type) continue
      const key = `${entry.type}:${entry.id}`
      const prior = preferred.get(key)
      if (
        !prior ||
        sourceRank(registry) < sourceRank(prior.registry) ||
        (sourceRank(registry) === sourceRank(prior.registry) &&
          semver.gt(entry.version, prior.entry.version))
      ) {
        preferred.set(key, { registry, entry })
      }
    }
  const tokens = input.query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const apiMatch = ({
    registry,
    entry
  }: {
    registry: LocalRegistry
    entry: RegistryPackageEntry
  }): boolean =>
    isOfficialSource(registry) &&
    officialMatches.some(
      (match) =>
        match.type === entry.type &&
        (match.id === entry.id || (entry.type === 'wrapper' && match.id.startsWith(`${entry.id}-`)))
    )
  return [...preferred.values()]
    .filter((candidate) => {
      const text = [
        candidate.entry.id,
        candidate.entry.title,
        candidate.entry.summary,
        candidate.entry.category ?? ''
      ]
        .join(' ')
        .toLocaleLowerCase()
      return (
        includeAll ||
        apiMatch(candidate) ||
        (tokens.length > 0 && tokens.every((token) => text.includes(token)))
      )
    })
    .sort(
      (left, right) =>
        sourceRank(left.registry) - sourceRank(right.registry) ||
        Number(apiMatch(right)) - Number(apiMatch(left)) ||
        left.entry.id.localeCompare(right.entry.id)
    )
    .slice(0, input.limit)
}

/** A source identity is host-owned; it does not assert a cryptographic trust tier. */
function isOfficialSource(registry: LocalRegistry): boolean {
  return (
    registry.trust === 'official' ||
    (registry.kind === 'official' && registry.id === 'phi-packages')
  )
}

function sourceRank(registry: LocalRegistry): number {
  return isOfficialSource(registry) ? 0 : registry.trust === 'builtin' ? 1 : 2
}

function sourceLabel(registry: LocalRegistry): string {
  return (
    registry.label ??
    (registry.trust === 'official' ? 'Phi Packages' : (registry.source?.repo ?? registry.id))
  )
}

function packageEnabled(item: InstalledPackage, agentDir: string): boolean {
  return (
    item.enabled !== false &&
    isEnabled(
      { key: `${item.type}:${item.id}`, source: 'installed-package' },
      { agentDir, logger: silentLogger }
    )
  )
}

function enablePackage(item: InstalledPackage, options: InstallerOptions): void {
  if (item.type === 'plugin') {
    const result = setPluginEnabled(item.id, true, options)
    if (!result.ok) throw new Error(result.errors.map((problem) => problem.message).join('; '))
  } else {
    setEnabled(`${item.type}:${item.id}`, true, {
      agentDir: options.agentDir,
      logger: silentLogger
    })
    if (item.type === 'mcp') setMcpPackageConfigEnabled(item.id, true, options.agentDir)
  }
}

function approvalPackages(
  plan: InstallPlan,
  root: RegistryPackageEntry,
  installed: InstalledPackage[]
): CapabilityApprovalPackage[] {
  const selected = new Map(plan.packages.map((entry) => [`${entry.type}:${entry.id}`, entry]))
  const result = new Map<string, CapabilityApprovalPackage>()
  function visit(entry: RegistryPackageEntry): void {
    const key = `${entry.type}:${entry.id}`
    if (result.has(key)) return
    const already = installed.find(
      (item) => item.type === entry.type && item.id === entry.id && item.version === entry.version
    )
    result.set(key, {
      type: entry.type,
      id: entry.id,
      version: entry.version,
      title: entry.title,
      source: already?.registry ?? sourceLabel(plan.registry),
      trust: already?.trust ?? plan.registry.trust,
      size: already ? 0 : entry.size,
      alreadyInstalled: Boolean(already)
    })
    for (const dependency of entry.dependsOn) {
      const planned = selected.get(`${dependency.type}:${dependency.id}`)
      const present = installed.find(
        (item) =>
          item.type === dependency.type &&
          item.id === dependency.id &&
          semver.satisfies(item.version, dependency.version)
      )
      const child =
        planned ??
        plan.registry.packages.find(
          (item) =>
            item.type === dependency.type &&
            item.id === dependency.id &&
            item.version === present?.version
        )
      if (child) visit(child)
      else if (present)
        result.set(`${present.type}:${present.id}`, {
          type: present.type,
          id: present.id,
          version: present.version,
          title: present.title,
          source: present.registry,
          trust: present.trust,
          size: 0,
          alreadyInstalled: true
        })
    }
  }
  visit(root)
  return [...result.values()]
}

function planFingerprint(plan: InstallPlan, installed: InstalledPackage[]): string {
  return createHash('sha256')
    .update(
      stableJson({
        root: plan.root,
        packages: plan.packages.map((entry) => ({ ...entry, sourceRegistry: undefined })),
        installed: installed
          .map((item) => ({
            type: item.type,
            id: item.id,
            version: item.version,
            sha256: item.sha256,
            enabled: item.enabled
          }))
          .sort((left, right) =>
            `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`)
          )
      })
    )
    .digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
}

function approvalDecision(decision: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return decision
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void decision.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function cancelled(): Extract<CapabilityInstallResult, { ok: false }> {
  return {
    ok: false,
    installed: false,
    status: 'cancelled',
    message: '安装已取消；请继续使用现有功能'
  }
}
