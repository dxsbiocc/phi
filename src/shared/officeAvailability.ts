export const OFFICE_AVAILABILITY_ARGUMENT_PREFIX = '--phi-office-availability='

export type OfficeAvailabilityReason =
  | 'unsupported-platform'
  | 'runtime-missing'
  | 'runtime-invalid'
  | 'user-disabled'
  | 'forced-disabled'
  | null

export interface OfficeAvailability {
  readonly supported: boolean
  readonly userEnabled: boolean
  readonly enabled: boolean
  readonly reason: OfficeAvailabilityReason
}

export const UNAVAILABLE_OFFICE_AVAILABILITY: OfficeAvailability = {
  supported: false,
  userEnabled: true,
  enabled: false,
  reason: 'runtime-invalid'
}

const VALID_REASONS = new Set<OfficeAvailabilityReason>([
  'unsupported-platform',
  'runtime-missing',
  'runtime-invalid',
  'user-disabled',
  'forced-disabled',
  null
])

function isOfficeAvailability(value: unknown): value is OfficeAvailability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.supported === 'boolean' &&
    typeof record.userEnabled === 'boolean' &&
    typeof record.enabled === 'boolean' &&
    VALID_REASONS.has(record.reason as OfficeAvailabilityReason) &&
    (!record.enabled || (record.supported && record.userEnabled && record.reason === null))
  )
}

export function officeAvailabilityArgument(availability: OfficeAvailability): string {
  return `${OFFICE_AVAILABILITY_ARGUMENT_PREFIX}${encodeURIComponent(JSON.stringify(availability))}`
}

export function parseOfficeAvailabilityArguments(args: readonly string[]): OfficeAvailability {
  const raw = args.find((arg) => arg.startsWith(OFFICE_AVAILABILITY_ARGUMENT_PREFIX))
  if (!raw) return UNAVAILABLE_OFFICE_AVAILABILITY
  try {
    const value = JSON.parse(
      decodeURIComponent(raw.slice(OFFICE_AVAILABILITY_ARGUMENT_PREFIX.length))
    ) as unknown
    return isOfficeAvailability(value) ? value : UNAVAILABLE_OFFICE_AVAILABILITY
  } catch {
    return UNAVAILABLE_OFFICE_AVAILABILITY
  }
}
