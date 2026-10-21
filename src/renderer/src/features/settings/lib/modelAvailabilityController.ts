import type {
  ModelAvailabilityChange,
  ModelAvailabilitySnapshot
} from '../../../../../shared/modelAvailabilityTypes'
import { errorMessage } from '../../../../../shared/errorCodes'

export function availabilityTarget(
  change: Pick<ModelAvailabilityChange, 'providerId' | 'modelId'>
): string {
  return JSON.stringify([change.providerId, change.modelId ?? null])
}

/** Merge only the acknowledged target: another target's response may arrive out of order. */
export function mergeAvailabilityChange(
  current: ModelAvailabilitySnapshot,
  result: ModelAvailabilitySnapshot,
  change: ModelAvailabilityChange
): ModelAvailabilitySnapshot {
  const target = availabilityTarget(change)
  const disabledProviders = change.modelId
    ? current.disabledProviders
    : [
        ...current.disabledProviders.filter((id) => id !== change.providerId),
        ...result.disabledProviders.filter((id) => id === change.providerId)
      ]
  const disabledModels = change.modelId
    ? [
        ...current.disabledModels.filter((model) => availabilityTarget(model) !== target),
        ...result.disabledModels.filter((model) => availabilityTarget(model) === target)
      ]
    : current.disabledModels
  return {
    disabledProviders,
    disabledModels,
    models: result.models.map((model) => ({
      ...model,
      enabled:
        !disabledProviders.includes(model.providerId) &&
        !disabledModels.some(
          (disabled) => availabilityTarget(disabled) === availabilityTarget(model)
        )
    }))
  }
}

export interface AvailabilityState {
  snapshot: ModelAvailabilitySnapshot | null
  loading: boolean
  loadError: string | null
  errors: Readonly<Record<string, string>>
  pending: readonly string[]
}
interface AvailabilityApi {
  getModelAvailability(): Promise<ModelAvailabilitySnapshot>
  setModelEnabled(change: ModelAvailabilityChange): Promise<ModelAvailabilitySnapshot>
}

export class ModelAvailabilityController {
  private state: AvailabilityState = {
    snapshot: null,
    loading: true,
    loadError: null,
    errors: {},
    pending: []
  }
  private listeners = new Set<() => void>()
  private pending = new Set<string>()
  private alive = false
  private revision = 0
  private generation = 0
  private refreshQueued = false
  constructor(
    private api: AvailabilityApi,
    private acknowledged: () => void
  ) {}
  getSnapshot = (): AvailabilityState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  mount(): () => void {
    this.alive = true
    this.generation += 1
    this.pending.clear()
    this.publish({ pending: [] })
    return () => {
      this.alive = false
      this.generation += 1
      this.revision += 1
    }
  }
  private publish(patch: Partial<AvailabilityState>): void {
    if (!this.alive) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  async refresh(): Promise<void> {
    if (this.pending.size) {
      this.refreshQueued = true
      return
    }
    this.refreshQueued = false
    const revision = ++this.revision
    this.publish({ loading: true, loadError: null })
    try {
      const snapshot = await this.api.getModelAvailability()
      if (revision === this.revision) this.publish({ snapshot })
    } catch (cause) {
      if (revision === this.revision) this.publish({ loadError: errorMessage(cause) })
    } finally {
      if (revision === this.revision) this.publish({ loading: false })
    }
  }
  async change(change: ModelAvailabilityChange): Promise<void> {
    const target = availabilityTarget(change)
    if (!this.alive || this.pending.has(target) || !this.state.snapshot) return
    const generation = this.generation
    this.pending.add(target)
    this.revision += 1
    const errors = { ...this.state.errors }
    delete errors[target]
    this.publish({ pending: [...this.pending], errors, loading: false })
    try {
      const result = await this.api.setModelEnabled(change)
      if (generation === this.generation) {
        this.publish({ snapshot: mergeAvailabilityChange(this.state.snapshot, result, change) })
      }
      this.acknowledged()
    } catch (cause) {
      if (generation === this.generation) {
        this.publish({ errors: { ...this.state.errors, [target]: errorMessage(cause) } })
      }
    } finally {
      if (generation === this.generation) {
        this.pending.delete(target)
        this.publish({ pending: [...this.pending] })
        if (this.alive && !this.pending.size && this.refreshQueued) void this.refresh()
      }
    }
  }
}
