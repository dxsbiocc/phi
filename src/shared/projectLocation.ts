export type ProjectLocation =
  | { kind: 'local'; path: string; realPath: string }
  | { kind: 'ssh'; hostProfileId: string; remoteRoot: string; canonicalRoot: string }

export type RemoteProjectReachability =
  | 'unchecked'
  | 'connecting'
  | 'reachable'
  | 'offline'
  | 'authentication_failed'
  | 'identity_failed'
  | 'permission_failed'
  | 'configuration_failed'

export interface RemoteProjectConnectionState {
  phase: RemoteProjectReachability
  message?: string
  suggestion?: string
  checkedAt?: string
}

export interface RemoteProjectConnectionChange {
  projectId: string
  state: RemoteProjectConnectionState
}

export interface RemoteProjectConnectionRetryRequest {
  sessionId: string
  projectId: string
}

export interface RemoteProjectCreateInput {
  name: string
  hostProfileId: string
  remoteRoot: string
  permissionMode: 'ask' | 'auto' | 'full'
}
