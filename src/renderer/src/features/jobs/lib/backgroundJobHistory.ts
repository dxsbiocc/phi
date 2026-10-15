import type { LiveBackgroundJob, UnifiedBackgroundJob } from './backgroundJobs'
import {
  jobDetailFields,
  jobSource,
  jobStatus,
  jobTitle,
  type JobDetailField,
  type JobTone
} from './backgroundJobLabels'

export const BACKGROUND_JOB_HISTORY_KEY = 'phi.background-jobs-history.v1'
export const MAX_RETAINED_BACKGROUND_JOBS = 50
const MAX_STORAGE_CHARS = 128 * 1024
const KINDS = new Set([
  'agent',
  'shell',
  'wrapper',
  'environment',
  'connector',
  'upload',
  'jupyter',
  'notebook-ai'
])
const DETAIL_LABELS = new Set([
  '对话',
  '状态',
  '开始时间',
  '结束时间',
  '耗时',
  'Wrapper',
  '运行 ID',
  '输出目录',
  '环境',
  '环境 ID',
  '文件',
  '目标目录',
  '项目',
  '服务器',
  'Notebook',
  '模型',
  '生成单元'
])

export interface JobHistorySnapshot {
  key: string
  sourceKind: LiveBackgroundJob['kind']
  timestamp: string
  title: string
  source: string
  status: { label: string; tone: Exclude<JobTone, 'running'> }
  fields: JobDetailField[]
  sessionPath?: string
  wrapperId?: string
}

export interface RetainedBackgroundJob {
  kind: 'history'
  key: string
  active: false
  timestamp: string
  snapshot: JobHistorySnapshot
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type HistoryState = {
  schema: 1
  records: JobHistorySnapshot[]
  clearedBefore: string | null
  dismissed: Record<string, string>
}

function emptyState(): HistoryState {
  return { schema: 1, records: [], clearedBefore: null, dismissed: {} }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return value
    .slice(0, limit)
    .replaceAll('\0', '')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|--token)\s*[:=]?\s+|(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|--token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[已隐藏]'
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[已隐藏]@')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏]')
    .slice(0, limit)
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function safeSessionPath(value: unknown): string | undefined {
  return typeof value === 'string' && /^phi-session:[A-Za-z0-9_-]{1,200}$/.test(value)
    ? value
    : undefined
}

function safeWrapperId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,255}$/.test(value)
    ? value
    : undefined
}

function checkedSnapshot(value: unknown): JobHistorySnapshot | undefined {
  if (
    !record(value) ||
    !KINDS.has(String(value.sourceKind)) ||
    typeof value.key !== 'string' ||
    value.key.length > 512 ||
    !value.key.startsWith(`${value.sourceKind}:`)
  )
    return undefined
  const at = timestamp(value.timestamp)
  const title = text(value.title, 160)
  if (
    !at ||
    !title ||
    !record(value.status) ||
    !['success', 'error', 'neutral'].includes(String(value.status.tone)) ||
    !Array.isArray(value.fields)
  )
    return undefined
  const statusLabel = text(value.status.label, 32)
  const source = text(value.source, 96)
  if (!statusLabel || !source) return undefined
  const fields = value.fields.slice(0, 8).flatMap((field): JobDetailField[] =>
    record(field) && typeof field.label === 'string' && DETAIL_LABELS.has(field.label)
      ? [
          {
            label: field.label,
            value: text(field.value, 256),
            ...(field.mono === true ? { mono: true } : {})
          }
        ]
      : []
  )
  const sessionPath = safeSessionPath(value.sessionPath)
  const wrapperId = safeWrapperId(value.wrapperId)
  return {
    key: value.key,
    sourceKind: value.sourceKind as LiveBackgroundJob['kind'],
    timestamp: at,
    title,
    source,
    status: {
      label: statusLabel,
      tone: value.status.tone as Exclude<JobTone, 'running'>
    },
    fields,
    ...(sessionPath ? { sessionPath } : {}),
    ...(wrapperId ? { wrapperId } : {})
  }
}

/** Only display metadata is retained: never commands, task prompts, logs, errors or configs. */
function snapshotOf(item: LiveBackgroundJob): JobHistorySnapshot | undefined {
  if (item.active) return undefined
  const status = jobStatus(item)
  if (status.tone === 'running') return undefined
  const fields = jobDetailFields(item, Date.parse(item.timestamp)).filter((field) =>
    DETAIL_LABELS.has(field.label)
  )
  if (!fields.some((field) => field.label === '状态'))
    fields.push({ label: '状态', value: status.label })
  fields.push({ label: '结束时间', value: new Date(item.timestamp).toLocaleString() })
  return checkedSnapshot({
    key: item.key,
    sourceKind: item.kind,
    timestamp: item.timestamp,
    title:
      item.kind === 'shell'
        ? '后台命令'
        : item.kind === 'wrapper'
          ? item.run.wrapper.shortId || item.run.wrapper.canonicalId
          : jobTitle(item),
    source: jobSource(item) || (item.kind === 'agent' ? 'Agent' : '后台命令'),
    status,
    fields,
    ...(item.kind === 'agent' || item.kind === 'shell'
      ? { sessionPath: item.run.sessionPath }
      : {}),
    ...(item.kind === 'wrapper' ? { wrapperId: item.run.wrapper.canonicalId } : {})
  })
}

function newestFirst(left: { timestamp: string }, right: { timestamp: string }): number {
  return right.timestamp.localeCompare(left.timestamp)
}

function readState(storage: StorageLike | undefined): HistoryState {
  try {
    const raw = storage?.getItem(BACKGROUND_JOB_HISTORY_KEY)
    if (!raw || raw.length > MAX_STORAGE_CHARS) return emptyState()
    const value: unknown = JSON.parse(raw)
    if (!record(value) || value.schema !== 1 || !Array.isArray(value.records)) return emptyState()
    const records = new Map<string, JobHistorySnapshot>()
    for (const candidate of value.records.slice(0, MAX_RETAINED_BACKGROUND_JOBS)) {
      const item = checkedSnapshot(candidate)
      if (item && (!records.has(item.key) || records.get(item.key)!.timestamp < item.timestamp))
        records.set(item.key, item)
    }
    const dismissed: Record<string, string> = {}
    if (record(value.dismissed))
      for (const [key, at] of Object.entries(value.dismissed).slice(
        0,
        MAX_RETAINED_BACKGROUND_JOBS
      )) {
        const endedAt = timestamp(at)
        if (key.length <= 512 && KINDS.has(key.split(':')[0]) && endedAt) dismissed[key] = endedAt
      }
    return {
      schema: 1,
      records: [...records.values()].sort(newestFirst),
      clearedBefore: timestamp(value.clearedBefore),
      dismissed
    }
  } catch {
    return emptyState()
  }
}

/** Local display history, independent from the authoritative runtime job registries. */
export class BackgroundJobHistory {
  private state: HistoryState
  private saved: string

  constructor(private readonly storage?: StorageLike) {
    this.state = readState(storage)
    this.saved = JSON.stringify(this.state)
  }

  observe(items: readonly LiveBackgroundJob[]): void {
    const records = new Map(this.state.records.map((item) => [item.key, item]))
    for (const item of items) {
      // A new live attempt supersedes the old terminal snapshot for that source identity.
      if (item.active) records.delete(item.key)
      else {
        const snapshot = snapshotOf(item)
        if (snapshot && this.visible(snapshot)) records.set(item.key, snapshot)
      }
    }
    this.state.records = [...records.values()]
      .filter((item) => this.visible(item))
      .sort(newestFirst)
      .slice(0, MAX_RETAINED_BACKGROUND_JOBS)
    this.save()
  }

  select(live: { active: readonly LiveBackgroundJob[]; recent: readonly LiveBackgroundJob[] }): {
    active: UnifiedBackgroundJob[]
    recent: UnifiedBackgroundJob[]
  } {
    const liveKeys = new Set([...live.active, ...live.recent].map((item) => item.key))
    const restored: RetainedBackgroundJob[] = this.state.records
      .filter((item) => !liveKeys.has(item.key) && this.visible(item))
      .map((snapshot) => ({
        kind: 'history',
        key: snapshot.key,
        active: false,
        timestamp: snapshot.timestamp,
        snapshot
      }))
    return {
      active: [...live.active],
      recent: [...live.recent.filter((item) => this.visible(item)), ...restored]
        .sort(newestFirst)
        .slice(0, MAX_RETAINED_BACKGROUND_JOBS)
    }
  }

  clearCompleted(live: readonly LiveBackgroundJob[], now = new Date().toISOString()): void {
    const cutoff = timestamp(now) ?? new Date().toISOString()
    this.state.clearedBefore =
      this.state.clearedBefore && this.state.clearedBefore > cutoff
        ? this.state.clearedBefore
        : cutoff
    // Timestamp fences permit a later build/connection attempt with the same ID to appear.
    const future = [
      ...Object.entries(this.state.dismissed).map(([key, at]) => ({ key, timestamp: at })),
      ...this.state.records,
      ...live.filter((item) => !item.active)
    ]
      .filter((item) => item.timestamp > this.state.clearedBefore!)
      .sort(newestFirst)
    const dismissed = new Map<string, string>()
    for (const item of future) if (!dismissed.has(item.key)) dismissed.set(item.key, item.timestamp)
    this.state.dismissed = Object.fromEntries([...dismissed].slice(0, MAX_RETAINED_BACKGROUND_JOBS))
    this.state.records = []
    this.save()
  }

  private visible(item: { key: string; timestamp: string }): boolean {
    return (
      (!this.state.clearedBefore || item.timestamp > this.state.clearedBefore) &&
      (!this.state.dismissed[item.key] || item.timestamp > this.state.dismissed[item.key])
    )
  }

  private save(): void {
    let serialized = JSON.stringify(this.state)
    while (serialized.length > MAX_STORAGE_CHARS && this.state.records.length > 0) {
      this.state.records.pop()
      serialized = JSON.stringify(this.state)
    }
    if (serialized === this.saved || serialized.length > MAX_STORAGE_CHARS) return
    try {
      this.storage?.setItem(BACKGROUND_JOB_HISTORY_KEY, serialized)
      this.saved = serialized
    } catch {
      /* Storage may be disabled or full; current-window history still works. */
    }
  }
}

export function backgroundJobHistoryStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
