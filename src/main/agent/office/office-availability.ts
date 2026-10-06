import type {
  OfficeAvailability,
  OfficeAvailabilityReason
} from '../../../shared/officeAvailability'
import { detectOfficeRuntime, officePlatformId, type OfficeRuntimeStatus } from './office-runtime'

export interface ComputeOfficeAvailabilityInput {
  readonly runtime: OfficeRuntimeStatus
  readonly userEnabled: boolean
  readonly forcedDisabled?: boolean
}

export interface InitializeOfficeAvailabilityOptions {
  readonly userEnabled: boolean
  readonly forcedDisabled: boolean
  readonly platform?: string
  readonly arch?: string
  readonly detectRuntime?: () => Promise<OfficeRuntimeStatus>
  readonly onUnavailable?: (reason: Exclude<OfficeAvailabilityReason, null>) => void
}

function runtimeReason(runtime: OfficeRuntimeStatus): OfficeAvailabilityReason {
  if (runtime.state === 'available') return null
  if (runtime.state === 'unsupported-platform') return 'unsupported-platform'
  if (runtime.state === 'missing') return 'runtime-missing'
  return 'runtime-invalid'
}

export function computeOfficeAvailability(
  input: ComputeOfficeAvailabilityInput
): OfficeAvailability {
  const reason = runtimeReason(input.runtime)
  const supported = input.runtime.state !== 'unsupported-platform'
  if (!supported) return { supported, userEnabled: input.userEnabled, enabled: false, reason }
  if (input.forcedDisabled) {
    return { supported, userEnabled: input.userEnabled, enabled: false, reason: 'forced-disabled' }
  }
  if (!input.userEnabled) {
    return { supported, userEnabled: false, enabled: false, reason: 'user-disabled' }
  }
  return { supported, userEnabled: true, enabled: reason === null, reason }
}

function disabledAvailability(userEnabled: boolean, forcedDisabled: boolean): OfficeAvailability {
  return {
    supported: true,
    userEnabled,
    enabled: false,
    reason: forcedDisabled ? 'forced-disabled' : 'user-disabled'
  }
}

export class OfficeAvailabilityCache {
  private initializing: Promise<OfficeAvailability> | null = null
  private availability: OfficeAvailability | null = null
  private runtime: Extract<OfficeRuntimeStatus, { state: 'available' }> | null = null

  initialize(options: InitializeOfficeAvailabilityOptions): Promise<OfficeAvailability> {
    this.initializing ??= this.initializeOnce(options)
    return this.initializing
  }

  get(): OfficeAvailability {
    if (!this.availability) throw new Error('Office availability is not initialized')
    return this.availability
  }

  getRuntime(): Extract<OfficeRuntimeStatus, { state: 'available' }> {
    if (!this.runtime) throw new Error('Office runtime is unavailable')
    return this.runtime
  }

  private async initializeOnce(
    options: InitializeOfficeAvailabilityOptions
  ): Promise<OfficeAvailability> {
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    if (!officePlatformId(platform, arch)) {
      return this.remember(
        {
          supported: false,
          userEnabled: options.userEnabled,
          enabled: false,
          reason: 'unsupported-platform'
        },
        options
      )
    }
    if (options.forcedDisabled || !options.userEnabled) {
      return this.remember(
        disabledAvailability(options.userEnabled, options.forcedDisabled),
        options
      )
    }
    const runtime = await this.probe(options.detectRuntime ?? detectOfficeRuntime)
    if (runtime.state === 'available') this.runtime = runtime
    return this.remember(computeOfficeAvailability({ runtime, userEnabled: true }), options)
  }

  private async probe(detect: () => Promise<OfficeRuntimeStatus>): Promise<OfficeRuntimeStatus> {
    try {
      return await detect()
    } catch (error) {
      return {
        state: 'unusable',
        binaryPath: '',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private remember(
    availability: OfficeAvailability,
    options: InitializeOfficeAvailabilityOptions
  ): OfficeAvailability {
    this.availability = availability
    if (
      availability.reason &&
      availability.reason !== 'user-disabled' &&
      availability.reason !== 'forced-disabled'
    ) {
      options.onUnavailable?.(availability.reason)
    }
    return availability
  }
}

export const officeAvailabilityCache = new OfficeAvailabilityCache()
