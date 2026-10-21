export type SshHostAvailabilityStatus = 'available' | 'unavailable' | 'attention'

export interface SshHostAvailabilityRecord {
  hostId: string
  status: SshHostAvailabilityStatus
  checkedAt: string
}
