import type {
  KernelModelDescriptor,
  ModelAccessConfigureParams as ProtocolModelAccessConfigureParams,
  ModelAccessStatus as ProtocolModelAccessStatus
} from '../../shared/kernel-protocol'
import type { AuthStorage, ModelRegistry } from '../omp/model-access'

export type ModelAccessStatus = ProtocolModelAccessStatus
export type ModelAccessConfigureParams = ProtocolModelAccessConfigureParams

export type ModelAccessProviderStatus = Readonly<{
  provider: string
  status: ModelAccessStatus
  reason?: 'desktop_credential_broker_not_connected'
}>

export type ModelAccessChangeListener = () => void

/** Runtime boundary consumed by kernel-owned sessions, independent of credential location. */
export interface KernelModelAccess {
  readonly authStorage: AuthStorage
  readonly modelRegistry: ModelRegistry
  /** Refreshes the authoritative catalog without introducing network discovery. */
  refreshCatalog(): Promise<void>
  catalog(): readonly KernelModelDescriptor[]
  status(): readonly ModelAccessProviderStatus[]
  onChange(listener: ModelAccessChangeListener): () => void
  configure?(params: ModelAccessConfigureParams): void | Promise<void>
  /** The Cursor route of the latest configuration; each desktop connection brings a new one. */
  cursorBaseUrl?(): string | undefined
  controllerAttached?(): void
  controllerDetached?(): void
  cancelWaiting?(reason?: unknown): void
  close(): void | Promise<void>
}
