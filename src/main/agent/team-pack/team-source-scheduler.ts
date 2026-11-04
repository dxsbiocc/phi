import type { TeamSource, TeamSourceService } from './team-source'

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000

type TimerHandle = ReturnType<typeof setInterval>

export interface TeamSourceSchedulerService {
  listSources(): TeamSource[]
  pullAllSources(): Promise<PromiseSettledResult<TeamSource>[]>
}

export interface TeamSourceSchedulerOptions {
  service: Pick<TeamSourceService, 'listSources' | 'pullAllSources'> | TeamSourceSchedulerService
  intervalMs?: number
  setInterval?: (callback: () => void, intervalMs: number) => TimerHandle
  clearInterval?: (handle: TimerHandle) => void
}

export class TeamSourceScheduler {
  readonly #service: TeamSourceSchedulerService
  readonly #intervalMs: number
  readonly #setInterval: (callback: () => void, intervalMs: number) => TimerHandle
  readonly #clearInterval: (handle: TimerHandle) => void
  #timer: TimerHandle | undefined
  #running = false
  #tick: Promise<void> | undefined

  constructor(options: TeamSourceSchedulerOptions) {
    const intervalMs = options.intervalMs ?? SIX_HOURS_MS
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('团队来源拉取间隔必须是有限正整数')
    }
    this.#service = options.service
    this.#intervalMs = intervalMs
    this.#setInterval = options.setInterval ?? setInterval
    this.#clearInterval = options.clearInterval ?? clearInterval
  }

  async start(): Promise<void> {
    if (this.#running || this.#service.listSources().length === 0) return
    this.#running = true
    await this.runNow()
    if (!this.#running) return
    this.#timer = this.#setInterval(() => {
      void this.runNow().catch(() => undefined)
    }, this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) this.#clearInterval(this.#timer)
    this.#timer = undefined
  }

  runNow(): Promise<void> {
    if (this.#tick) return this.#tick
    const tick = this.#service.pullAllSources().then(() => undefined)
    const tracked = tick.finally(() => {
      if (this.#tick === tracked) this.#tick = undefined
    })
    this.#tick = tracked
    return tracked
  }
}

export function createTeamSourceScheduler(
  options: TeamSourceSchedulerOptions
): TeamSourceScheduler {
  return new TeamSourceScheduler(options)
}
