import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { isTeamPackError, teamPackError } from './errors'
import { assertManagedChildDirectory, assertManagedDirectory } from './files'
import { parseTeamFile } from './format'
import { pullTeamRelease, type PullTeamReleaseResult } from './pull'
import { assertTrustedTeamKey } from './signing'
import {
  createDirectoryTeamPackStore,
  createHttpTeamPackStore,
  type HttpTeamPackStoreOptions,
  type TeamPackStore
} from './store'
import { reconcileTeamModels, removeTeamCredentialOwners } from './team-source-credentials'
import {
  listTeamSources,
  normalizeTeamSourceLocation,
  readTeamSourcesState,
  teamSourceRegistryDir,
  teamSourcesPath,
  writeTeamSourcesState
} from './team-source-storage'
import type {
  AddTeamSourceInput,
  TeamSource,
  TeamSourceAuthStorage,
  TeamSourceServiceOptions,
  TeamSourceStatus,
  TeamSourcesState,
  TeamSourcePreview
} from './team-source-types'

const MAX_TEAM_FILE_BYTES = 64 * 1024

export { listTeamSources, teamSourceRegistryDir, teamSourcesPath }
export type {
  AddTeamSourceInput,
  TeamSource,
  TeamSourceAuthStorage,
  TeamSourceErrorCode,
  TeamSourceLocation,
  TeamSourceServiceOptions,
  TeamSourceStatus,
  TeamSourceStoredCredential,
  TeamSourcePreview
} from './team-source-types'

export class TeamSourceService {
  readonly #options: TeamSourceServiceOptions
  readonly #additions = new Set<Promise<TeamSource>>()
  readonly #inFlight = new Map<string, Promise<TeamSource>>()
  readonly #removals = new Map<string, Promise<boolean>>()
  #stateTail: Promise<void> = Promise.resolve()
  #authStoragePromise: Promise<TeamSourceAuthStorage> | undefined
  #closing: Promise<void> | undefined

  constructor(options: TeamSourceServiceOptions) {
    if (!options.agentDir) throw teamPackError('INVALID_FORMAT', 'agentDir 不能为空')
    this.#options = options
  }

  listSources(): TeamSource[] {
    return listTeamSources(this.#options.agentDir)
  }

  configuredProviders(teamId: string): string[] {
    return readTeamSourcesState(this.#options.agentDir)
      .credentialOwners.filter((owner) => owner.teamId === teamId)
      .map((owner) => owner.providerId)
      .sort((left, right) => left.localeCompare(right))
  }

  async addSource(input: AddTeamSourceInput): Promise<TeamSource> {
    this.#assertOpen()
    const pending = this.#performAdd(input)
    const tracked = pending.finally(() => this.#additions.delete(tracked))
    this.#additions.add(tracked)
    return tracked
  }

  async previewSource(input: AddTeamSourceInput): Promise<TeamSourcePreview> {
    this.#assertOpen()
    const location = normalizeTeamSourceLocation(input.location, this.#options.allowHttp === true)
    const store = createStore(location, this.#options.httpStoreOptions)
    const data = await store.read('team.json', MAX_TEAM_FILE_BYTES)
    if (!data) throw teamPackError('STORE_UNAVAILABLE', '团队包存储缺少 team.json')
    const team = parseTeamFile(data)
    assertTrustedTeamKey(team.publicKey, input.teamKeyId)
    return {
      teamId: team.teamId,
      teamName: team.name,
      teamKeyId: input.teamKeyId,
      location
    }
  }

  async #performAdd(input: AddTeamSourceInput): Promise<TeamSource> {
    const preview = await this.previewSource(input)
    const source: TeamSource = {
      id: this.#options.createId?.() ?? randomUUID(),
      teamId: preview.teamId,
      teamName: preview.teamName,
      teamKeyId: preview.teamKeyId,
      location: preview.location,
      addedAt: nowIso(this.#options.now),
      status: emptyStatus()
    }
    return this.#mutateState((state) => {
      if (state.sources.some((entry) => entry.id === source.id)) {
        throw teamPackError('INVALID_FORMAT', '团队来源标识重复')
      }
      if (state.sources.some((entry) => entry.teamId === preview.teamId)) {
        throw teamPackError('INVALID_FORMAT', '该团队来源已登记')
      }
      return { state: { ...state, sources: [...state.sources, source] }, result: source }
    })
  }

  pullSource(id: string): Promise<TeamSource> {
    this.#assertOpen()
    if (this.#removals.has(id)) {
      return Promise.reject(teamPackError('INVALID_FORMAT', '团队来源正在删除'))
    }
    const existing = this.#inFlight.get(id)
    if (existing) return existing
    const source = this.listSources().find((entry) => entry.id === id)
    if (!source) return Promise.reject(teamPackError('INVALID_FORMAT', '找不到团队来源'))
    const pending = this.#performPull(source).finally(() => {
      if (this.#inFlight.get(id) === pending) this.#inFlight.delete(id)
    })
    this.#inFlight.set(id, pending)
    return pending
  }

  async pullAllSources(): Promise<PromiseSettledResult<TeamSource>[]> {
    return Promise.allSettled(this.listSources().map((source) => this.pullSource(source.id)))
  }

  removeSource(id: string): Promise<boolean> {
    this.#assertOpen()
    const existing = this.#removals.get(id)
    if (existing) return existing
    const pending = this.#performRemove(id).finally(() => {
      if (this.#removals.get(id) === pending) this.#removals.delete(id)
    })
    this.#removals.set(id, pending)
    return pending
  }

  async #performRemove(id: string): Promise<boolean> {
    await this.#inFlight.get(id)?.catch(() => undefined)
    return this.#mutateState(async (state) => {
      const source = state.sources.find((entry) => entry.id === id)
      if (!source) return { state, result: false, write: false }
      const credentialOwners = await removeTeamCredentialOwners(state, source.teamId, () =>
        this.#authStorage()
      )
      removeTeamState(this.#options.agentDir, source.teamId)
      return {
        state: {
          ...state,
          sources: state.sources.filter((entry) => entry.id !== id),
          credentialOwners
        },
        result: true
      }
    })
  }

  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    await Promise.allSettled([
      ...this.#additions,
      ...this.#inFlight.values(),
      ...this.#removals.values()
    ])
    await this.#stateTail
  }

  #assertOpen(): void {
    if (this.#closing) throw teamPackError('INVALID_FORMAT', '团队来源服务已关闭')
  }

  async #performPull(source: TeamSource): Promise<TeamSource> {
    try {
      const location = normalizeTeamSourceLocation(
        source.location,
        this.#options.allowHttp === true
      )
      const result = await (this.#options.pullRelease ?? pullTeamRelease)({
        store: createStore(location, this.#options.httpStoreOptions),
        teamKeyId: source.teamKeyId,
        identity: await this.#options.getMemberIdentity(),
        stateDir: join(this.#options.agentDir, 'team-pack', 'state'),
        now: this.#options.now
      })
      if (result.teamId !== source.teamId) {
        throw teamPackError('INVALID_FORMAT', '团队拉取结果与已登记来源不匹配')
      }
      return await this.#recordSuccessfulPull(source, result)
    } catch (error) {
      await this.#recordFailedPull(source.id, error)
      throw error
    }
  }

  #recordSuccessfulPull(source: TeamSource, result: PullTeamReleaseResult): Promise<TeamSource> {
    return this.#mutateState(async (state) => {
      const current = state.sources.find((entry) => entry.id === source.id)
      if (!current) throw teamPackError('INVALID_FORMAT', '团队来源已被删除')
      const reconciled = await reconcileTeamModels({
        state,
        teamId: current.teamId,
        models: result.models,
        getAuthStorage: () => this.#authStorage()
      })
      const changed = successfulSource(current, result, reconciled, nowIso(this.#options.now))
      return {
        state: {
          ...state,
          sources: state.sources.map((entry) => (entry.id === changed.id ? changed : entry)),
          credentialOwners: reconciled.owners
        },
        result: changed
      }
    })
  }

  #recordFailedPull(id: string, error: unknown): Promise<TeamSource | null> {
    return this.#mutateState((state) => {
      const current = state.sources.find((entry) => entry.id === id)
      if (!current) return { state, result: null, write: false }
      const changed: TeamSource = {
        ...current,
        status: {
          ...current.status,
          lastCheckedAt: nowIso(this.#options.now),
          lastErrorCode: isTeamPackError(error) ? error.code : 'UNKNOWN'
        }
      }
      return {
        state: {
          ...state,
          sources: state.sources.map((entry) => (entry.id === id ? changed : entry))
        },
        result: changed
      }
    })
  }

  #authStorage(): Promise<TeamSourceAuthStorage> {
    if (this.#authStoragePromise) return this.#authStoragePromise
    const configured = this.#options.authStorage
    if (typeof configured === 'function') this.#authStoragePromise = configured()
    else if (configured) this.#authStoragePromise = Promise.resolve(configured)
    else {
      this.#authStoragePromise = Promise.reject(
        teamPackError('STORE_UNAVAILABLE', '团队模型凭据运行时不可用')
      )
    }
    return this.#authStoragePromise
  }

  #mutateState<T>(
    mutate: (
      state: TeamSourcesState
    ) =>
      | { state: TeamSourcesState; result: T; write?: boolean }
      | Promise<{ state: TeamSourcesState; result: T; write?: boolean }>
  ): Promise<T> {
    const operation = this.#stateTail.then(async () => {
      const changed = await mutate(readTeamSourcesState(this.#options.agentDir))
      if (changed.write !== false) writeTeamSourcesState(this.#options.agentDir, changed.state)
      return changed.result
    })
    this.#stateTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

function createStore(
  location: TeamSource['location'],
  httpOptions?: HttpTeamPackStoreOptions
): TeamPackStore {
  return location.kind === 'directory'
    ? createDirectoryTeamPackStore(location.path)
    : createHttpTeamPackStore(location.url, httpOptions)
}

function removeTeamState(agentDir: string, teamId: string): void {
  const stateDir = join(agentDir, 'team-pack', 'state')
  const teamDir = join(stateDir, teamId)
  assertManagedDirectory(stateDir, '团队包状态目录')
  assertManagedChildDirectory(stateDir, teamDir, '团队状态根目录')
  rmSync(teamDir, { recursive: true, force: true })
}

function successfulSource(
  source: TeamSource,
  result: PullTeamReleaseResult,
  reconciled: { conflicts: string[]; skipped: string[] },
  checkedAt: string
): TeamSource {
  return {
    ...source,
    status: {
      lastSuccessfulRelease: result.release,
      lastCheckedAt: checkedAt,
      lastErrorCode: null,
      withdrawnReleases: [...result.withdrawnReleases],
      credentialConflicts: reconciled.conflicts,
      skippedProviders: reconciled.skipped
    }
  }
}

function emptyStatus(): TeamSourceStatus {
  return {
    lastSuccessfulRelease: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    withdrawnReleases: [],
    credentialConflicts: [],
    skippedProviders: []
  }
}

function nowIso(value: Date | (() => Date) | undefined): string {
  const date = typeof value === 'function' ? value() : (value ?? new Date())
  if (!Number.isFinite(date.getTime())) throw teamPackError('INVALID_FORMAT', '当前时间无效')
  return date.toISOString()
}
