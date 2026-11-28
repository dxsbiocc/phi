import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import semver from 'semver'

import { parseSkillFile } from '../content/skill'
import { setEnabled } from '../enablement'
import type { PhiHostRequestContext } from '../engine/types'
import { createDeterministicTarGz } from './archive'
import type { CapabilityCandidate, CapabilityInstallResult } from './capability-service'
import {
  fetchGithubSnapshot,
  parseGithubRepoUrl,
  readBoundedResponse,
  resolveGithubRef
} from './github-source'
import { listInstalledPackages } from './installed'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import { compareText, isRecord, sha256 } from './installer-utils'
import { installPackages } from './lifecycle'
import { regularPackageFiles } from './materialize-registry'
import { runPackageMutation } from './mutation-queue'
import { planInstall } from './planning'

const MAX_CANDIDATES = 256
const CANDIDATE_LIFETIME_MS = 30 * 60_000
const SKILL_NAME = /^[a-z][a-z0-9-]{1,63}$/
const silentLogger = { info: (): void => undefined, warn: (): void => undefined }

export interface ExternalSkillSearchApprovalRequest {
  runtimeSessionId: string
  query: string
  limit: number
  endpoint: 'https://skills.sh/api/search'
  question: string
}

export interface ExternalSkillApprovalRequest {
  runtimeSessionId: string
  candidateId: string
  repo: string
  sha: string
  skill: string
  reason: string
  question: string
}

export interface ExternalSkillDependencies {
  agentDir: string
  appVersion: string
  fetch?: typeof globalThis.fetch
  confirmSearch?: (
    request: ExternalSkillSearchApprovalRequest,
    context: PhiHostRequestContext
  ) => Promise<boolean>
  confirm: (
    request: ExternalSkillApprovalRequest,
    context: PhiHostRequestContext
  ) => Promise<boolean>
  assertCurrent?: (context: PhiHostRequestContext) => void
}

interface RememberedSkill {
  runtimeSessionId: string
  repo: string
  skill: string
  createdAt: number
}

export type ExternalSkillSearchResult =
  | {
      candidates: CapabilityCandidate[]
      errors: string[]
    }
  | {
      ok: false
      searched: false
      status: 'denied' | 'cancelled'
      candidates: CapabilityCandidate[]
      errors: string[]
      message: string
    }

export interface ExternalSkillService {
  findSkills: (
    params: unknown,
    context: PhiHostRequestContext
  ) => Promise<ExternalSkillSearchResult>
  install: (params: unknown, context: PhiHostRequestContext) => Promise<CapabilityInstallResult>
  ownsCandidate: (candidateId: string, runtimeSessionId: string) => boolean
}

export function externalSkillSearchSummary(query: string): string {
  return [
    '允许向外部网站 skills.sh 搜索第三方社区技能吗？',
    `搜索关键词：${query}`,
    '目标站点：https://skills.sh/api/search（第三方公共网站）',
    '安全提醒：',
    '• Phi 官方软件源中未找到匹配技能；批准后会将上述搜索词发送至外部网站检索元数据。',
    '• 外部社区技能未经 Phi 官方签名或安全审核，可能包含不受信任的指令或脚本。',
    '• 本次批准仅允许检索列表，不会下载或运行任何代码；后续若需安装仍将再次请求确认。'
  ].join('\n')
}

export function externalSkillInstallSummary(params: {
  repo: string
  sha: string
  skill: string
  reason: string
}): string {
  return [
    `允许从 GitHub ${params.repo} 安装外部技能 ${params.skill} 吗？`,
    `仓库地址：https://github.com/${params.repo}`,
    `提交：${params.sha}`,
    '来源与信任：第三方社区导入（imported · 未签名 · 未经 Phi 官方审核）',
    `用途：${params.reason}`,
    '二次安全提醒：',
    '• 该外部技能未经 Phi 官方安全审查，安装后其 SKILL.md 指令将加载到当前对话上下文（存在提示词注入风险）。',
    '• 技能包内可能附带可执行脚本，运行时可能读取项目文件或引导工具操作；请核对仓库来源与提交哈希，仅在信任作者时批准安装。'
  ].join('\n')
}

/** Search results are untrusted data; only host-created, session-bound tokens can be installed. */
export function createExternalSkillService(deps: ExternalSkillDependencies): ExternalSkillService {
  const remembered = new Map<string, RememberedSkill>()
  const check = (context: PhiHostRequestContext): void => {
    context.signal?.throwIfAborted()
    deps.assertCurrent?.(context)
  }
  const fetchFor =
    (context: PhiHostRequestContext): typeof globalThis.fetch =>
    (input, init) => {
      check(context)
      return (deps.fetch ?? globalThis.fetch)(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(context.signal ? [context.signal] : []),
          ...(init?.signal ? [init.signal] : [])
        ])
      })
    }
  function prune(): void {
    for (const [id, item] of remembered) {
      if (Date.now() - item.createdAt > CANDIDATE_LIFETIME_MS) remembered.delete(id)
    }
  }

  async function findSkills(
    params: unknown,
    context: PhiHostRequestContext
  ): Promise<ExternalSkillSearchResult> {
    const input = searchInput(params)
    if (context.signal?.aborted) return searchCancelled()
    check(context)
    if (deps.confirmSearch) {
      const approved = await approvalDecision(
        deps.confirmSearch(
          {
            runtimeSessionId: input.runtimeSessionId,
            query: input.query,
            limit: input.limit,
            endpoint: 'https://skills.sh/api/search',
            question: externalSkillSearchSummary(input.query)
          },
          context
        ),
        context.signal
      )
      if (context.signal?.aborted) return searchCancelled()
      check(context)
      if (approved !== true) {
        return {
          ok: false,
          searched: false,
          status: 'denied',
          candidates: [],
          errors: [],
          message: '用户拒绝向外部网站搜索第三方技能；请继续使用现有功能和官方模块'
        }
      }
    }
    const url = new URL('https://skills.sh/api/search')
    url.searchParams.set('q', input.query)
    url.searchParams.set('limit', String(input.limit))
    const response = await fetchFor(context)(url, { credentials: 'omit', redirect: 'error' })
    check(context)
    if (!response.ok) throw new Error(`find_skills 搜索失败（HTTP ${response.status}）`)
    const bytes = await readBoundedResponse(response, 1024 * 1024, 'find_skills 搜索结果', 30_000)
    check(context)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isRecord(value) || !Array.isArray(value.skills)) {
      throw new Error('find_skills 搜索结果格式无效')
    }
    prune()
    const candidates: CapabilityCandidate[] = []
    const errors: string[] = []
    const installed = listInstalledPackages({ agentDir: deps.agentDir })
    const seen = new Set<string>()
    for (const raw of value.skills.slice(0, input.limit)) {
      const skill = searchResult(raw)
      if (!skill) {
        errors.push('find_skills 已忽略仓库来源或技能名称无效的结果')
        continue
      }
      const key = `${skill.repo}/${skill.skill}`
      if (seen.has(key)) continue
      seen.add(key)
      while (remembered.size >= MAX_CANDIDATES) remembered.delete(remembered.keys().next().value!)
      const candidateId = randomUUID()
      remembered.set(candidateId, {
        ...skill,
        runtimeSessionId: input.runtimeSessionId,
        createdAt: Date.now()
      })
      candidates.push({
        candidateId,
        type: 'skill',
        id: skill.skill,
        version: '1.0.0',
        title: skill.skill,
        summary: `来自 skills.sh 的外部技能：${key}；安装前需要批准固定提交。`,
        source: skill.repo,
        trust: 'imported',
        installed: installed.some((item) => item.type === 'skill' && item.id === skill.skill),
        enabled: false,
        size: 0
      })
    }
    return { candidates, errors }
  }

  function ownsCandidate(candidateId: string, runtimeSessionId: string): boolean {
    prune()
    return remembered.get(candidateId)?.runtimeSessionId === runtimeSessionId
  }

  async function install(
    params: unknown,
    context: PhiHostRequestContext
  ): Promise<CapabilityInstallResult> {
    const input = installInput(params)
    if (context.signal?.aborted) return cancelled()
    check(context)
    prune()
    const candidate = remembered.get(input.candidateId)
    if (!candidate || candidate.runtimeSessionId !== input.runtimeSessionId) {
      throw new Error('外部技能候选无效或已过期；请在当前会话重新搜索')
    }
    remembered.delete(input.candidateId)
    const repository = parseGithubRepoUrl(`https://github.com/${candidate.repo}`)
    try {
      const sha = await resolveGithubRef(repository, undefined, { fetch: fetchFor(context) })
      check(context)
      const approved = await approvalDecision(
        deps.confirm(
          {
            runtimeSessionId: input.runtimeSessionId,
            candidateId: input.candidateId,
            repo: candidate.repo,
            sha,
            skill: candidate.skill,
            reason: input.reason,
            question: externalSkillInstallSummary({
              repo: candidate.repo,
              sha,
              skill: candidate.skill,
              reason: input.reason
            })
          },
          context
        ),
        context.signal
      )
      if (context.signal?.aborted) return cancelled()
      check(context)
      if (approved !== true)
        return {
          ok: false,
          installed: false,
          status: 'denied',
          message: '用户拒绝安装外部技能；请继续使用现有功能'
        }
      return await runPackageMutation(async () => {
        if (context.signal?.aborted) return cancelled()
        check(context)
        const temporaryRoot = join(deps.agentDir, '.staging')
        mkdirSync(temporaryRoot, { recursive: true })
        const temporary = mkdtempSync(join(temporaryRoot, 'external-skill-'))
        try {
          const source = await fetchGithubSnapshot(repository, sha, {
            cacheRoot: join(temporary, 'snapshot'),
            fetch: fetchFor(context)
          })
          check(context)
          const skill = selectSkill(source, candidate.skill)
          const registry = buildSkillRegistry(skill, candidate, sha, temporary)
          const existing = listInstalledPackages({ agentDir: deps.agentDir }).find(
            (item) => item.type === 'skill' && item.id === candidate.skill
          )
          if (existing && existing.registry !== registry.id) {
            throw new Error(
              `同名技能 ${candidate.skill} 已从其他来源或提交安装；请先在技能管理中处理冲突`
            )
          }
          const options = { agentDir: deps.agentDir, appVersion: deps.appVersion }
          const plan = planInstall(registry, { type: 'skill', id: candidate.skill }, options)
          check(context)
          if (plan.packages.length > 0) {
            await installPackages(plan, { ...options, beforeCommit: () => check(context) })
          }
          check(context)
          setEnabled(`skill:${candidate.skill}`, true, {
            agentDir: deps.agentDir,
            logger: silentLogger
          })
          const packages = listInstalledPackages({ agentDir: deps.agentDir })
          return {
            ok: true,
            installed: true,
            root: plan.root,
            packages,
            usage: packages
              .filter((item) => item.type === 'skill' && item.id === candidate.skill)
              .map((item) => ({ type: item.type, id: item.id, path: join(item.dir, 'SKILL.md') }))
          }
        } finally {
          rmSync(temporary, { recursive: true, force: true })
        }
      })
    } catch (error) {
      if (context.signal?.aborted) return cancelled()
      throw error
    }
  }

  return { findSkills, install, ownsCandidate }
}

function searchInput(params: unknown): { runtimeSessionId: string; query: string; limit: number } {
  if (
    !isRecord(params) ||
    !validSession(params.runtimeSessionId) ||
    typeof params.query !== 'string' ||
    !params.query.trim() ||
    params.query.length > 500 ||
    (params.limit !== undefined &&
      (!Number.isInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 50))
  ) {
    throw new Error('find_skills 搜索参数无效')
  }
  return {
    runtimeSessionId: params.runtimeSessionId,
    query: params.query.trim(),
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
    throw new Error('外部技能安装参数无效；只能使用搜索返回的候选标识并说明原因')
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

function searchResult(raw: unknown): Pick<RememberedSkill, 'repo' | 'skill'> | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.source !== 'string' ||
    typeof raw.skillId !== 'string' ||
    !SKILL_NAME.test(raw.skillId)
  )
    return undefined
  try {
    const repo = parseGithubRepoUrl(`https://github.com/${raw.source}`)
    if (repo.ref || repo.repo !== raw.source || raw.source.split('/').length !== 2) return undefined
    return { repo: repo.repo, skill: raw.skillId }
  } catch {
    return undefined
  }
}

function selectSkill(
  source: string,
  name: string
): { dir: string; frontmatter: Record<string, unknown> } {
  const matches: Array<{ dir: string; frontmatter: Record<string, unknown> }> = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error('外部技能包含链接或非普通文件')
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (entry.name !== 'SKILL.md') continue
      const parsed = parseSkillFile(readFileSync(path, 'utf8'))
      if (parsed.ok && (basename(dir) === name || parsed.frontmatter.name === name)) {
        if (parsed.frontmatter.name !== name)
          throw new Error(`技能目录 ${name} 与 SKILL.md 声明的名称不一致`)
        matches.push({ dir, frontmatter: parsed.frontmatter })
      }
    }
  }
  visit(source)
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `仓库包含多个同名技能 ${name}，无法安全选择`
        : `仓库中找不到技能 ${name} 的 SKILL.md`
    )
  return matches[0]!
}

function buildSkillRegistry(
  skill: { dir: string; frontmatter: Record<string, unknown> },
  candidate: RememberedSkill,
  sha: string,
  temporary: string
): LocalRegistry {
  const metadata = isRecord(skill.frontmatter.metadata) ? skill.frontmatter.metadata : undefined
  const version =
    typeof metadata?.version === 'string' && semver.valid(metadata.version)
      ? metadata.version
      : '1.0.0'
  const summary =
    typeof skill.frontmatter.description === 'string' && skill.frontmatter.description.trim()
      ? skill.frontmatter.description.trim().slice(0, 300)
      : `外部技能 ${candidate.skill}`
  const manifest = {
    schemaVersion: 1,
    type: 'skill',
    id: candidate.skill,
    version,
    title: candidate.skill,
    summary,
    files: 'files.json'
  }
  const packageDir = join(temporary, 'package')
  mkdirSync(packageDir)
  for (const file of regularPackageFiles(skill.dir)) {
    if (file.path === 'phi-package.yaml' || file.path === '.source.json') continue
    const target = join(packageDir, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data, { flag: 'wx' })
    chmodSync(target, file.mode ?? 0o644)
  }
  writeFileSync(join(packageDir, 'phi-package.yaml'), `${JSON.stringify(manifest, null, 2)}\n`)
  const files = regularPackageFiles(packageDir).sort((left, right) =>
    compareText(left.path, right.path)
  )
  const filesJson = Buffer.from(
    `${JSON.stringify({ version: 1, files: files.map((file) => ({ path: file.path, sha256: sha256(file.data), size: file.data.length })) }, null, 2)}\n`
  )
  const archive = createDeterministicTarGz([...files, { path: 'files.json', data: filesJson }])
  const registryDir = join(temporary, 'registry')
  mkdirSync(registryDir)
  const archiveName = `skill-${candidate.skill}-${version}.tar.gz`
  writeFileSync(join(registryDir, archiveName), archive)
  const entry: RegistryPackageEntry = {
    ...manifest,
    type: 'skill',
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: []
  }
  return {
    schemaVersion: 1,
    id: `external-skill:${candidate.repo}/${candidate.skill}@${sha}`,
    dir: registryDir,
    trust: 'imported',
    generatedAt: new Date().toISOString(),
    packages: [entry]
  }
}

function approvalDecision(decision: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return decision
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    decision
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
      .catch(() => undefined)
  })
}

function searchCancelled(): ExternalSkillSearchResult {
  return {
    ok: false,
    searched: false,
    status: 'cancelled',
    candidates: [],
    errors: [],
    message: '外部技能搜索已取消'
  }
}

function cancelled(): CapabilityInstallResult {
  return { ok: false, installed: false, status: 'cancelled', message: '外部技能安装已取消' }
}
