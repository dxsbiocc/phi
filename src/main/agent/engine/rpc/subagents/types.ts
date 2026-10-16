import type { PhiAgentDefinition, PhiAgentThinkingLevel } from '../../../agents/definition'
import type { ModelGatewayModelRef, SafeModelDescriptor } from '../../model-gateway-types'
import type { PhiExtensionFile } from '../extension-deployment/types'
import type {
  RpcChildEnvironmentExecution,
  RpcChildHostResource
} from '../../phi-extension/lib/rpc-child-resources'
export type {
  RpcChildResourceCatalog,
  RpcChildEnvironmentExecution
} from '../../phi-extension/lib/rpc-child-resources'

/** Main snapshots contain real selected content; publication later replaces Markdown with hash refs. */
export interface RpcAgentResourceCatalogInput {
  readonly hostTools: readonly Omit<RpcChildHostResource, 'schemaSha256'>[]
  readonly skills: readonly {
    readonly name: string
    readonly description: string
    readonly markdown: string
  }[]
}

/** Verified child lifecycle record, distinct from a live execution capability. */
export interface RpcChildRunSnapshot {
  readonly id: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly generation: number
  readonly parentRunId: string
  readonly parentToolCallId: string
  readonly nativeId: string
  readonly childSessionFile: string
  readonly childOmpSessionId?: string
  readonly agent: string
  readonly background: boolean
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  readonly verified: boolean
  readonly startedAt: number
  readonly completedAt?: number
}

/** Trusted desktop binding, never inferred from agent frontmatter or a remote URL. */
export interface RpcAgentServerBinding {
  readonly serverId: string
  readonly serverIdentitySha256: string
  readonly projectId: string
  readonly projectRoot: string
}

/** A ready environment already resolved by the desktop environment service. */
export interface RpcAgentEnvironmentDescriptor {
  readonly execution?: RpcChildEnvironmentExecution
  readonly ref: string
  readonly pluginId?: string
  readonly environmentId: string
  readonly lockSha256: string
  readonly status: 'ready'
  readonly binding: RpcAgentServerBinding
}

export interface RpcAgentToolDescriptor {
  readonly name: string
  readonly site: 'native' | 'host'
}

export interface RpcAgentDefinitionProfile {
  readonly definitionHash: string
  /** Immutable Phi catalogue name used for trusted resource ownership. */
  readonly phiName: string
  /** Optional user-facing project alias; never grants resource authority. */
  readonly displayName?: string
  readonly nativeName: string
  readonly blocking: boolean
  readonly tools: readonly RpcAgentToolDescriptor[]
  readonly skills: readonly string[]
  readonly model: ModelGatewayModelRef
  readonly thinkingLevel?: PhiAgentThinkingLevel
  readonly environment?: RpcAgentEnvironmentDescriptor
}

export interface RpcAgentDefinitionManifest {
  readonly schema: 1
  readonly binding: RpcAgentServerBinding
  readonly entries: readonly RpcAgentDefinitionProfile[]
}

export interface RpcAgentDefinitionCompilation {
  /** Relative agents/*.md and the sidecar; root owns private atomic publication. */
  readonly files: readonly PhiExtensionFile[]
  readonly manifest: RpcAgentDefinitionManifest
  readonly manifestHash: string
  readonly warnings: readonly string[]
}

export interface CompileRpcAgentDefinitionsOptions {
  readonly definitions: readonly PhiAgentDefinition[]
  readonly binding: RpcAgentServerBinding
  readonly availableModels: readonly SafeModelDescriptor[]
  readonly parentModel: ModelGatewayModelRef
  readonly parentThinkingLevel?: PhiAgentThinkingLevel
  readonly availableTools: readonly RpcAgentToolDescriptor[]
  readonly availableSkills: readonly string[]
  /** Source Phi name -> stable project/session publication name. */
  readonly publishedNames?: Readonly<Record<string, string>>
  /** Receives a detached safe snapshot, without desktop file paths or plugin objects. */
  readonly resolveEnvironment?: (
    agent: Readonly<Pick<PhiAgentDefinition, 'name' | 'environment' | 'pluginId'>>
  ) => RpcAgentEnvironmentDescriptor | Promise<RpcAgentEnvironmentDescriptor>
}
